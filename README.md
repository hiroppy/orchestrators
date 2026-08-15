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
- **Automated review loops keep moving.** When a new inline review comment is
  added to a linked pull request while its issue is in review, Orchestrators
  requeues the Linear issue so Symphony can act on the feedback.

## How it works

The default `customize` workflow follows this cycle:

```mermaid
flowchart LR
  subgraph build["Build"]
    direction TB
    create["📝 Create a Linear issue<br/>Backlog → Todo"]
    implement["🤖 Symphony implements it<br/>Todo → In Progress"]
    slack["💬 Follow progress and give instructions<br/>in the Slack task thread"]
    create --> implement --> slack
  end

  subgraph reviewCycle["Automated review"]
    direction TB
    review["Ready for human review<br/>In Review"]
    automated{"New inline review comment?"}
    requeue["↩ Requeue the issue<br/>In Progress"]
    review --> automated
    automated -- Yes --> requeue
  end

  subgraph verifyCycle["Human review"]
    direction TB
    notify["🔔 Slack notifies the reviewers"]
    verify{"Does it work as expected?"}
    feedback["Reply in Slack<br/>and move back to In Progress"]
    notify --> verify
    verify -- No --> feedback
  end

  subgraph land["Land"]
    direction TB
    merging["Approve and move to Merging"]
    done["🚀 Symphony lands the pull request<br/>Done"]
    merging --> done
  end

  slack --> review
  automated -- No --> notify
  verify -- Yes --> merging
```

See [Architecture](docs/architecture.md#inline-review-comment-lifecycle) for polling,
comment handling, persistence, and recovery details.

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
  boundaries, and the inline-review-comment lifecycle
