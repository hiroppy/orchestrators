import type {
  CreateLinearTakePrIssueInput,
  CreatedLinearIssue,
} from "../../integrations/linear/take-pr.ts";
import type { PullRequest } from "../../domain/github.ts";
import type { ResolvedLinearTeamConfig, ServiceDefinition } from "../../domain/service.ts";

export const TAKE_PR_SERVICE_ACTION_ID = "take_pr_service_select";
export const TAKE_PR_CONFIRM_ACTION_ID = "take_pr_confirm";
export const MAX_STATIC_SELECT_OPTIONS = 100;
export const MAX_OPTION_TEXT_LENGTH = 75;

export interface TakePrOptions {
  authorizedChannelId: string;
  services: ServiceDefinition[];
  linearTeams: Record<string, ResolvedLinearTeamConfig>;
  symphoniesDirectory: string;
  defaultAssignees?: string[];
  findPullRequest?: (url: string) => Promise<PullRequest | null>;
  createLinearIssue?: (
    input: CreateLinearTakePrIssueInput,
    options: { apiKey: string },
  ) => Promise<CreatedLinearIssue>;
  createRequestId?: (event: Pick<TakePrMentionEvent, "channel" | "ts">) => string;
  readWorkflow?: (path: string) => Promise<string>;
}

export interface TakePrMentionEvent {
  channel: string;
  ts: string;
  user?: string;
  threadTs?: string;
}

export type CompletePullRequest = PullRequest & {
  title: string;
  repository: string;
  headRefName: string;
  baseRefName: string;
  state: string;
};
