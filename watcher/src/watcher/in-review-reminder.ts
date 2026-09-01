import type {
  ChatGetPermalinkArguments,
  ChatGetPermalinkResponse,
  ChatPostMessageArguments,
} from "@slack/web-api";

import type { ResolvedInReviewReminderConfig } from "../config/runtime-types.ts";
import { normalizeStatus } from "../domain/status.ts";
import type { Task } from "../domain/task.ts";
import type { WatcherStore } from "../persistence/store.ts";
import { buildInReviewReminder } from "../slack/views/in-review-reminder.ts";

const IN_REVIEW_REMINDER_SCAN_EVENT = "in_review_reminder_scan";
const IN_REVIEW_REMINDER_NOTIFIED_EVENT = "in_review_reminder_notified";
const DAY_MS = 24 * 60 * 60 * 1_000;
const REMINDER_WINDOW_MINUTES = 5;
const MINUTES_PER_DAY = 24 * 60;

interface ReminderSlackClient {
  chat: {
    getPermalink(args: ChatGetPermalinkArguments): Promise<ChatGetPermalinkResponse>;
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
  const reminderDate = reminderDateInWindow(schedule, timeToMinutes(config.postAt));
  if (!reminderDate) return;

  const tasks = store.getTasksForLinearSync(new Set(), new Map(), true);
  if (store.hasEventOfType(IN_REVIEW_REMINDER_SCAN_EVENT, reminderDate)) {
    return;
  }

  const cutoff = now.getTime() - config.afterDays * DAY_MS;
  const staleTasks = tasks.filter((task) => isStaleInReview(store, task, config.status, cutoff));
  if (staleTasks.length > 0) {
    const threadLinks = await getThreadLinks(slackClient, staleTasks);
    await slackClient.chat.postMessage({
      channel: channelId,
      text: buildInReviewReminder(
        staleTasks.map((task) => ({
          issueIdentifier: task.issueIdentifier,
          title: task.title,
          assignees: store.getTaskAssignees(task.id),
          threadLink: threadLinks.get(task.id),
        })),
        config.status,
        config.afterDays,
      ),
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  const anchor = tasks[0];
  if (!anchor) return;
  store.addEvents([
    {
      taskId: anchor.id,
      type: IN_REVIEW_REMINDER_SCAN_EVENT,
      actor: "watcher",
      body: reminderDate,
      createdAt: now,
    },
    ...staleTasks.map((task) => ({
      taskId: task.id,
      type: IN_REVIEW_REMINDER_NOTIFIED_EVENT,
      actor: "watcher",
      body: reminderDate,
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
    task.statusChangedAt ??
    (transition && normalizeStatus(transition.toStatus) === normalizeStatus(task.status)
      ? transition.createdAt
      : (task.createdAt ?? task.updatedAt));
  return Date.parse(enteredAt) <= cutoff;
}

async function getThreadLinks(
  slackClient: ReminderSlackClient,
  tasks: Task[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    tasks.map(async (task): Promise<readonly [string, string] | undefined> => {
      if (!task.parentChannelId || !task.parentMessageTs) return undefined;
      const response = await slackClient.chat.getPermalink({
        channel: task.parentChannelId,
        message_ts: task.parentMessageTs,
      });
      return response.permalink ? [task.id, response.permalink] : undefined;
    }),
  );
  return new Map(entries.filter((entry) => entry !== undefined));
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

function reminderDateInWindow(
  schedule: { date: string; minutes: number },
  targetMinutes: number,
): string | undefined {
  const sameDayDifference = schedule.minutes - targetMinutes;
  const candidates = [
    { difference: sameDayDifference, dayOffset: 0 },
    { difference: sameDayDifference + MINUTES_PER_DAY, dayOffset: -1 },
    { difference: sameDayDifference - MINUTES_PER_DAY, dayOffset: 1 },
  ];
  const closest = candidates.reduce((current, candidate) =>
    Math.abs(candidate.difference) < Math.abs(current.difference) ? candidate : current,
  );
  if (Math.abs(closest.difference) > REMINDER_WINDOW_MINUTES) return undefined;
  return shiftDate(schedule.date, closest.dayOffset);
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
