import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { downloadSlackFile } from "./files.ts";

describe("downloadSlackFile", () => {
  it("downloads a private Slack file with the bot token", async (context) => {
    context.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(String(url), "https://files.slack.com/files-pri/image.png");
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer xoxb-test");
      return new Response(new Uint8Array([1, 2, 3]));
    });

    const data = await downloadSlackFile(
      "https://files.slack.com/files-pri/image.png",
      "xoxb-test",
      { expectedSize: 3 },
    );

    assert.deepEqual(new Uint8Array(data), new Uint8Array([1, 2, 3]));
  });

  it("rejects non-Slack URLs before sending the bot token", async (context) => {
    const fetchMock = context.mock.method(globalThis, "fetch");

    await assert.rejects(
      downloadSlackFile("https://example.com/image.png", "xoxb-test", { expectedSize: 3 }),
      /non-Slack URL/,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("rejects unsuccessful Slack downloads", async (context) => {
    context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 403 }));

    await assert.rejects(
      downloadSlackFile("https://files.slack.com/files-pri/image.png", "xoxb-test", {
        expectedSize: 3,
      }),
      /HTTP 403/,
    );
  });

  it("retries transient Slack download failures", async (context) => {
    let attempts = 0;
    context.mock.method(globalThis, "fetch", async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 503 })
        : new Response(new Uint8Array([1, 2, 3]));
    });

    const data = await downloadSlackFile(
      "https://files.slack.com/files-pri/image.png",
      "xoxb-test",
      { expectedSize: 3, retryDelayMs: 0 },
    );

    assert.equal(attempts, 2);
    assert.deepEqual(new Uint8Array(data), new Uint8Array([1, 2, 3]));
  });

  it("rejects oversized files before downloading them", async (context) => {
    const fetchMock = context.mock.method(globalThis, "fetch");

    await assert.rejects(
      downloadSlackFile("https://files.slack.com/files-pri/image.png", "xoxb-test", {
        expectedSize: 25 * 1024 * 1024 + 1,
      }),
      /25 MiB transfer limit/,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
