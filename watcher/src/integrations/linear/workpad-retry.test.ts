import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LinearRateLimitError } from "./client.ts";
import { createLinearWorkpadReply } from "./index.ts";

describe("Linear Workpad reply recovery", () => {
  it("retries transient Linear failures", async (context) => {
    let requestCount = 0;
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      requestCount += 1;
      if (requestCount === 1) return new Response(null, { status: 429 });

      const request = JSON.parse(String(options?.body));
      return request.query.includes("IssueWorkpad")
        ? Response.json({
            data: {
              issue: {
                id: "issue-uuid",
                comments: {
                  nodes: [{ id: "active", body: "## Codex Workpad", resolvedAt: null }],
                },
              },
            },
          })
        : Response.json({
            data: { commentCreate: { success: true } },
          });
    });

    const created = await createLinearWorkpadReply("ENG-62", "Retry this reply.", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      retryDelayMs: 0,
    });

    assert.equal(created, true);
    assert.equal(requestCount, 3);
  });

  it("retries Linear GraphQL rate limits returned with HTTP 400", async (context) => {
    let mutationCount = 0;
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      if (request.query.includes("IssueWorkpad")) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              comments: {
                nodes: [
                  {
                    id: "active",
                    body: "## Codex Workpad",
                    createdAt: "2026-07-01T00:00:00Z",
                    resolvedAt: null,
                  },
                ],
              },
            },
          },
        });
      }
      if (request.query.includes("CommentById")) {
        return Response.json({ data: { comments: { nodes: [] } } });
      }

      mutationCount += 1;
      return mutationCount === 1
        ? Response.json(
            {
              errors: [
                {
                  message: "Rate limit exceeded",
                  extensions: { code: "RATELIMITED" },
                },
              ],
            },
            { status: 400 },
          )
        : Response.json({ data: { commentCreate: { success: true } } });
    });

    const created = await createLinearWorkpadReply("ENG-62", "Retry this reply.", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      retryDelayMs: 0,
    });

    assert.equal(created, true);
    assert.equal(mutationCount, 2);
  });

  it("reports an exhausted HTTP 429 response as a Linear rate limit", async (context) => {
    let requestCount = 0;
    context.mock.method(globalThis, "fetch", async () => {
      requestCount += 1;
      return new Response(null, { status: 429 });
    });

    await assert.rejects(
      createLinearWorkpadReply("ENG-62", "Retry this reply.", {
        apiKey: "lin_test",
        idempotencyKey: "C123:2.000",
        maxAttempts: 2,
        retryDelayMs: 0,
      }),
      LinearRateLimitError,
    );
    assert.equal(requestCount, 2);
  });

  it("rejects failed comment mutations", async (context) => {
    let requestCount = 0;
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      requestCount += 1;
      const request = JSON.parse(String(options?.body));
      return request.query.includes("IssueWorkpad")
        ? Response.json({
            data: {
              issue: {
                id: "issue-uuid",
                comments: {
                  nodes: [{ id: "active", body: "## Codex Workpad", resolvedAt: null }],
                },
              },
            },
          })
        : Response.json({
            data: { commentCreate: { success: false } },
          });
    });

    await assert.rejects(
      createLinearWorkpadReply("ENG-62", "Please add a test.", {
        apiKey: "lin_test",
        idempotencyKey: "C123:2.000",
      }),
      /rejected Workpad reply/,
    );
    assert.equal(requestCount, 3);
  });

  it("reconciles an ambiguously successful comment creation without resubmitting it", async (context) => {
    let createdCommentId: string | undefined;
    let mutationCount = 0;
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      if (request.query.includes("IssueWorkpad")) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              comments: {
                nodes: [{ id: "active", body: "## Codex Workpad", resolvedAt: null }],
              },
            },
          },
        });
      }
      if (request.query.includes("CommentById")) {
        return Response.json({
          data: { comments: { nodes: createdCommentId ? [{ id: createdCommentId }] : [] } },
        });
      }

      mutationCount += 1;
      createdCommentId = request.variables.id;
      throw new DOMException("Response was lost", "TimeoutError");
    });

    const created = await createLinearWorkpadReply("ENG-62", "Copy once.", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      retryDelayMs: 0,
    });

    assert.equal(created, true);
    assert.equal(mutationCount, 1);
  });

  it("reconciles an existing file reply before loading another copy", async (context) => {
    let imageLoadCount = 0;
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      if (request.query.includes("IssueWorkpad")) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              comments: {
                nodes: [{ id: "active", body: "## Codex Workpad", resolvedAt: null }],
              },
            },
          },
        });
      }
      if (request.query.includes("CommentById")) {
        return Response.json({
          data: { comments: { nodes: [{ id: request.variables.id }] } },
        });
      }
      assert.fail("No upload or comment mutation should run after reconciliation.");
    });

    const created = await createLinearWorkpadReply("ENG-62", "", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      files: [
        {
          filename: "already-copied.png",
          contentType: "image/png",
          loadData: async () => {
            imageLoadCount += 1;
            return new Uint8Array([1]).buffer;
          },
        },
      ],
    });

    assert.equal(created, true);
    assert.equal(imageLoadCount, 0);
  });

  it("retries when an interrupted mutation did not create the comment", async (context) => {
    let mutationCount = 0;
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      if (request.query.includes("IssueWorkpad")) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              comments: {
                nodes: [{ id: "active", body: "## Codex Workpad", resolvedAt: null }],
              },
            },
          },
        });
      }
      if (request.query.includes("CommentById")) {
        return Response.json({ data: { comments: { nodes: [] } } });
      }

      mutationCount += 1;
      if (mutationCount === 1) throw new DOMException("Request timed out", "TimeoutError");
      return Response.json({ data: { commentCreate: { success: true } } });
    });

    const created = await createLinearWorkpadReply("ENG-62", "Retry once.", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      retryDelayMs: 0,
    });

    assert.equal(created, true);
    assert.equal(mutationCount, 2);
  });

  it("keeps retrying the mutation when comment reconciliation also fails", async (context) => {
    let mutationCount = 0;
    let reconciliationCount = 0;
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      if (request.query.includes("IssueWorkpad")) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              comments: {
                nodes: [
                  {
                    id: "active",
                    body: "## Codex Workpad",
                    createdAt: "2026-07-01T00:00:00Z",
                    resolvedAt: null,
                  },
                ],
              },
            },
          },
        });
      }
      if (request.query.includes("CommentById")) {
        reconciliationCount += 1;
        return new Response(null, { status: 503 });
      }

      mutationCount += 1;
      if (mutationCount === 1) throw new DOMException("Request timed out", "TimeoutError");
      return Response.json({ data: { commentCreate: { success: true } } });
    });

    const created = await createLinearWorkpadReply("ENG-62", "Retry the mutation.", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    assert.equal(created, true);
    assert.equal(mutationCount, 2);
    assert.equal(reconciliationCount, 2);
  });

  it("recovers a copied reply after restart when Linear reports its stable ID as duplicate", async (context) => {
    let createdCommentId: string | undefined;
    let mutationCount = 0;
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      if (request.query.includes("IssueWorkpad")) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              comments: {
                nodes: [
                  {
                    id: "active",
                    body: "## Codex Workpad",
                    createdAt: "2026-07-01T00:00:00Z",
                    resolvedAt: null,
                  },
                ],
              },
            },
          },
        });
      }
      if (request.query.includes("CommentById")) {
        return Response.json({
          data: { comments: { nodes: createdCommentId ? [{ id: createdCommentId }] : [] } },
        });
      }

      mutationCount += 1;
      if (!createdCommentId) {
        createdCommentId = request.variables.id;
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      return Response.json({
        errors: [{ message: "Comment ID is already in use." }],
      });
    });

    const options = {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      retryDelayMs: 0,
    };
    assert.equal(await createLinearWorkpadReply("ENG-62", "Copy once.", options), true);
    assert.equal(await createLinearWorkpadReply("ENG-62", "Copy once.", options), true);
    assert.equal(mutationCount, 2);
  });
});
