# Symphony workflows

Each generated Symphony instance has its own
`symphonies/<instance-name>/elixir/WORKFLOW.md`. The `symphonies/` directory is
gitignored, so instances can be customized independently without changing the
upstream template.

## Workflow profiles

`scripts/setup-symphony.sh` supports two profiles:

- `customize` (default) — applies this repository's Japanese Linear, pull
  request, review quiet-window, and Docker cleanup conventions
- `official` — copies the upstream Symphony workflow unchanged

Pass a profile explicitly for non-interactive setup:

```sh
./scripts/setup-symphony.sh "<instance-name>" official
./scripts/setup-symphony.sh "<instance-name>" customize
```

The `customize` profile is maintained in
[`../overlays/customize/workflow.patch`](../overlays/customize/workflow.patch),
while `symphony_template/` remains identical to upstream.

The watcher example configuration uses `In Review`, matching the default
`customize` profile. The `official` profile uses Symphony's upstream
`Human Review` status. When using it, set
`watcher.reviewComment.inReviewStatus` to `Human Review`.

## Per-instance configuration

At minimum, configure the Linear project slug, active and terminal states,
workspace, repository, and agent limits:

```yaml
---
tracker:
  kind: linear
  provider:
    project_slug: "<linear-project-slug>"
  required_labels: []
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled
polling:
  interval_ms: 5000
workspace:
  root: ../../../data/symphony/workspaces/<instance-name>
hooks:
  after_create: |
    git clone --depth 1 <repository-url> .
agent:
  max_concurrent_agents: 10
  max_turns: 20
---
```

The `workspace.root` path is relative to the instance's `elixir/` directory.
