import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLinearWorkpadReply } from "./index.ts";

describe("Linear Workpad replies", () => {
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

  it("includes the Slack display name in the reply body", async (context) => {
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    context.mock.method(globalThis, "fetch", async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      requests.push(request);
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
      return Response.json({ data: { commentCreate: { success: true } } });
    });

    assert.equal(
      await createLinearWorkpadReply("ENG-62", "Please add a test.", {
        apiKey: "lin_test",
        idempotencyKey: "C123:2.000",
        authorName: "Hiroppy",
      }),
      true,
    );
    assert.deepEqual(requests[1].variables, {
      id: requests[1].variables.id,
      issueId: "issue-uuid",
      parentId: "active",
      body: "Slack投稿者: Hiroppy\n\nPlease add a test.",
    });
  });

  it("uploads every image and video and embeds them with the reply text", async (context) => {
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

    const created = await createLinearWorkpadReply("ENG-62", "See the attachments.", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      files: [
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
        {
          filename: "demo.mp4",
          contentType: "video/mp4",
          loadData: async () => new Uint8Array([6, 7]).buffer,
        },
      ],
    });

    assert.equal(created, true);
    assert.equal(
      commentBody,
      [
        "See the attachments.",
        "![first.png](https://uploads.linear.app/first.png)",
        "![second\\].jpg](https://uploads.linear.app/second%5D.jpg)",
        "![demo.mp4](https://uploads.linear.app/demo.mp4)",
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
      {
        url: "https://uploads.example/demo.mp4",
        contentType: "video/mp4",
        cacheControl: "public, max-age=31536000",
        body: [6, 7],
      },
    ]);
  });

  it("does not create a reply when a Linear file upload fails", async (context) => {
    let commentCreateCount = 0;
    let fileUploadRequestCount = 0;
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
        fileUploadRequestCount += 1;
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
        files: [
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
    assert.equal(fileUploadRequestCount, 3);
    assert.equal(uploadAttemptCount, 3);
    assert.equal(commentCreateCount, 0);
  });

  it("retries transient Linear file upload failures", async (context) => {
    let commentBody: string | undefined;
    let fileUploadRequestCount = 0;
    let uploadAttemptCount = 0;
    context.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url).startsWith("https://uploads.example/retry-")) {
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
        fileUploadRequestCount += 1;
        return Response.json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: `https://uploads.example/retry-${fileUploadRequestCount}`,
                assetUrl: `https://uploads.linear.app/retry-${fileUploadRequestCount}`,
                headers: [],
              },
            },
          },
        });
      }
      commentBody = request.variables.body;
      return Response.json({ data: { commentCreate: { success: true } } });
    });

    const created = await createLinearWorkpadReply("ENG-62", "", {
      apiKey: "lin_test",
      idempotencyKey: "C123:2.000",
      files: [
        {
          filename: "retry.png",
          contentType: "image/png",
          loadData: async () => new Uint8Array([1]).buffer,
        },
      ],
      retryDelayMs: 0,
    });

    assert.equal(created, true);
    assert.equal(commentBody, "![retry.png](https://uploads.linear.app/retry-2)");
    assert.equal(fileUploadRequestCount, 2);
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
      files: [
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
});
