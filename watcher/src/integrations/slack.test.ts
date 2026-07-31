import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { downloadSlackFile } from "./slack.ts";

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
    );

    assert.deepEqual(new Uint8Array(data), new Uint8Array([1, 2, 3]));
  });

  it("rejects non-Slack URLs before sending the bot token", async (context) => {
    const fetchMock = context.mock.method(globalThis, "fetch");

    await assert.rejects(
      downloadSlackFile("https://example.com/image.png", "xoxb-test"),
      /non-Slack URL/,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("rejects unsuccessful Slack downloads", async (context) => {
    context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 403 }));

    await assert.rejects(
      downloadSlackFile("https://files.slack.com/files-pri/image.png", "xoxb-test"),
      /HTTP 403/,
    );
  });
});
