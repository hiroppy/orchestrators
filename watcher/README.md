# Slack watcher

The watcher brings Symphony tasks into Slack. It keeps one card and thread per task, lets you update
Linear or send instructions from Slack, and notifies the right people when work needs attention.

Follow the root [`SETUP.md`](../SETUP.md) to connect Slack and Linear. See
[`../docs/architecture.md`](../docs/architecture.md) for polling, persistence, and recovery details.

## Using Slack

### Task cards

Each tracked task has one card that updates in place. It shows:

- the project and Linear issue;
- the current Linear status and a selector to change it;
- Symphony's latest activity and a summary of changed files; and
- the linked pull request when available.

The task thread keeps its status Timeline and notifications. When a task reaches a terminal status,
the watcher posts a final message in the channel with links to any nonterminal issues it was
blocking.

### Send instructions

Reply in a task thread to copy text and attachments to the issue's active `## Codex Workpad`
comment in Linear. A `white_check_mark` reaction confirms that the reply was copied.

Supported attachments are PNG, JPEG, GIF, WebP, MP4, MOV, and WebM files up to 25 MiB each. Replies
outside a task thread or without an active Workpad are ignored.

### Notifications

Assign Slack users or user groups to a task to control who is notified:

- Blocked tasks mention their current assignees.

The Linear issue creator is assigned automatically when their email matches a Slack user. You can
also configure `slack.defaultAssignees` for every new task.

### Commands

Mention the configured bot to run a command:

- `@bot status` — list tracked Todo, In Progress, and In Review tasks.
- `@bot assign @user-or-group|username|me` — add a notification assignee. Run this in a task thread.
- `@bot unassign @user-or-group|username|me` — remove a notification assignee. Run this in a task
  thread.
- `@bot take-pr <GitHub PR URL>` — create a Todo Linear issue for an existing open pull request.
- `@bot help` — show the available commands.

Usernames work with or without `@`. Use `me` to assign or unassign yourself.

## Optional configuration

The root `config.ts` is gitignored. Use environment variables for credentials as shown in
[`../config.example.ts`](../config.example.ts).

### Closed pull requests

When GitHub reports that a linked pull request was closed without merging, the watcher moves its
Linear issue to `Canceled` by default. Override the target status when your workflow uses another
name:

```ts
export default defineConfig({
  watcher: {
    pullRequestStatusSync: {
      closed: "Declined",
    },
  },
  // linearTeams, instances, and Slack configuration...
});
```

The default or configured status must exist in every enabled Linear team. During periodic
maintenance, the watcher checks tracked nonterminal tasks with a pull request and applies the
configured status only for GitHub's `CLOSED` state. It ignores `OPEN` and `MERGED`; merged
transitions remain owned by Linear's GitHub workflow automation. Before updating the status, the
watcher confirms that Linear still has the same pull request attached, so a removed or replaced
pull request is not applied. Issues that have already reached an effective terminal Linear state
are also left unchanged. When an issue is in `Rework`, its old PR may be closed while Symphony
starts a fresh attempt, so the watcher does not apply the closed-PR transition.

Each successful closed-PR observation is recorded by pull request URL, state, and head commit so it
is not applied again. GitHub lookup and Linear mutation failures are isolated per task and remain
eligible for the next maintenance poll.

### Review requeue

Enable `watcher.reviewComment` to send a pull request back to Symphony when it has a merge conflict
or a new eligible inline review comment:

```ts
export default defineConfig({
  watcher: {
    reviewComment: {
      inReviewStatus: "In Review",
      inProgressStatus: "In Progress",
      reviewReadyDelayMs: 10 * 60 * 1_000,
      symphonyGitHubLogins: ["your-symphony-account"],
    },
  },
  // linearTeams, instances, and Slack configuration...
});
```

Set `symphonyGitHubLogins` to every GitHub account Symphony uses to reply to reviews. Comments from
those accounts and the pull request author are ignored, as are resolved or outdated review threads.
For pull requests that stay ready at the same revision for `reviewReadyDelayMs`, the watcher also
mentions the task's assignees. The delay is in milliseconds and defaults to 10 minutes when omitted;
set it to `0` to notify on the first check after the revision has been observed. Changing the revision
or moving the issue out of review resets the timer, but each pull request SHA is notified only once.
Remove `reviewComment` to disable both automatic requeueing and review-ready notifications.

### In Review reminder

Enable a daily summary of stale review tasks in the global Slack channel with
`watcher.inReviewReminder`:

