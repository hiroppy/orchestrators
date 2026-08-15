# Orchestrator Slack Watcher

See [`../docs/architecture.md`](../docs/architecture.md) for the relationship between Symphony,
the watcher, Linear, GitHub, Slack, and the inline-review-comment lifecycle.

## Configuration

The repository root `config.ts` is gitignored. Credentials can also be read from
environment variables as shown in the root `config.example.ts`.

Both entrypoints import `orchestrator-config/runtime`. Normal execution resolves
that export to the shared root `config.ts`; the `test` condition resolves it to a
fixture owned by the config package. Tests and type checking do not require a
private config file.

### Define teams and instances

Declare Linear credentials as named teams, then reference one team from every
instance:

```ts
export default defineConfig({
  linearTeams: {
    "workspace-a-eng": {
      apiKey: process.env.LINEAR_API_KEY_WORKSPACE_A_ENG ?? "",
      teamId: process.env.LINEAR_TEAM_ID_WORKSPACE_A_ENG ?? "",
      baseUrl: "https://linear.app/workspace-a/issue",
    },
  },
  instances: {
    "service-a": {
      enabled: true,
      port: 4105,
      linearTeam: "workspace-a-eng",
    },
  },
});
```

The instance key is its Symphony directory and service name. Its observability
URL is `http://127.0.0.1:<port>/api/v1/state`. `enabled` defaults to `true`;
only set it to `false` when the instance should not be started or watched.

The watcher polls each instance's internal observability API every three seconds. Periodic
maintenance, including Linear reconciliation and failed status-hook retries, runs every 30
seconds.
Terminal task observations are retried twice with a five-second delay by
default. Override those checks only when needed:

```ts
{
  watcher: {
    endedTaskRetry: {
      maxAttempts: 2,
      delayMs: 5_000,
    },
  },
}
```

There is no fallback Linear team. `defineConfig()` catches unknown team
references during type-checking, and runtime validation rejects invalid
imported values, duplicate enabled ports, and missing credentials at startup.
The watcher fetches the referenced teams' current workflow states from Linear
before polling.

Workflow-specific behavior remains explicit: `reviewComment.inReviewStatus`
and `reviewComment.inProgressStatus` are business rules rather than
discoverable Linear semantics. Startup verifies that every configured name
exists in each enabled team's fetched workflow and fails with a configuration
error if it does not.

### Inline review comment requeue

Set `watcher.reviewComment` to move review work back into Symphony when an
unhandled inline review comment is observed in an unresolved thread while the
issue is in review:

```ts
{
  watcher: {
    // Remove this block to disable inline-comment requeueing.
    reviewComment: {
      inReviewStatus: "In Review",
      inProgressStatus: "In Progress",
      symphonyGitHubLogins: ["your-symphony-account"],
    },
  },
}
```

The watcher checks inline comments only while the Linear issue is in
`inReviewStatus`. If the newest comment is later than the last handled comment,
the issue moves to `inProgressStatus`. The handled timestamp is stored in the
existing event log; comment IDs and deletion state are not tracked. Omit
`watcher.reviewComment` to disable this behavior.
Comments in resolved or outdated review threads are ignored. A resolved thread
becomes eligible again if it is subsequently marked unresolved and is not outdated.
Comments from the pull request author and accounts listed in
`symphonyGitHubLogins` are also ignored. Configure the GitHub account used by
Symphony to reply to reviews so its own replies do not requeue the issue.

Comment checks run during periodic maintenance, including for tasks that remain
in the current Symphony snapshot without producing a new snapshot event. The
single watcher stores the handled timestamp after Linear accepts the status
update. It intentionally does not implement a separate requeue outbox or
distributed exactly-once recovery.

### Status hooks

Use `watcher.statusHooks` to run TypeScript after a tracked issue enters a
specific Linear status. Put local hook modules in the gitignored root `hooks/`
directory and import them from `config.ts`.

