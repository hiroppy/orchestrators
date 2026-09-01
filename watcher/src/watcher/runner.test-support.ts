import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase } from "../persistence/database.ts";
import { WatcherStore } from "../persistence/store.ts";

export function dataUrl(value: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
}

export function linearTeams(statuses = ["Todo", "Done", "Canceled"]) {
  return {
    "workspace-a-eng": {
      apiKey: "lin_test",
      teamId: "team-a",
      statuses,
    },
  };
}

export function baseConfig() {
  return {
    linearTeams: linearTeams(),
    instances: {
      "service-a": {
        port: 4101,
        linearTeam: "workspace-a-eng",
      },
    },
  };
}

export function runtimeConfig<T extends object>(config: T) {
  return {
    pollIntervalMs: 3_000,
    endedTaskRetry: {
      maxAttempts: 2,
      delayMs: 5_000,
    },
    pullRequestStatusSync: { closed: "Canceled" },
    ...config,
  };
}

export function fakeSlackClient(
  calls: Array<Record<string, unknown>>,
  options: {
    rejectGetPermalink?: (args: Record<string, unknown>) => boolean;
    rejectPostMessage?: (args: Record<string, unknown>) => boolean;
    rejectUpdate?: (args: Record<string, unknown>) => boolean;
  } = {},
) {
  let timestamp = 0;
  return {
    users: {
      async lookupByEmail(args: Record<string, unknown>) {
        calls.push({ method: "lookupByEmail", ...args });
        return { ok: true, user: { id: "U123" } };
      },
    },
    chat: {
      async getPermalink(args: Record<string, unknown>) {
        calls.push({ method: "getPermalink", ...args });
        if (options.rejectGetPermalink?.(args)) throw new Error("Simulated Slack failure");
        return {
          ok: true,
          channel: String(args.channel),
          permalink: `https://example.slack.com/archives/${args.channel}/p${String(
            args.message_ts,
          ).replace(".", "")}`,
        };
      },
      async postMessage(args: Record<string, unknown>) {
        if (options.rejectPostMessage?.(args)) throw new Error("Simulated Slack failure");
        timestamp += 1;
        calls.push({ method: "postMessage", ...args });
        return { ok: true, channel: String(args.channel), ts: `${timestamp}.000` };
      },
      async update(args: Record<string, unknown>) {
        if (options.rejectUpdate?.(args)) throw new Error("Simulated Slack card failure");
        calls.push({ method: "update", ...args });
        return { ok: true, channel: String(args.channel), ts: String(args.ts) };
      },
    },
    reactions: {
      async add(args: Record<string, unknown>) {
        calls.push({ method: "reactions.add", ...args });
        return { ok: true };
      },
      async get(args: Record<string, unknown>) {
        calls.push({ method: "reactions.get", ...args });
        return { ok: true, message: { reactions: [] } };
      },
      async remove(args: Record<string, unknown>) {
        calls.push({ method: "reactions.remove", ...args });
        return { ok: true };
      },
    },
  } as never;
}

export async function withStore(run: (store: WatcherStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "watcher-run-"));
  const database = createDatabase(join(directory, "watcher.db"));

  try {
    await run(new WatcherStore(database.db));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
