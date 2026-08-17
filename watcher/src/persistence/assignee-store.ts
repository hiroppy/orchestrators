import { and, asc, eq } from "drizzle-orm";

import type { WatcherDatabase } from "./database.ts";
import { taskAssignees } from "./schema.ts";

export function assignTask(
  db: WatcherDatabase,
  taskId: string,
  slackUserId: string,
  now = new Date(),
): boolean {
  const result = db
    .insert(taskAssignees)
    .values({ taskId, slackUserId, createdAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

export function unassignTask(db: WatcherDatabase, taskId: string, slackUserId: string): boolean {
  const result = db
    .delete(taskAssignees)
    .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.slackUserId, slackUserId)))
    .run();
  return result.changes > 0;
}

export function getTaskAssignees(db: WatcherDatabase, taskId: string): string[] {
  return db
    .select({ slackUserId: taskAssignees.slackUserId })
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, taskId))
    .orderBy(asc(taskAssignees.createdAt), asc(taskAssignees.slackUserId))
    .all()
    .map(({ slackUserId }) =>
      slackUserId.startsWith("!subteam^") ? `<${slackUserId}>` : `<@${slackUserId}>`,
    );
}
