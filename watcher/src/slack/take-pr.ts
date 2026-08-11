import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { KnownBlock } from "@slack/web-api";
import { parse as parseYaml } from "yaml";

import {
  createLinearTakePrIssue,
  type CreateLinearTakePrIssueInput,
  type CreatedLinearIssue,
} from "../integrations/linear.ts";
import { findPullRequestByUrl, linkPullRequestToLinearIssue } from "../integrations/github.ts";
import type { PullRequest, ResolvedLinearTeamConfig, ServiceDefinition } from "../domain/types.ts";
import type { WatcherStore } from "../persistence/store.ts";
import type { SlackClient } from "./client-types.ts";
import { postSlackOperationError } from "./errors.ts";
import { escapeSlack, escapeSlackLinkLabel } from "./view-formatting.ts";

export const TAKE_PR_SERVICE_ACTION_ID = "take_pr_service_select";
export const TAKE_PR_CONFIRM_ACTION_ID = "take_pr_confirm";
const MAX_STATIC_SELECT_OPTIONS = 100;
const MAX_OPTION_TEXT_LENGTH = 75;
const MAX_LINEAR_ISSUE_TITLE_LENGTH = 255;

export interface TakePrOptions {
  authorizedChannelId: string;
  services: ServiceDefinition[];
  linearTeams: Record<string, ResolvedLinearTeamConfig>;
  symphoniesDirectory: string;
  findPullRequest?: (url: string) => Promise<PullRequest | null>;
  createLinearIssue?: (
    input: CreateLinearTakePrIssueInput,
    options: { apiKey: string },
  ) => Promise<CreatedLinearIssue>;
  linkPullRequest?: (url: string, issueIdentifier: string) => Promise<void>;
  createRequestId?: (event: Pick<TakePrMentionEvent, "channel" | "ts">) => string;
  readWorkflow?: (path: string) => Promise<string>;
}

export interface TakePrMentionEvent {
  channel: string;
  ts: string;
  user?: string;
  threadTs?: string;
}

export async function handleTakePrMention(
  event: TakePrMentionEvent,
  args: string[],
  client: Pick<SlackClient, "chat">,
  logger: { error(error: unknown): void },
  store: WatcherStore,
  options: TakePrOptions,
): Promise<void> {
  const threadTs = event.threadTs ?? event.ts;
  if (event.channel !== options.authorizedChannelId) {
    await postTakePrError(
      client,
      event.channel,
      threadTs,
      "The take-pr command is only allowed in the configured watcher channel.",
    );
    return;
  }
  const pullRequestUrl = args.length === 1 ? parseGitHubPullRequestUrl(args[0]) : undefined;
  if (!pullRequestUrl) {
    await postTakePrError(
      client,
      event.channel,
      threadTs,
      "Usage: `@Orchestrators take-pr <GitHub PR URL>`",
    );
    return;
  }
  if (options.services.length === 0) {
    await postTakePrError(client, event.channel, threadTs, "No enabled services are configured.");
    return;
  }
  if (options.services.length > MAX_STATIC_SELECT_OPTIONS) {
    await postTakePrError(
      client,
      event.channel,
      threadTs,
      `Cannot show more than ${MAX_STATIC_SELECT_OPTIONS} enabled services.`,
    );
    return;
  }

  let pullRequest: PullRequest | null;
  try {
    pullRequest = await (options.findPullRequest ?? findPullRequestByUrl)(pullRequestUrl);
  } catch (error) {
    logger.error(error);
    pullRequest = null;
  }
  if (!hasCompletePullRequestMetadata(pullRequest)) {
    await postTakePrError(
      client,
      event.channel,
      threadTs,
      "Could not load the GitHub pull request. Check that the URL points to an accessible PR.",
    );
    return;
  }
  if (pullRequest.state.toUpperCase() !== "OPEN") {
    await postTakePrError(client, event.channel, threadTs, "The GitHub pull request must be open.");
    return;
  }
  const requestId = (options.createRequestId ?? stableTakePrRequestId)(event);
  store.createPendingTakePrRequest({
    id: requestId,
    pullRequestUrl,
    repository: pullRequest.repository,
    pullRequestTitle: pullRequest.title,
    pullRequestBody: pullRequest.body ?? "",
    headBranch: pullRequest.headRefName,
    baseBranch: pullRequest.baseRefName,
    channelId: event.channel,
    threadTs,
    requesterSlackUserId: event.user,
  });

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: `Choose a service for ${escapeSlack(pullRequest.repository)}#${pullRequest.number ?? "?"}: ${escapeSlack(singleLine(pullRequest.title))}`,
    blocks: buildTakePrServiceSelectionBlocks(requestId, pullRequest, options.services),
    client_msg_id: stableSlackClientMessageId("selection", requestId),
    unfurl_links: false,
    unfurl_media: false,
  });
}

