import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../persistence/database.ts";
import { WatcherStore } from "../persistence/store.ts";

export function fakeClient(calls: Array<{ method: string; args: Record<string, unknown> }>) {
  let timestamp = 0;
  return {
    reactions: {
      async add(args: Record<string, unknown>) {
        calls.push({ method: "addReaction", args });
        return { ok: true };
      },
    },
    chat: {
      async getPermalink(args: Record<string, unknown>) {
        calls.push({ method: "getPermalink", args });
        const messageTs = String(args.message_ts).replace(".", "");
        return {
          ok: true,
          channel: String(args.channel),
          permalink: `https://example.slack.com/archives/${args.channel}/p${messageTs}`,
        };
      },
      async postMessage(args: Record<string, unknown>) {
        timestamp += 1;
        calls.push({ method: "postMessage", args });
        return { ok: true, channel: String(args.channel), ts: `${timestamp}.000` };
      },
      async update(args: Record<string, unknown>) {
        calls.push({ method: "update", args });
        return { ok: true, channel: String(args.channel), ts: String(args.ts) };
      },
    },
  } as never;
}

export function reactionClient(calls: Array<Record<string, unknown>>) {
  return {
    reactions: {
      async add(args: Record<string, unknown>) {
        calls.push(args);
        return { ok: true };
      },
    },
  };
}

export async function withStore(run: (store: WatcherStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "watcher-slack-app-"));
  const database = createDatabase(join(directory, "watcher.db"));
  const store = new WatcherStore(database.db);
  store.syncDefinitions(
    [{ name: "service-a", url: "https://service.test/state", linearTeam: "workspace-a-eng" }],
    {
      "workspace-a-eng": {
        apiKey: "lin_test",
        teamId: "team-a",
        statuses: ["Todo", "In Progress", "Rework", "In Review", "Done"],
      },
    },
  );

  try {
    await run(store);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Condition was not met.");
}
