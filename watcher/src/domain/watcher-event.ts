import type { EventType } from "orchestrator-config";

import type { PullRequest } from "./github.ts";
import type { RelatedIssue } from "./linear.ts";

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
