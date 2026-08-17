import { App } from "@slack/bolt";

import type { WatcherStore } from "../persistence/store.ts";
import { handleAppMention } from "./mention-commands.ts";
import {
  registerStatusAction,
  type LinearStatusUpdater,
  type StatusTransitionEventFactory,
  type StatusTransitionHandler,
} from "./status-actions.ts";
import type { StatusSummaryContext } from "./views.ts";
import { handleThreadReply, type LinearWorkpadReplier } from "./thread-reply-handler.ts";
import {
  handleTakePrAction,
  TAKE_PR_CONFIRM_ACTION_ID,
  TAKE_PR_SERVICE_ACTION_ID,
  type TakePrOptions,
} from "./take-pr.ts";

export interface SlackAppOptions {
  botToken: string;
  appToken: string;
  updateLinearStatus: LinearStatusUpdater;
  createLinearWorkpadReply: LinearWorkpadReplier;
  store: WatcherStore;
  botUserId: string;
  createStatusTransitionEvent?: StatusTransitionEventFactory;
  onStatusTransition?: StatusTransitionHandler;
  takePr: TakePrOptions;
  statusSummary: StatusSummaryContext;
}

export function createSlackApp({
  botToken,
  appToken,
  updateLinearStatus,
  createLinearWorkpadReply,
  store,
  botUserId,
  createStatusTransitionEvent,
  onStatusTransition,
  takePr,
  statusSummary,
}: SlackAppOptions): App {
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });
  registerStatusAction(
    app,
    store,
    updateLinearStatus,
    createStatusTransitionEvent,
    onStatusTransition,
  );
  app.action(TAKE_PR_SERVICE_ACTION_ID, async ({ ack }) => {
    await ack();
  });
  app.action(TAKE_PR_CONFIRM_ACTION_ID, async (args) => {
    await handleTakePrAction(args, store, takePr);
  });
  app.event("app_mention", async (args) => {
    await handleAppMention(args, store, botUserId, takePr, statusSummary);
  });
  app.message(async (args) => {
    await handleThreadReply(args, store, createLinearWorkpadReply, botUserId);
  });
  return app;
}