The callback's first argument contains typed issue, status transition, and linked
pull request data. The second argument contains helpers created by the watcher;
their destinations are fixed for the current task, so hook code does not choose
channel or thread IDs:

- `helpers.slack.postMessage(message)` posts to the watcher channel.
- `helpers.slack.postThreadMessage(message)` replies to the tracked task thread.
- Returning a non-empty string is shorthand for posting one task-thread reply.
- `id` must be unique and stable across hook reordering so interrupted deliveries can resume safely.
- Message arguments use Slack's `ChatPostMessageArguments` type. The watcher fixes
  `channel` and `thread_ts`; hook code supplies `text` or blocks and any other
  supported Slack options.

<details>
<summary>Complete TypeScript hook example</summary>

Create `hooks/in-review.ts`:

```ts
import type { StatusHookConfig } from "orchestrator-config";

export const inReviewHook: StatusHookConfig["run"] = async ({ issue, pullRequest }, { slack }) => {
  if (!pullRequest) return;

  const testingUri = await findAppDistributionUrl(pullRequest.url);
  await slack.postThreadMessage({
    text: `App Distribution is ready for ${issue.identifier}: ${testingUri}`,
    unfurl_links: false,
    unfurl_media: false,
  });
};

async function findAppDistributionUrl(pullRequestUrl: string): Promise<string> {
  // Read the URL from the completed required CI check.
  return pullRequestUrl;
}
```

Import it from the gitignored root `config.ts`:

```ts
import { defineConfig } from "orchestrator-config";

import { inReviewHook } from "./hooks/in-review.ts";

export default defineConfig({
  watcher: {
    statusHooks: [
      {
        id: "app-distribution",
        status: "In Review",
        maxAttempts: 10,
        run: inReviewHook,
      },
    ],
  },
  // linearTeams, instances, and Slack configuration...
});
```

</details>

Hooks run only on a transition edge, not on every poll.
Failed hooks are retried up to `maxAttempts` times (default: `10`). When the
limit is reached, the watcher posts a failure notice to the task thread and
stops retrying that hook.
Failures are logged without stopping the watcher. Hooks are trusted in-process
TypeScript and must not perform blocking synchronous work; they should also be
idempotent. For asynchronous work, such as an App Distribution
build, make that build a required CI check and use the hook to read its completed
result instead of waiting for CI inside the hook.

## Slack commands

Mention the configured bot to run a command:

- `@bot status` — show tracked Todo, In Progress, and In Review tasks.
- `@bot assign @user-or-group|username|me` — add a user or user group to
  notifications for a tracked task. Usernames work with or without `@`; use
  `me` to assign yourself. Run this in the task thread.
- `@bot unassign @user-or-group|username|me` — remove a user or user group from
  notifications for a tracked task. Usernames work with or without `@`; use
  `me` to unassign yourself. Run this in the task thread.
- `@bot take-pr <GitHub PR URL>` — create a Todo Linear issue for an existing
  open pull request. Symphony moves it to In Progress when execution starts.
- `@bot help` — show the available commands and where to run them.

## Preview Slack output

Post a representative watcher message to Slack without starting the watcher or
connecting to Linear. Specify whether to preview a parent post or thread update,
followed by the event type:

```sh
cd watcher

SLACK_BOT_TOKEN=xoxb-... \
SLACK_CHANNEL_ID=C0123456789 \
pnpm slack:preview post start

SLACK_BOT_TOKEN=xoxb-... \
SLACK_CHANNEL_ID=C0123456789 \
pnpm slack:preview thread update
```

The first argument is `post` or `thread`. Available event types are `start`,
`update`, `retry`, `block`, `end`, and `recover`. Use `thread manual` to preview
a status change made by a Slack user, including the actor's display name. A
consolidated status card with Event, Assignees, and history can be previewed
with `thread timeline`. A configured creator and additional mention targets can
be previewed with `post attention` or `thread attention`. Pass them as `mentionTarget` and
`mentions` when using the preview helper; the CLI uses non-notifying
placeholders. Use `thread review-comment` and `thread next`
for task-thread notifications, `post closed` for the top-level task-closed
notification, and `assignees status` for the status summary.
Thread previews are posted as
new parent messages so their formatting can be inspected without existing
watcher threads.

