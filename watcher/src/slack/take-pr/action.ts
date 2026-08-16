import { createLinearTakePrIssue } from "../../integrations/linear/index.ts";
import { slackAssigneeIdFromMention } from "../assignee.ts";
import type { WatcherStore } from "../../persistence/store.ts";
import {
  parseWorkflowFrontmatter,
  readWorkflow,
  workflowPathFor,
} from "../../symphonies/workflow.ts";
import type { SlackClient } from "../client-types.ts";
import { escapeSlackLinkLabel } from "../view-formatting.ts";
import { TAKE_PR_SERVICE_ACTION_ID, type TakePrOptions } from "./types.ts";
import { buildLinearIssueInput, revalidatePullRequest, singleLine } from "./validation.ts";
import { postTakePrError, stableSlackClientMessageId, takePrErrorMessage } from "./utils.ts";

interface TakePrActionArguments {
  ack: () => Promise<unknown>;
  action: unknown;
  body: unknown;
  client: Pick<SlackClient, "chat">;
  logger: { error(error: unknown): void };
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
    const configuredProjectSlug =
      parseWorkflowFrontmatter(workflow)?.tracker?.provider?.project_slug;
    const projectSlug =
      typeof configuredProjectSlug === "string" ? configuredProjectSlug.trim() : "";
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

    const linearIssueInput = buildLinearIssueInput(
      issueRequest,
      linearTeam.teamId,
      projectSlug,
      permalinkResponse.permalink,
    );
    const issue = await (options.createLinearIssue ?? createLinearTakePrIssue)(linearIssueInput, {
      apiKey: linearTeam.apiKey,
    });
    const initialAssignees = [
      ...(options.defaultAssignees ?? []),
      ...(claimed.requesterSlackUserId ? [`<@${claimed.requesterSlackUserId}>`] : []),
    ];
    if (initialAssignees.length > 0) {
      const task = store.upsertTaskFromEvent({
        type: "started",
        service: service.name,
        issueIdentifier: issue.identifier,
        issueUrl: issue.url,
        issueTitle: linearIssueInput.title,
        resolvedState: "Todo",
        pullRequest: validation.pullRequest,
      });
      for (const assignee of new Set(initialAssignees)) {
        const assigneeId = slackAssigneeIdFromMention(assignee);
        if (assigneeId) store.assignTask(task.id, assigneeId);
      }
    }
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

function slackUserIdFromActionBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const id = (body as { user?: { id?: unknown } }).user?.id;
  return typeof id === "string" ? id : undefined;
}
