import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createLinearWorkpadReply,
  fetchLinearIssueState,
  fetchLinearWorkflowStates,
  updateLinearIssueStatus,
} from "./linear.ts";

describe("createLinearWorkpadReply", () => {
  it("creates a reply under the active Codex Workpad", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);

      if (requests.length === 1) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              comments: {
                nodes: [
                  {
                    id: "older-active",
                    body: "## Codex Workpad",
                    createdAt: "2026-07-01T00:00:00Z",
                    resolvedAt: null,
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "next-page" },
              },
            },
          },
        });
      }

      if (requests.length === 2) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              comments: {
                nodes: [
                  {
                    id: "active",
                    body: "\n## Codex Workpad\n",
                    createdAt: "2026-07-02T00:00:00Z",
                    resolvedAt: null,
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }

      return Response.json({
        data: { commentCreate: { success: true } },
      });
    });

    const created = await createLinearWorkpadReply("ENG-62", "Please add a test.", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
    });

    assert.equal(created, true);
    assert.deepEqual(requests[1].variables, {
      id: "ENG-62",
      after: "next-page",
    });
    assert.deepEqual(requests[2].variables, {
      id: requests[2].variables.id,
      issueId: "issue-uuid",
      parentId: "active",
      body: "Please add a test.",
    });
    assert.match(
      requests[2].variables.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("uploads every image and embeds it with the reply text", async (context) => {
    const uploads: Array<{
      url: string;
      contentType: string | null;
      cacheControl: string | null;
      body: number[];
    }> = [];
    let commentBody: string | undefined;
    context.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url).startsWith("https://uploads.example/")) {
        uploads.push({
          url: String(url),
          contentType: new Headers(options?.headers).get("Content-Type"),
          cacheControl: new Headers(options?.headers).get("Cache-Control"),
          body: [...new Uint8Array(options?.body as ArrayBuffer)],
        });
        return new Response(null, { status: 200 });
      }

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
      if (request.query.includes("FileUpload")) {
        const filename = String(request.variables.filename);
        return Response.json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: `https://uploads.example/${encodeURIComponent(filename)}`,
                assetUrl: `https://uploads.linear.app/${encodeURIComponent(filename)}`,
                headers: [{ key: "x-upload-token", value: filename }],
              },
            },
          },
        });
      }

      commentBody = request.variables.body;
      return Response.json({ data: { commentCreate: { success: true } } });
    });

    const created = await createLinearWorkpadReply("ENG-62", "See both screenshots.", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      images: [
        {
          filename: "first.png",
          contentType: "image/png",
          loadData: async () => new Uint8Array([1, 2]).buffer,
        },
        {
          filename: "second].jpg",
          contentType: "image/jpeg",
          loadData: async () => {
            assert.deepEqual(
              uploads.map(({ url }) => url),
              ["https://uploads.example/first.png"],
            );
            return new Uint8Array([3, 4, 5]).buffer;
          },
        },
      ],
    });

    assert.equal(created, true);
    assert.equal(
      commentBody,
      [
        "See both screenshots.",
        "![first.png](https://uploads.linear.app/first.png)",
        "![second\\].jpg](https://uploads.linear.app/second%5D.jpg)",
      ].join("\n\n"),
    );
    assert.deepEqual(uploads, [
      {
        url: "https://uploads.example/first.png",
        contentType: "image/png",
        cacheControl: "public, max-age=31536000",
        body: [1, 2],
      },
      {
        url: "https://uploads.example/second%5D.jpg",
        contentType: "image/jpeg",
        cacheControl: "public, max-age=31536000",
        body: [3, 4, 5],
      },
    ]);
  });

  it("does not create a reply when a Linear image upload fails", async (context) => {
    let commentCreateCount = 0;
    let uploadAttemptCount = 0;
    context.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url) === "https://uploads.example/failure") {
        uploadAttemptCount += 1;
        return new Response(null, { status: 500 });
      }

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
      if (request.query.includes("FileUpload")) {
        return Response.json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: "https://uploads.example/failure",
                assetUrl: "https://uploads.linear.app/failure",
                headers: [],
              },
            },
          },
        });
      }

      commentCreateCount += 1;
      return Response.json({ data: { commentCreate: { success: true } } });
    });

    await assert.rejects(
      createLinearWorkpadReply("ENG-62", "", {
        apiKey: "lin_test",
        idempotencyKey: "C123:2.000",
        images: [
          {
            filename: "failure.png",
            contentType: "image/png",
            loadData: async () => new Uint8Array([1]).buffer,
          },
        ],
        retryDelayMs: 0,
      }),
      /HTTP 500/,
    );
    assert.equal(uploadAttemptCount, 3);
    assert.equal(commentCreateCount, 0);
  });

  it("retries transient Linear file upload failures", async (context) => {
    let uploadAttemptCount = 0;
    context.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url) === "https://uploads.example/retry") {
        uploadAttemptCount += 1;
        return uploadAttemptCount === 1
          ? new Response(null, { status: 503 })
          : new Response(null, { status: 200 });
      }

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
      if (request.query.includes("FileUpload")) {
        return Response.json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: "https://uploads.example/retry",
                assetUrl: "https://uploads.linear.app/retry",
                headers: [],
              },
            },
          },
        });
      }
      return Response.json({ data: { commentCreate: { success: true } } });
    });

    const created = await createLinearWorkpadReply("ENG-62", "", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      images: [
        {
          filename: "retry.png",
          contentType: "image/png",
          loadData: async () => new Uint8Array([1]).buffer,
        },
      ],
      retryDelayMs: 0,
    });

    assert.equal(created, true);
    assert.equal(uploadAttemptCount, 2);
  });

  it("does not create a comment when the issue has no active Workpad", async (context) => {
    let requestCount = 0;
    let imageLoadCount = 0;
    context.mock.method(globalThis, "fetch", async () => {
      requestCount += 1;
      return Response.json({
        data: {
          issue: {
            id: "issue-uuid",
            comments: {
              nodes: [
                { id: "resolved", body: "## Codex Workpad", resolvedAt: "2026-07-01" },
                { id: "other", body: "ordinary comment", resolvedAt: null },
              ],
            },
          },
        },
      });
    });

    const created = await createLinearWorkpadReply("ENG-62", "No destination", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      images: [
        {
          filename: "ignored.png",
          contentType: "image/png",
          loadData: async () => {
            imageLoadCount += 1;
            return new ArrayBuffer();
          },
        },
      ],
    });

    assert.equal(created, false);
    assert.equal(requestCount, 1);
    assert.equal(imageLoadCount, 0);
  });

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

  it("reconciles an existing image reply before loading another copy", async (context) => {
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
      images: [
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

describe("fetchLinearWorkflowStates", () => {
  it("returns team workflow states in Linear position order", async (context) => {
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        data: {
          team: {
            states: {
              nodes: [
                { name: "Done", type: "completed", position: 1 },
                { name: "In Progress", type: "started", position: 1 },
                { name: "Todo", type: "unstarted", position: 1 },
              ],
            },
          },
        },
      });
    });

    assert.deepEqual(await fetchLinearWorkflowStates("team-id", { apiKey: "lin_test" }), [
      "Todo",
      "In Progress",
      "Done",
    ]);
    assert.equal(calls[0].url, "https://api.linear.app/graphql");
    assert.deepEqual(JSON.parse(calls[0].options.body).variables, { id: "team-id" });
  });

  it("fails when the configured team cannot be resolved", async (context) => {
    context.mock.method(globalThis, "fetch", async () => Response.json({ data: { team: null } }));

    await assert.rejects(
      fetchLinearWorkflowStates("missing-team", { apiKey: "lin_test" }),
      /Linear team not found/,
    );
  });
});