export async function handleTakePrAction(
  { ack, action, body, client, logger }: TakePrActionArguments,
  store: WatcherStore,
  options: TakePrOptions,
): Promise<void> {
  await ack();

  const selection = takePrSelectionFromAction(action, body);
  if (!selection) {
    const requestId = takePrConfirmRequestId(action);
    const request = requestId ? store.getPendingTakePrRequest(requestId) : undefined;
    if (request) {
      await postTakePrError(
        client,
        request.channelId,
        request.threadTs,
        "Select a service before confirming take-pr.",
      );
      return;
    }
    const source = requestId ? takePrSourceFromActionBody(body) : undefined;
    if (source) {
      await postTakePrError(
        client,
        source.channelId,
        source.threadTs,
        "This take-pr selector has expired. Run the take-pr command again.",
      );
      return;
    }
    logger.error(new Error("take-pr action did not include a valid pending request ID."));
    return;
  }

  const request = store.getPendingTakePrRequest(selection.requestId);
  if (!request) {
    logger.error(new Error(`Pending take-pr request not found: ${selection.requestId}`));
    const source = takePrSourceFromActionBody(body);
    if (source) {
      await postTakePrError(
        client,
        source.channelId,
        source.threadTs,
        "This take-pr selector has expired. Run the take-pr command again.",
      );
    }
    return;
  }
  const actor = slackUserIdFromActionBody(body);
  if (!actor || actor !== request.requesterSlackUserId) {
    await postTakePrError(
      client,
      request.channelId,
      request.threadTs,
      "Only the user who ran take-pr can select the service.",
    );
    return;
  }

  const service = options.services[selection.serviceIndex];
  if (!service) {
    await postTakePrError(
      client,
      request.channelId,
      request.threadTs,
      `Service is not enabled: ${selection.serviceIndex}`,
    );
    return;
  }
  const claimed = store.takePendingTakePrRequest(request.id);
  if (!claimed) return;

  try {
    const validation = await revalidatePullRequest(claimed.pullRequestUrl, options, logger);
    if ("error" in validation) {
      store.restorePendingTakePrRequest(claimed);
      await postTakePrError(client, claimed.channelId, claimed.threadTs, validation.error);
      return;
    }
    const issueRequest = {
      ...claimed,
      pullRequestUrl: validation.pullRequest.url,
      repository: validation.pullRequest.repository,
      pullRequestTitle: validation.pullRequest.title,
      pullRequestBody: validation.pullRequest.body ?? "",
      headBranch: validation.pullRequest.headRefName,
      baseBranch: validation.pullRequest.baseRefName,
    };
    const linearTeam = options.linearTeams[service.linearTeam];
    if (!linearTeam?.apiKey || !linearTeam.teamId) {
      throw new Error(`Linear configuration is incomplete for service ${service.name}.`);
    }
    const workflowPath = workflowPathFor(options.symphoniesDirectory, service.name);
    const workflow = await (options.readWorkflow ?? readWorkflow)(workflowPath);
    const projectSlug = projectSlugFromWorkflow(workflow);
    if (!projectSlug) {
      throw new Error(
        `WORKFLOW.md does not define tracker.provider.project_slug for ${service.name}.`,
      );
    }

    const permalinkResponse = await client.chat.getPermalink({
      channel: claimed.channelId,
      message_ts: claimed.threadTs,
    });
    if (!permalinkResponse.permalink) {
      throw new Error("Could not get the Slack parent message URL.");
    }

    const issue = await (options.createLinearIssue ?? createLinearTakePrIssue)(
      buildLinearIssueInput(
        issueRequest,
        linearTeam.teamId,
        projectSlug,
        permalinkResponse.permalink,
      ),
      { apiKey: linearTeam.apiKey },
    );
    await (options.linkPullRequest ?? linkPullRequestToLinearIssue)(
      issueRequest.pullRequestUrl,
      issue.identifier,
    );
    await client.chat.postMessage({
      channel: claimed.channelId,
      thread_ts: claimed.threadTs,
      text: [
        `Created <${issue.url}|${issue.identifier}> for service \`${service.name}\`.`,
        `Existing PR: <${issueRequest.pullRequestUrl}|${escapeSlackLinkLabel(`${issueRequest.repository}: ${singleLine(issueRequest.pullRequestTitle)}`)}>`,
      ].join("\n"),
      client_msg_id: stableSlackClientMessageId("success", claimed.id),
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    store.restorePendingTakePrRequest(claimed);
    logger.error(error);
    await postTakePrError(client, claimed.channelId, claimed.threadTs, takePrErrorMessage(error));
  }
}

export function parseGitHubPullRequestUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const slackLink = value.match(/^<([^|>]+)(?:\|[^>]*)?>$/)?.[1] ?? value;
  try {
    const url = new URL(slackLink);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(url.pathname)
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function projectSlugFromWorkflow(workflow: string): string | undefined {
  const frontmatter = workflow.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return undefined;

  try {
    const document = parseYaml(frontmatter) as {
      tracker?: { provider?: { project_slug?: unknown } };
    } | null;
    const projectSlug = document?.tracker?.provider?.project_slug;
    if (typeof projectSlug !== "string") return undefined;
    return projectSlug.trim() || undefined;
  } catch {
    return undefined;
  }
}

function buildTakePrServiceSelectionBlocks(
  requestId: string,
  pullRequest: CompletePullRequest,
  services: ServiceDefinition[],
): KnownBlock[] {
  const options = services.map(({ name }, index) => ({
    text: { type: "plain_text" as const, text: name.slice(0, MAX_OPTION_TEXT_LENGTH) },
    value: `${requestId}:i${index}`,
  }));
  const repositoryName = pullRequest.repository.split("/").at(-1)?.toLowerCase();
  const inferredServiceIndex = services.findIndex(
    ({ name }) => name.toLowerCase() === repositoryName,
  );
  const initialOption = options[inferredServiceIndex];

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Take existing PR*\n<${pullRequest.url}|${escapeSlackLinkLabel(`${pullRequest.repository}#${pullRequest.number ?? "?"}: ${singleLine(pullRequest.title)}`)}>`,
      },
    },
    {
      type: "actions",
      block_id: `take-pr:${requestId}`,
      elements: [
        {
          type: "static_select",
          action_id: TAKE_PR_SERVICE_ACTION_ID,
          placeholder: { type: "plain_text", text: "Service" },
          options,
          ...(initialOption ? { initial_option: initialOption } : {}),
        },
        {
          type: "button",
          action_id: TAKE_PR_CONFIRM_ACTION_ID,
          text: { type: "plain_text", text: "OK" },
          style: "primary",
          value: requestId,
        },
      ],
    },
  ];
}

function hasCompletePullRequestMetadata(
  pullRequest: PullRequest | null,
): pullRequest is CompletePullRequest {
  return Boolean(
    pullRequest?.url &&
    pullRequest.title &&
    pullRequest.repository &&
    pullRequest.headRefName &&
    pullRequest.baseRefName &&
    pullRequest.state,
  );
}

function takePrSelectionFromAction(
  action: unknown,
  body: unknown,
): { requestId: string; serviceIndex: number } | undefined {
  const requestId = takePrConfirmRequestId(action);
  if (!requestId) return undefined;
  const value = selectedValueFromActionBody(body, requestId);
  if (!value) return undefined;
  const selection = value.match(/^([A-Za-z0-9_-]{8,32}):i(0|[1-9]\d*)$/);
  return selection?.[1] === requestId
    ? { requestId: selection[1], serviceIndex: Number(selection[2]) }
    : undefined;
}

function takePrConfirmRequestId(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const value = (action as { value?: unknown }).value;
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,32}$/.test(value) ? value : undefined;
}

function takePrSourceFromActionBody(
  body: unknown,
): { channelId: string; threadTs: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const actionBody = body as {
    channel?: { id?: unknown };
    message?: { thread_ts?: unknown; ts?: unknown };
  };
  const channelId = actionBody.channel?.id;
  const threadTs = actionBody.message?.thread_ts ?? actionBody.message?.ts;
  return typeof channelId === "string" && typeof threadTs === "string"
    ? { channelId, threadTs }
    : undefined;
}

function selectedValueFromActionBody(body: unknown, requestId: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const values = (body as { state?: { values?: unknown } }).state?.values;
  if (!values || typeof values !== "object") return undefined;
  const block = (values as Record<string, unknown>)[`take-pr:${requestId}`];
  if (!block || typeof block !== "object") return undefined;
  const select = (block as Record<string, unknown>)[TAKE_PR_SERVICE_ACTION_ID];
  if (!select || typeof select !== "object") return undefined;
  const value = (select as { selected_option?: { value?: unknown } }).selected_option?.value;
  return typeof value === "string" && value.startsWith(`${requestId}:`) ? value : undefined;
}

function workflowPathFor(symphoniesDirectory: string, serviceName: string): string {
  const root = resolve(symphoniesDirectory);
  const workflowPath = resolve(root, serviceName, "elixir/WORKFLOW.md");
  const pathFromRoot = relative(root, workflowPath);
  if (pathFromRoot.startsWith("..") || pathFromRoot === "" || pathFromRoot.startsWith("/")) {
    throw new Error(`Service name cannot resolve outside the symphonies directory: ${serviceName}`);
  }
  return workflowPath;
}

async function readWorkflow(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`WORKFLOW.md could not be read for ${path.split("/").at(-3) ?? "service"}.`);
  }
}

function buildLinearIssueInput(
  request: {
    id: string;
    pullRequestUrl: string;
    repository: string;
    pullRequestTitle: string;
    pullRequestBody: string;
    headBranch: string;
    baseBranch: string;
  },
  teamId: string,
  projectSlug: string,
  slackMessageUrl: string,
): CreateLinearTakePrIssueInput {
  const title = `[take-pr] ${singleLine(request.pullRequestTitle)}`.slice(
    0,
    MAX_LINEAR_ISSUE_TITLE_LENGTH,
  );
  const pullRequestDescription = request.pullRequestBody.trim() || "No description provided.";
  const description = [
    "## Existing pull request",
    "",
    request.pullRequestUrl,
    "",
    "## PR Description",
    "",
    pullRequestDescription,
    "",
    "## Requested from",
    "",
    slackMessageUrl,
  ].join("\n");
  return {
    idempotencyKey: [request.pullRequestUrl.replace(/\/$/, ""), teamId].join(":"),
    teamId,
    projectSlug,
    title,
    description,
    pullRequestTitle: singleLine(request.pullRequestTitle),
    pullRequestUrl: request.pullRequestUrl,
  };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function revalidatePullRequest(
  pullRequestUrl: string,
  options: TakePrOptions,
  logger: { error(error: unknown): void },
): Promise<{ pullRequest: CompletePullRequest } | { error: string }> {
  let pullRequest: PullRequest | null;
  try {
    pullRequest = await (options.findPullRequest ?? findPullRequestByUrl)(pullRequestUrl);
  } catch (error) {
    logger.error(error);
    pullRequest = null;
  }
  if (!hasCompletePullRequestMetadata(pullRequest)) {
    return { error: "Could not revalidate the GitHub pull request. No Linear issue was created." };
  }
  if (pullRequest.state.toUpperCase() !== "OPEN") {
    return { error: "The GitHub pull request is no longer open. No Linear issue was created." };
  }
  return { pullRequest };
}

function stableSlackClientMessageId(kind: "selection" | "success", requestId: string): string {
  const hex = createHash("sha256").update(`take-pr:${kind}:${requestId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function stableTakePrRequestId(event: Pick<TakePrMentionEvent, "channel" | "ts">): string {
  return `takepr_${createHash("sha256").update(`${event.channel}:${event.ts}`).digest("hex").slice(0, 20)}`;
}

async function postTakePrError(
  client: Pick<SlackClient, "chat">,
  channel: string,
  threadTs: string,
  reason: string,
): Promise<void> {
  await postSlackOperationError(client, { channel, threadTs }, reason);
}

function takePrErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to create a Linear issue for the PR.";
}

type CompletePullRequest = PullRequest & {
  title: string;
  repository: string;
  headRefName: string;
  baseRefName: string;
  state: string;
};

interface TakePrActionArguments {
  ack: () => Promise<unknown>;
  action: unknown;
  body: unknown;
  client: Pick<SlackClient, "chat">;
  logger: { error(error: unknown): void };
}

function slackUserIdFromActionBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const id = (body as { user?: { id?: unknown } }).user?.id;
  return typeof id === "string" ? id : undefined;
}
