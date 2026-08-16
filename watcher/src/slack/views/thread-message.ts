import type { WatcherEvent } from "../../domain/watcher-event.ts";
import { normalizeStatus } from "../../domain/status.ts";
import { EVENT_LABELS } from "./help.ts";
import { escapeExceptLinks, escapeSlack, isPresent } from "../view-formatting.ts";
import {
  buildFieldSections,
  buildTextSection,
  compactEventDetails,
  formatAssignees,
  formatError,
  notificationLabels,
  parentEventLabel,
  truncateThreadBody,
} from "./shared.ts";

export interface ThreadMessageContext {
  fromStatus?: string;
  toStatus?: string;
  assignees?: string[];
}

export function buildThreadMessageBlocks(
  event: WatcherEvent,
  context: ThreadMessageContext = {},
): Array<Record<string, unknown>> {
  const transition = statusTransitionDetails(event, context);
  const headline = transition?.headline ?? `*${EVENT_LABELS[event.type]}*`;
  const primaryFields = [
    `*Event*\n${escapeSlack(parentEventLabel(event))}`,
    context.assignees?.length ? formatAssignees(context.assignees) : null,
  ].filter(isPresent);
  const errorFields = [event.error ? `*Error*\n${formatError(event.error)}` : null].filter(
    isPresent,
  );
  return [buildTextSection(headline), ...buildFieldSections(primaryFields, errorFields)];
}

export function buildThreadMessage(
  event: WatcherEvent,
  context: ThreadMessageContext = {},
): string {
  const transition = statusTransitionDetails(event, context);
  if (transition) {
    return truncateThreadBody([transition.headline, ...transition.details].join("\n"));
  }

  const details = [
    `*${escapeSlack(EVENT_LABELS[event.type])}*`,
    ...notificationLabels(context.assignees),
    ...[
      event.error ? `Error: ${event.error}` : null,
      event.attempt ? `Attempt: ${event.attempt}` : null,
    ]
      .filter(isPresent)
      .map(escapeExceptLinks),
  ].filter(isPresent);
  const body = details.join(" | ");

  return truncateThreadBody(body);
}

function statusTransitionDetails(
  event: WatcherEvent,
  context: ThreadMessageContext,
): { headline: string; details: string[] } | undefined {
  const { fromStatus, toStatus } = context;
  if (!fromStatus || !toStatus || normalizeStatus(fromStatus) === normalizeStatus(toStatus)) {
    return undefined;
  }

  const details = [
    [`Event: ${escapeSlack(EVENT_LABELS[event.type])}`, ...notificationLabels(context.assignees)]
      .filter(isPresent)
      .join(" | "),
    compactEventDetails(event, false).join(" | "),
  ].filter((line) => line.length > 0);

  return {
    headline: `*${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}*`,
    details,
  };
}

export function buildStatusChangedMessage(
  actorDisplayName: string,
  fromStatus: string,
  toStatus: string,
): string {
  return `*${escapeSlack(fromStatus)}* → *${escapeSlack(toStatus)}* by ${escapeSlack(
    actorDisplayName,
  )}`;
}
