import type { PullRequest } from "./github.ts";

export interface TaskActivity {
  message: string;
  changedFiles: string[];
  changedFileCount: number;
  additions: number;
  deletions: number;
}

export interface Task {
  id: string;
  serviceName: string;
  issueIdentifier: string;
  title: string;
  status: string;
  linearStateType?: string;
  linkUrl?: string;
  pullRequest?: PullRequest;
  parentChannelId?: string;
  parentMessageTs?: string;
  lastRenderedSummary?: string;
  lastEventAt?: string;
  currentActivity?: TaskActivity;
  activityPublishedAt?: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: string;
  actor?: string;
  statusEventType?: "automatic" | "manual";
  statusEventLabel?: string;
  statusEventError?: string;
  statusEventKey?: string;
  fromStatus?: string;
  toStatus?: string;
  body?: string;
  slackThreadTs?: string;
  createdAt: string;
}
