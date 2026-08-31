import type { ChatPostMessageArguments } from "@slack/web-api";

import type { ResolvedInReviewReminderConfig } from "../config/runtime-types.ts";
import { normalizeStatus } from "../domain/status.ts";
import type { Task } from "../domain/task.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { escapeSlack, escapeSlackLinkLabel } from "../slack/view-formatting.ts";

const IN_REVIEW_REMINDER_SCAN_EVENT = "in_review_reminder_scan";
const IN_REVIEW_REMINDER_NOTIFIED_EVENT = "in_review_reminder_notified";
const DAY_MS = 24 * 60 * 60 * 1_000;

interface ReminderSlackClient {
  chat: {
    postMessage(args: ChatPostMessageArguments): Promise<unknown>;
  };
}

export async function sendInReviewReminder({
  store,
  slackClient,
  channelId,
  config,
  now = new Date(),
}: {
  store: WatcherStore;
  slackClient: ReminderSlackClient;
  channelId: string;
  config: ResolvedInReviewReminderConfig;
  now?: Date;
}): Promise<void> {
  const schedule = localSchedule(now, config.timeZone);
  if (schedule.minutes < timeToMinutes(config.postAt)) return;

  const tasks = store.getTasksForLinearSync(new Set(), new Map(), true);
  if (store.hasEventOfType(IN_REVIEW_REMINDER_SCAN_EVENT, schedule.date)) {
    return;
  }

  const cutoff = now.getTime() - config.afterDays * DAY_MS;
  const staleTasks = tasks.filter((task) => isStaleInReview(store, task, config.status, cutoff));
  if (staleTasks.length > 0) {
    await slackClient.chat.postMessage({
      channel: channelId,
      text: reminderText(store, staleTasks, config.afterDays),
    });
  }

  const anchor = tasks[0];
  if (!anchor) return;
  store.addEvents([
    {
      taskId: anchor.id,
      type: IN_REVIEW_REMINDER_SCAN_EVENT,
      actor: "watcher",
      body: schedule.date,
      createdAt: now,
    },
    ...staleTasks.map((task) => ({
      taskId: task.id,
      type: IN_REVIEW_REMINDER_NOTIFIED_EVENT,
      actor: "watcher",
      body: schedule.date,
      createdAt: now,
    })),
  ]);
}

function isStaleInReview(
  store: WatcherStore,
  task: Task,
  inReviewStatus: string,
  cutoff: number,
): boolean {
  if (normalizeStatus(task.status) !== normalizeStatus(inReviewStatus)) return false;
  const transition = store.getLatestEventsByType(task.id, "status_timeline", 1)[0];
  const enteredAt =
    transition && normalizeStatus(transition.toStatus) === normalizeStatus(task.status)
      ? transition.createdAt
      : (task.createdAt ?? task.updatedAt);
  return Date.parse(enteredAt) <= cutoff;
}

function reminderText(store: WatcherStore, tasks: Task[], afterDays: number): string {
  const lines = tasks.map((task) => {
    const assignees = store.getTaskAssignees(task.id);
    const mentions = assignees.length > 0 ? assignees.join(" ") : "Unassigned";
    const label = `${task.issueIdentifier}: ${task.title}`;
    const taskLink = task.linkUrl
      ? `<${task.linkUrl}|${escapeSlackLinkLabel(label)}>`
      : escapeSlack(label);
    return `• ${taskLink} — ${mentions}`;
  });
  return [`*Tasks in In Review for ${afterDays}+ days*`, ...lines].join("\n");
}

function localSchedule(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour! * 60 + minute!;
}
