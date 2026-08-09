# Orchestrator Slack Watcher

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
  watcher: {
    pollIntervalMs: 30_000,
  },
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

`watcher.pollIntervalMs` defaults to `30_000` and must be at least `5_000`.
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

Workflow-specific behavior remains explicit: `reviewReaction.inReviewStatus`
and `reviewReaction.inProgressStatus` are business rules rather than
discoverable Linear semantics. Startup verifies that every configured name
exists in each enabled team's fetched workflow and fails with a configuration
error if it does not.

### Review reaction requeue

Set `watcher.reviewReaction` to move review work back into Symphony while a
linked GitHub pull request has the configured reaction:

```ts
{
  watcher: {
    // Requeues a Linear issue from review when a linked GitHub PR has this reaction.
    // Remove this block to disable reaction-based requeueing.
    reviewReaction: {
      inReviewStatus: "In Review",
      inProgressStatus: "In Progress",
      reaction: "👀", // e.g. Codex code review in progress
      maxRequeues: 3,
    },
  },
}
```

The watcher checks reactions only while the Linear issue is in
`inReviewStatus`. A matching reaction moves the issue to `inProgressStatus`.
This repeats until the reaction disappears or `maxRequeues` is reached.

Reaching the limit immediately posts a notice in the task thread. Requeue
counts survive watcher restarts because they are stored in the watcher
database. Omit `watcher.reviewReaction` to disable this behavior.

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
configured creator and additional mention targets can be previewed with
`post attention` or `thread attention`. Pass them as `mentionTarget` and
`mentions` when using the preview helper; the CLI uses non-notifying
placeholders. Use `thread reaction`, `thread reaction-limit`, and `thread next`
for task-thread notifications, `post closed` for the top-level task-closed
notification, and `post watcher-started` for the watcher startup notification.
Thread previews are posted as
new parent messages so their formatting can be inspected without existing
watcher threads.

Run the command from the `watcher` directory. It uses the same card builder as
the watcher and requires only a bot token with permission to post to the
destination channel. It does not require the root `config.ts` or
`SLACK_APP_TOKEN`.

## Message behavior

- After the continuous watcher connects to Slack, it attempts to post one
  top-level startup notification listing the enabled services. A notification
  failure is logged without stopping the polling loop. Dry runs do not connect
  to Slack or post this notification.
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
  rendered in Slack, persisted, and recorded in the thread. Changes for the
  same task are serialized. The local task status is persisted only after both
  the Linear update and Slack card update succeed.
- Manual status history renders the actor's Slack display name as plain text,
  falling back to the Slack user ID when lookup fails. The actor is not
  mentioned. Watcher-originated notifications resolve the Linear issue creator
  by email and render `Creator: <@user>` when a configured `slack.mentions`
  status or event is reached. If Slack lookup fails, the Linear creator name is
  displayed without a mention. Optional `slack.mentions.targets` entries render
  separately as `Mentions:` for reviewers or Slack user groups. When `targets`
  is omitted or empty, the `Mentions:` label is not displayed.
- A user's text and attached images in a task card thread are copied once to
  the active `## Codex Workpad` comment on the corresponding Linear issue.
  PNG, JPEG, GIF, and WebP image-only replies are supported. Bot messages,
  edited/deleted message events, unrelated threads, and issues without an
  active Workpad are ignored. Images are transferred sequentially and limited
  to 25 MiB each. A successfully copied Slack reply receives a
  `white_check_mark` reaction.
- The Symphony snapshot diff emits task events when an issue first appears,
  changes its reported state, enters retrying or blocked, or disappears.
  Changes only to activity text, timestamps, or counters do not emit an event.
- Every successfully published watcher event creates or updates the parent card
  and is stored in the database audit trail. A thread reply is posted only for
  a resolved status transition, a newly detected pull request, or a configured
  mention. Manual Slack status changes also post thread history. Pull request
  replies include the PR URL without replacing the parent title's Linear issue
  link.
- Raw worker stdout is not posted. Thread messages are capped at 2,500
  characters, and error details shown on cards are capped at 180 characters.
- The configured PR reaction's presence is queried only for issues in the
  configured review status. A matching reaction suppresses the review mention
  and requeues the issue up to the configured per-issue maximum.
- Observability and Linear requests time out instead of blocking the polling
  loop indefinitely. A temporary observability failure preserves the last
  known task snapshot and posts a service warning; recovery updates that
  warning without emitting false task-ended/task-started transitions.