```ts
watcher: {
  inReviewReminder: {
    status: "In Review",
    afterDays: 4,
    postAt: "09:00",
    timeZone: "Asia/Tokyo",
  },
}
```

The watcher posts once per local calendar day, on the first maintenance cycle at or after `postAt`.
Each stale task is listed with its task-specific Slack assignees. `afterDays` defaults to `4`,
`postAt` to `09:00`, and `timeZone` to `Asia/Tokyo`. A failed Slack post remains eligible for the
next maintenance cycle. This reminder is independent of `reviewComment.reviewReadyDelayMs`.

The configured status names must exist in every enabled instance's Linear workflow.

### Status hooks

Use `instances.<service>.statusHooks` to post custom Slack messages when a task enters a Linear status:

```ts
export default defineConfig({
  instances: {
    "service-a": {
      port: 4105,
      linearTeam: "workspace-a-eng",
      statusHooks: [
        {
          id: "ready-for-review",
          status: "In Review",
          run: ({ issue, pullRequest }) =>
            pullRequest ? `Ready for review: ${issue.identifier} ${pullRequest.url}` : undefined,
        },
      ],
    },
  },
  // linearTeams, instances, and Slack configuration...
});
```

Returning a string posts it to the task thread. For richer messages, use the callback's helpers:

- `helpers.slack.postMessage(message)` posts to the watcher channel.
- `helpers.slack.postThreadMessage(message)` posts to the task thread.

Keep each hook's `id` unique and stable. The watcher schedules one execution per status transition.
If an execution fails, it can run again up to `maxAttempts` total attempts (default: `10`) before
the task thread receives a failure notice. Hooks must be idempotent because retries can repeat side
effects.

Put larger hook implementations in the gitignored root `hooks/` directory and import them from
`config.ts`. Hooks run inside the watcher process, so do not block while waiting for long-running
work such as CI or a build. Make that work a required CI check and use the hook to report its result.

### Pull request monitors

Use `instances.<service>.pullRequestMonitors` to observe the complete pull request every 30 seconds while a
task is in `watcher.reviewComment.inReviewStatus`. The first observation establishes an in-memory
baseline. Leaving that status clears the baseline, so returning to review starts with a fresh
observation. Later calls receive both `pullRequest` and `previousPullRequest`, so one monitor can
report label, CI, review, draft, and other PR changes together:

```ts
pullRequestMonitors: [
  {
    id: "review-progress",
    run: ({ pullRequest: current, previousPullRequest: previous }) => {
      const messages: string[] = [];
      if (!previous.labels?.includes("ready") && current.labels?.includes("ready")) {
        messages.push("Label `ready` added");
      }
      const oldCheck = previous.checks?.find(({ name }) => name === "test");
      const newCheck = current.checks?.find(({ name }) => name === "test");
      if (oldCheck?.status !== "COMPLETED" && newCheck?.status === "COMPLETED") {
        messages.push(`CI \`test\` completed: ${newCheck.conclusion ?? "unknown"}`);
      }
      return messages.length > 0 ? messages.join("\n") : undefined;
    },
  },
],
```

Returning a string posts one message to the task thread. The same Slack helpers available to status
hooks are also passed as the second argument. Monitor snapshots intentionally live only in process
memory: restarting the watcher establishes a new baseline, and changes made while it was stopped are
not replayed.

### Custom commands

Use `instances.<service>.slackCommands` to add service-specific Slack mention commands:

```ts
export default defineConfig({
  instances: {
    "service-a": {
      port: 4105,
      linearTeam: "workspace-a-eng",
      slackCommands: [
        {
          command: "preview",
          run: ({ issue, args }) => `Preview for ${issue.identifier}: ${args.join(" ")}`,
        },
      ],
    },
  },
  // linearTeams and Slack configuration...
});
```

Run the example with `@Bot preview <arguments>` inside a tracked task thread. The watcher selects
the command configured by that task's service. The command context includes `issue` and, when the
task has one, an optional `pullRequest`. Returning a string posts it to the task thread.
`helpers.slack.postMessage` and `helpers.slack.postThreadMessage` provide convenient scoped posting.
For other Slack APIs, use `helpers.slack.client` together with `channelId`, `messageTs`, and
`threadTs`. Command names must be unique per service, use lowercase letters, numbers, and hyphens,
and must not conflict with built-in commands.

Put larger command implementations in the gitignored root `commands/` directory and import them
from `config.ts`.
