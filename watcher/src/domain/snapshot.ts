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

export interface Snapshot {
  running: SnapshotRow[];
  retrying: SnapshotRow[];
  blocked: SnapshotRow[];
}

export type SnapshotsByService = Record<string, Snapshot | undefined>;
