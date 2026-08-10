import type { ResolvedMentionConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/types.ts";

export function notificationTargetsForWatcherEvent(
  mention: ResolvedMentionConfig | undefined,
  previousStatus: string | undefined,
  currentStatus: string,
  eventType: WatcherEvent["type"],
  creatorMention?: string,
  force = false,
  taskMentions: string[] = [],
): { creator?: string; mentions: string[] } | undefined {
  if (!notificationIsEligible(mention, previousStatus, currentStatus, eventType, force)) {
    return undefined;
  }
  const targets = [...new Set([...taskMentions, ...(mention?.targets ?? [])])];
  if (!creatorMention && targets.length === 0) return undefined;
  return { creator: creatorMention, mentions: targets };
}

export function notificationIsEligible(
  mention: ResolvedMentionConfig | undefined,
  previousStatus: string | undefined,
  currentStatus: string,
  eventType: WatcherEvent["type"],
  force = false,
): boolean {
  if (force) return true;
  if (!mention) return false;
  return (
    enteredMentionStatus(mention, previousStatus, currentStatus) ||
    mention.events.includes(eventType)
  );
}

function enteredMentionStatus(
  mention: ResolvedMentionConfig,
  previousStatus: string | undefined,
  currentStatus: string,
): boolean {
  const normalizedCurrent = normalizeStatus(currentStatus);
  return (
    mention.statuses.some((status) => normalizeStatus(status) === normalizedCurrent) &&
    normalizeStatus(previousStatus) !== normalizedCurrent
  );
}

function normalizeStatus(status?: string): string | undefined {
  return status?.trim().toLowerCase();
}
