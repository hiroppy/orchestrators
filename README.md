# Orchestrators

Run a fleet of [Symphony](https://github.com/openai/symphony) instances and keep
their work moving from Slack.

Orchestrators gives every project an isolated Symphony instance, then brings
their tasks, pull requests, and Linear workflows into one Slack channel. You can
see what needs attention and respond without opening each Symphony dashboard.

![Task monitoring and Linear status updates in Slack](.github/assets/task.png)

## What it does

- **One control plane for every project.** Run multiple isolated Symphony
  instances with a single command, while keeping each project's workflow,
  workspace, and logs separate.
- **A live task inbox in Slack.** Follow state changes, pull requests, blockers,
  and completed work across every instance from one channel, with a dedicated
  thread for each task.
- **Operate Linear without leaving the conversation.** Change issue status,
  manage task assignees, turn an existing open pull request into tracked Linear
  work, and send replies and images from a Slack thread back to the Linear
  workpad.
- **Automated review loops keep moving.** When a configured review reaction
  (for example, Codex's 👀) appears on a linked pull request, Orchestrators
  requeues the Linear issue so Symphony can act on the feedback.

## How it works

The default `customize` workflow follows this cycle:

```mermaid
flowchart TD
  create["User: Create an issue in the Omakase project<br/>from @Linear or the Linear website"]
  backlog["Linear: Issue starts in Backlog"]
  todo["User: Check the request and move it to Todo"]
  thread["Watcher: Create the Slack parent post<br/>on the first observed task event"]
  implement["Symphony: Move to In Progress<br/>and start or resume implementation"]
  review["Symphony: Finish implementation,<br/>clear review feedback, and pass checks"]
  inReview["Symphony: Move the issue to In Review"]
  reaction{"Configured reaction on the PR?<br/>For example, Codex's 👀"}
  limit{"Has this PR head already reached<br/>the automatic requeue limit?"}
  requeue["Watcher: Move the issue back to In Progress<br/>and record the attempt; notify on the final one"]
  limitNotice["Watcher: Keep the issue in In Review<br/>until the reaction is removed or status changes"]
  notify["Slack: Notify configured assignees<br/>including the creator when resolved"]
  verify["User: Verify the implementation"]
  expected{"Does it work as expected?"}
  feedback["User: Explain the problem in the parent post thread"]
  acknowledged["Watcher: Copy the reply to the Linear Workpad<br/>and acknowledge it with ✅"]
  resume["User: Move the issue back to In Progress<br/>from Slack or Linear"]
  devReview["Development team: Review and approve the pull request"]
  merging["User: Move the issue to Merging"]
  land["Symphony: Run the land workflow"]
  done["Linear: Move the issue to Done"]

  create --> backlog --> todo --> thread --> implement --> review --> inReview --> reaction
  reaction -- Yes --> limit
  limit -- Yes --> limitNotice
  limit -- No --> requeue --> implement
  reaction -- No --> notify --> verify --> expected
  expected -- No --> feedback --> acknowledged --> resume --> implement
  expected -- Yes --> devReview --> merging --> land --> done
```

## Requirements

- Node.js 24+
- pnpm 11+
- Elixir 1.19 and Erlang 28 available on `PATH`
- Authenticated GitHub CLI (`gh auth status`)

Official Symphony recommends `mise` for managing Elixir/Erlang versions, and
the setup guide uses it.

## Run

Follow [`SETUP.md`](SETUP.md) to configure Slack and Linear, create a Symphony
instance, and verify the complete setup. Then start the enabled instances:

```sh
pnpm start:symphonies
```

In another terminal, start the Slack watcher:

```sh
pnpm start:watcher
```

## Documentation

- [`SETUP.md`](SETUP.md) — installation and initial configuration
- [`watcher/README.md`](watcher/README.md) — Slack commands, watcher behavior,
  and optional configuration
- [`docs/workflows.md`](docs/workflows.md) — Symphony workflow profiles and
  per-instance configuration
- [`docs/architecture.md`](docs/architecture.md) — data flow, polling
  boundaries, and the review-reaction lifecycle