Run the command from the `watcher` directory. It uses the same card builder as
the watcher and requires only a bot token with permission to post to the
destination channel. It does not require the root `config.ts` or
`SLACK_APP_TOKEN`.

## Message behavior

- After the continuous watcher connects to Slack, it does not post a startup
  notification. The `status` command shows the enabled services and watcher
  start time above the tracked task groups.
- A task's first emitted event creates its database record and posts one
  top-level card with `chat.postMessage`. The returned channel and timestamp
  are stored after a successful post. Once those identifiers are stored, later
  emitted events update that same card with `chat.update`.
- A normal task card contains a service-tagged Linear issue title when one is
  available, linked when an issue URL is available, followed by the service's
  Linear status selector and event context. Context details are pipe-delimited.
  Synthetic service availability cards are titled `Symphony connection`, show
  the current availability status in their context, and do not include a
  status selector.
- When Linear moves an issue into a `completed`, `canceled`, or `duplicate`
  state type, the permalink URL of an existing parent card is posted to the
  same channel below a `Task closed` line containing the current Linear status.
  Each nonterminal Linear issue that the closed issue blocks is then posted as
  a separate link in that notification's thread. Repeated observations of the
  same terminal state do not post the notification again.
- Slack status changes are acknowledged immediately, validated against that
  task's referenced Linear team workflow, written with that team's API key,
  rendered in Slack, persisted, and recorded in the thread. The first status
  transition creates one thread reply; later transitions update that reply with
  the latest `from → to` transition and move older transitions into its Timeline.
  Changes for the same task are serialized. Timeline transitions are persisted
  before Slack delivery and retried during periodic maintenance when delivery or
  anchor persistence is interrupted. The local task status is persisted only after
  both the Linear update and Slack card update succeed.
- Manual status history renders the actor's Slack display name as plain text,
  falling back to the Slack user ID when lookup fails. The actor is not
  mentioned. New tasks persist `slack.defaultAssignees` and a Linear creator
  resolved by email to a Slack user once, before the parent post. Parent cards
  display those assignees without notifying them. Watcher thread notifications
  mention the current persisted assignees only when `slack.notifications.statuses`
  or `slack.notifications.events` matches. The `assign` and `unassign` commands
  update both persistence and the parent card without reapplying defaults.
- A user's text and attached images or videos in a task card thread are copied once to
  the active `## Codex Workpad` comment on the corresponding Linear issue.
  PNG, JPEG, GIF, WebP, MP4, MOV, and WebM file-only replies are supported. Bot messages,
  edited/deleted message events, unrelated threads, and issues without an
  active Workpad are ignored. Files are transferred sequentially and limited
  to 25 MiB each. A successfully copied Slack reply receives a
  `white_check_mark` reaction.
- The Symphony snapshot diff emits task events when an issue first appears,
  changes its reported state, enters retrying or blocked, or disappears.
  Changes only to activity text, timestamps, or counters do not emit an event.
- Every successfully published watcher event creates or updates the parent card
  and is stored in the database audit trail. Status changes update the shared
  thread Timeline, and newly detected or updated pull requests refresh its PR
  section without posting a separate reply. A thread reply is posted only for a
  configured mention. Manual Slack status changes share the same status Timeline.
- Raw worker stdout is not posted. Thread messages are capped at 2,500
  characters, and error details shown on cards are capped at 180 characters.
- Inline PR comments are queried only for issues in the configured review status.
  A comment newer than the persisted handled timestamp requeues the issue once.
- Observability and Linear requests time out instead of blocking the polling
  loop indefinitely. A temporary observability failure preserves the last
  known task snapshot and posts a service warning; recovery updates that
  warning without emitting false task-ended/task-started transitions.
