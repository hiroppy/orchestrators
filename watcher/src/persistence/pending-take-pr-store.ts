const TAKE_PR_ACTIVE_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface PendingTakePrRequest {
  id: string;
  pullRequestUrl: string;
  repository: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  headBranch: string;
  baseBranch: string;
  channelId: string;
  threadTs: string;
  requesterSlackUserId?: string;
  createdAt: string;
}

export type NewPendingTakePrRequest = Omit<PendingTakePrRequest, "createdAt">;

export class PendingTakePrStore {
  private readonly requests = new Map<string, PendingTakePrRequest>();

  create(request: NewPendingTakePrRequest, now = new Date()): PendingTakePrRequest {
    this.pruneExpired(now);
    const existing = this.requests.get(request.id);
    if (existing) return existing;

    const pending = { ...request, createdAt: now.toISOString() };
    this.requests.set(request.id, pending);
    return pending;
  }

  get(id: string, now = new Date()): PendingTakePrRequest | undefined {
    this.pruneExpired(now);
    return this.requests.get(id);
  }

  take(id: string, now = new Date()): PendingTakePrRequest | undefined {
    const request = this.get(id, now);
    if (request) this.requests.delete(id);
    return request;
  }

  restore(request: PendingTakePrRequest): void {
    this.requests.set(request.id, request);
  }

  private pruneExpired(now: Date): void {
    const cutoff = now.getTime() - TAKE_PR_ACTIVE_RETENTION_MS;
    for (const [id, request] of this.requests) {
      if (Date.parse(request.createdAt) <= cutoff) this.requests.delete(id);
    }
  }
}
