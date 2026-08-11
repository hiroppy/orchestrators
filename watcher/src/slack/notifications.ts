import type { ResolvedNotificationConfig } from "../config/runtime.ts";
import type { WatcherEvent } from "../domain/types.ts";

export function notificationTargetsForWatcherEvent(
  notification: ResolvedNotificationConfig | undefined,
  previousStatus: string | undefined,
  currentStatus: string,
  eventType: WatcherEvent["type"],
  assignees: string[] = [],
  force = false,
): string[] | undefined {
  if (!notificationIsEligible(notification, previousStatus, currentStatus, eventType, force)) {
    return undefined;
  }
  return assignees.length > 0 ? assignees : undefined;
}

export function notificationIsEligible(
  notification: ResolvedNotificationConfig | undefined,
  previousStatus: string | undefined,
  currentStatus: string,
  eventType: WatcherEvent["type"],
  force = false,
): boolean {
  if (force) return true;
  if (!notification) return false;
  return (
    enteredNotificationStatus(notification, previousStatus, currentStatus) ||
    notification.events.includes(eventType)
  );
}

function enteredNotificationStatus(
  notification: ResolvedNotificationConfig,
  previousStatus: string | undefined,
  currentStatus: string,
): boolean {
  const normalizedCurrent = normalizeStatus(currentStatus);
  return (
    notification.statuses.some((status) => normalizeStatus(status) === normalizedCurrent) &&
    normalizeStatus(previousStatus) !== normalizedCurrent
  );
}

function normalizeStatus(status?: string): string | undefined {
  return status?.trim().toLowerCase();
}