describe("fetchLinearIssueState", () => {
  it("returns current Linear issue state by issue identifier", async (context) => {
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push({ url, options });

      return new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: "ENG-65",
              title: "Show Linear titles in Slack",
              state: { name: "In Review", type: "started" },
              url: "https://linear.app/example/issue/ENG-65/example",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchLinearIssueState("ENG-65", {
      apiKey: "lin_test",
    });

    assert.equal(calls[0].url, "https://api.linear.app/graphql");
    assert.equal(calls[0].options.headers.authorization, "lin_test");
    assert.deepEqual(result, {
      identifier: "ENG-65",
      title: "Show Linear titles in Slack",
      state: "In Review",
      stateType: "started",
      url: "https://linear.app/example/issue/ENG-65/example",
    });
  });

  it("returns null when no api key is configured", async () => {
    const result = await fetchLinearIssueState("ENG-65", {
      apiKey: null,
    });

    assert.equal(result, null);
  });

  it("returns a GitHub pull request attached to the Linear issue", async (context) => {
    context.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            data: {
              issue: {
                identifier: "ENG-67",
                title: "Include attached pull requests",
                state: { name: "In Review", type: "started" },
                url: "https://linear.app/example/issue/ENG-67/example",
                attachments: {
                  nodes: [
                    { url: "https://example.com/design/67" },
                    { url: "https://github.com/example/example-service/pull/456" },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await fetchLinearIssueState("ENG-67", {
      apiKey: "lin_test",
    });

    assert.deepEqual(result.pullRequest, {
      url: "https://github.com/example/example-service/pull/456",
      number: 456,
    });
  });

  it("returns nonterminal issues blocked by the current issue as next related work", async (context) => {
    context.mock.method(globalThis, "fetch", async () =>
      Response.json({
        data: {
          issue: {
            identifier: "ENG-62",
            title: "Finish the foundation",
            state: { name: "Done", type: "completed" },
            url: "https://linear.app/example/issue/ENG-62/foundation",
            relations: {
              nodes: [
                {
                  type: "blocks",
                  relatedIssue: {
                    identifier: "ENG-63",
                    title: "Start the follow-up",
                    url: "https://linear.app/example/issue/ENG-63/follow-up",
                    state: { type: "unstarted" },
                  },
                },
                {
                  type: "blocks",
                  relatedIssue: {
                    identifier: "ENG-64",
                    title: "Already finished",
                    url: "https://linear.app/example/issue/ENG-64/finished",
                    state: { type: "completed" },
                  },
                },
                {
                  type: "related",
                  relatedIssue: {
                    identifier: "ENG-65",
                    title: "Only related",
                    url: "https://linear.app/example/issue/ENG-65/related",
                    state: { type: "unstarted" },
                  },
                },
              ],
            },
          },
        },
      }),
    );

    const result = await fetchLinearIssueState("ENG-62", { apiKey: "lin_test" });

    assert.deepEqual(result?.relatedIssues, [
      {
        identifier: "ENG-63",
        title: "Start the follow-up",
        url: "https://linear.app/example/issue/ENG-63/follow-up",
      },
    ]);
  });

  it("retries transient Linear failures before falling back", async (context) => {
    let attempts = 0;
    context.mock.method(globalThis, "fetch", async () => {
      attempts += 1;

      if (attempts === 1) {
        return new Response("temporary failure", { status: 500 });
      }

      return new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: "ENG-59",
              title: "Retry Linear requests",
              state: { name: "Done", type: "completed" },
              url: "https://linear.app/example/issue/ENG-59/example",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchLinearIssueState("ENG-59", {
      apiKey: "lin_test",
      retryDelayMs: 0,
    });

    assert.equal(attempts, 2);
    assert.deepEqual(result, {
      identifier: "ENG-59",
      title: "Retry Linear requests",
      state: "Done",
      stateType: "completed",
      url: "https://linear.app/example/issue/ENG-59/example",
    });
  });

  it("returns immediately when Linear still reports an active state type", async (context) => {
    let attempts = 0;
    context.mock.method(globalThis, "fetch", async () => {
      attempts += 1;

      return new Response(
        JSON.stringify({
          data: {
            issue: {
              identifier: "ENG-66",
              title: "Keep active issues visible",
              state: { name: "In Progress", type: "started" },
              url: "https://linear.app/example/issue/ENG-66/example",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await fetchLinearIssueState("ENG-66", {
      apiKey: "lin_test",
      retryDelayMs: 0,
    });

    assert.equal(attempts, 1);
    assert.deepEqual(result, {
      identifier: "ENG-66",
      title: "Keep active issues visible",
      state: "In Progress",
      stateType: "started",
      url: "https://linear.app/example/issue/ENG-66/example",
    });
  });

  it("times out a Linear request that never responds", async (context) => {
    context.mock.method(
      globalThis,
      "fetch",
      async (_url, options) =>
        await new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );

    const result = await fetchLinearIssueState("ENG-66", {
      apiKey: "lin_test",
      maxAttempts: 1,
      timeoutMs: 5,
    });

    assert.equal(result, null);
  });
});

describe("updateLinearIssueStatus", () => {
  it("resolves a team-scoped workflow state and updates the Linear issue", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);

      if (requests.length === 1) {
        return Response.json({
          data: {
            issue: {
              id: "issue-uuid",
              team: {
                states: {
                  nodes: [
                    { id: "state-progress", name: "In Progress" },
                    { id: "state-review", name: "In Review" },
                  ],
                },
              },
            },
          },
        });
      }

      return Response.json({
        data: { issueUpdate: { success: true } },
      });
    });

    await updateLinearIssueStatus("ENG-62", "In Review", {
      apiKey: "lin_test",
    });

    assert.deepEqual(requests[1].variables, {
      id: "issue-uuid",
      stateId: "state-review",
    });
  });

  it("fails without mutating when the status does not exist in the issue team", async (context) => {
    context.mock.method(globalThis, "fetch", async () =>
      Response.json({
        data: {
          issue: {
            id: "issue-uuid",
            team: {
              states: { nodes: [{ id: "state-done", name: "Done" }] },
            },
          },
        },
      }),
    );

    await assert.rejects(
      updateLinearIssueStatus("ENG-62", "QA", { apiKey: "lin_test" }),
      /Linear status not found/,
    );
  });

  it("times out a status mutation that never responds", async (context) => {
    context.mock.method(
      globalThis,
      "fetch",
      async (_url, options) =>
        await new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );

    await assert.rejects(
      updateLinearIssueStatus("ENG-62", "Done", {
        apiKey: "lin_test",
        timeoutMs: 5,
      }),
      /timed out|aborted/i,
    );
  });
});
