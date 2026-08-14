/** Shared domain types used across watcher subsystems. */
import type { EventType, LinearTeamConfig } from "orchestrator-config";

export type {
  EventType,
  InstanceConfig,
  LinearTeamConfig,
  NotificationsConfig,
  OrchestratorConfig,
  ReviewReactionConfig,
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
  last_event_at?: string;
  attempt?: number;
  due_at?: string;
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
}

export interface PullRequest {
  url: string;
  number?: number | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  isDraft?: boolean | null;
  reviewDecision?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  baseRefName?: string | null;
  repository?: string | null;
  labels?: string[];
  hasConfiguredReaction?: boolean;
}

export interface RelatedIssue {
  identifier: string;
  title: string | null;
  url: string | null;
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
  updatedAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: string;
  actor?: string;
  fromStatus?: string;
  toStatus?: string;
  body?: string;
  slackThreadTs?: string;
  createdAt: string;
}
