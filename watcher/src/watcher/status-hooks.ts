import type { ChatPostMessageArguments } from "@slack/web-api";

import type { ResolvedStatusHookConfig } from "../config/runtime.ts";
import type { PullRequest, StatusHookContext, StatusHookHelpers, Task } from "../domain/types.ts";

export type { StatusHookContext } from "../domain/types.ts";

export interface StatusHookResult {
  output?: string;
  error?: unknown;
}

interface StatusHookSlackClient {
  chat: {
    postMessage(args: ChatPostMessageArguments): Promise<unknown>;
  };
}

export async function dispatchStatusHooks({
  hooks,
  task,
  fromStatus,
  toStatus,
  pullRequest,
  slackClient,
  watcherChannelId,
}: {
  hooks: ResolvedStatusHookConfig[];
  task: Task;
  fromStatus: string;
  toStatus: string;
  pullRequest?: PullRequest;
  slackClient: StatusHookSlackClient;
  watcherChannelId: string;
}): Promise<void> {
  if (!task.parentChannelId || !task.parentMessageTs || hooks.length === 0) return;

  const results = await runStatusHooks(
    hooks,
    {
      event: "issue.status_changed",
      service: task.serviceName,
      issue: { identifier: task.issueIdentifier, url: task.linkUrl, title: task.title },
      transition: { from: fromStatus, to: toStatus },
      pullRequest: pullRequest ?? task.pullRequest,
    },
    {
      slack: {
        postMessage: async (message) => {
          await slackClient.chat.postMessage({ ...message, channel: watcherChannelId });
        },
        postThreadMessage: async (message) => {
          await slackClient.chat.postMessage({
            ...message,
            channel: task.parentChannelId!,
            thread_ts: task.parentMessageTs!,
          });
        },
      },
    },
  );

  for (const result of results) {
    if (result.error) {
      console.error(`Status hook failed for ${task.issueIdentifier}:`, result.error);
    } else if (result.output) {
      try {
        await slackClient.chat.postMessage({
          channel: task.parentChannelId,
          thread_ts: task.parentMessageTs,
          text: result.output,
        });
      } catch (error) {
        console.error(`Failed to post status hook output for ${task.issueIdentifier}:`, error);
      }
    }
  }
}

export async function runStatusHooks(
  hooks: ResolvedStatusHookConfig[],
  context: StatusHookContext,
  helpers: StatusHookHelpers,
): Promise<StatusHookResult[]> {
  const matchingHooks = hooks.filter(
    ({ status }) => normalizeStatus(status) === normalizeStatus(context.transition.to),
  );

  return Promise.all(
    matchingHooks.map(async ({ run }) => {
      try {
        const value = await run(context, helpers);
        const output = typeof value === "string" ? value.trim() : "";
        return output ? { output } : {};
      } catch (error) {
        return { error };
      }
    }),
  );
}

function normalizeStatus(status: string): string {
  return status.trim().toLocaleLowerCase();
}
