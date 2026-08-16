/** Shared domain types used across watcher subsystems. */
import type { EventType, LinearTeamConfig } from "orchestrator-config";

export type {
  EventType,
  InstanceConfig,
  LinearTeamConfig,
  OrchestratorConfig,
  ReviewCommentConfig,
  SlackConfig,
  StatusHookConfig,
  StatusHookContext,
  StatusHookHelpers,
} from "orchestrator-config";

export interface SnapshotRow {
  issue_identifier?: string;
  issueIdentifier?: string;
  issue_url?: string;
  state?: string;
  error?: string;
  workspace_path?: string;
  started_at?: string;
  blocked_at?: string;
  last_event?: string;
  last_message?: string;
  last_event_at?: string;
  attempt?: number;
  due_at?: string;
}

export interface TaskActivity {
  message: string;
  changedFiles: string[];
  changedFileCount: number;
  additions: number;
  deletions: number;
}

export interface Snapshot {
  running: SnapshotRow[];
  retrying: SnapshotRow[];
  blocked: SnapshotRow[];
}

export type SnapshotsByService = Record<string, Snapshot | undefined>;

export interface ResolvedLinearTeamConfig extends LinearTeamConfig {
  statuses: string[];
}

export interface ServiceDefinition {
  name: string;
  url: string;
  linearTeam: string;
  activeStates?: string[];
  terminalStates?: string[];
}

export interface PullRequest {
  url: string;
  number?: number | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  isDraft?: boolean | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  baseRefName?: string | null;
  repository?: string | null;
  labels?: string[];
  reactions?: GitHubReaction[];
  latestReviewCommentAt?: string | null;
}

export const GITHUB_REACTIONS = [
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
] as const;

export type GitHubReaction = (typeof GITHUB_REACTIONS)[number];

export interface RelatedIssue {
  identifier: string;
  title: string | null;
  url: string | null;
  state?: string | null;
  stateType?: string | null;
}

export interface WatcherEvent {
  type: EventType;
  service: string;
  linearIssueId?: string;
  issueIdentifier: string;
  issueUrl?: string;
  state?: string;
  workspacePath?: string;
  startedAt?: string;
  blockedAt?: string;
  lastEvent?: string;
  lastEventAt?: string;
  attempt?: number;
  dueAt?: string;
  error?: string;
  issueTitle?: string | null;
  creatorName?: string | null;
  creatorEmail?: string | null;
  creatorMention?: string | null;
  resolvedState?: string | null;
  resolvedStateType?: string | null;
  pullRequest?: PullRequest;
  relatedIssues?: RelatedIssue[];
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
