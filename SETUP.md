# Setup

This guide configures the Slack watcher and creates a local Symphony instance.
Run all commands from the repository root unless noted otherwise.

Before starting, make sure you have the software listed in the
[README requirements](README.md#requirements).

## 1. Install dependencies

```sh
npm run setup
pnpm install
cp config.example.ts config.ts
```

The root `config.ts` is gitignored. Credentials can also be read from
environment variables as shown in `config.example.ts`. The Symphony runner and
Slack watcher both read this configuration.

## 2. Create the Slack app

Create the app from [`watcher/slack-manifest.json`](watcher/slack-manifest.json),
install it to the workspace, and invite its bot to the destination channel. The
manifest enables Socket Mode and interactivity with the scopes required by the
watcher.

The manifest cannot issue an app-level token. In **Basic Information →
App-Level Tokens**, choose **Generate Token and Scopes**, add
`connections:write`, and copy the resulting `xapp-...` token. You will also need
the installed bot's `xoxb-...` token.

When adding or changing scopes on an existing Slack app, reinstall the app to
the workspace. Replace the configured bot token if Slack issues a new one.

## 3. Configure Slack, Linear, and instances

Collect the following values:

- `SLACK_BOT_TOKEN` — Slack bot token (`xoxb-...`)
- `SLACK_APP_TOKEN` — Slack app-level token (`xapp-...`)
- `SLACK_CHANNEL_ID` — destination Slack channel ID
- `LINEAR_API_KEY_PROJECT` — Linear API key
- `LINEAR_TEAM_ID_PROJECT` — Linear team ID
- `<instance-name>` — local Symphony instance name
- `<team-key>` — key used for the Linear team
- `<workspace>` — Linear workspace slug

Declare Linear credentials as named teams in `config.ts`, then reference one
team from every instance:

```ts
export default defineConfig({
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN ?? "", // xoxb-...
    appToken: process.env.SLACK_APP_TOKEN ?? "", // xapp-...
    channelId: process.env.SLACK_CHANNEL_ID ?? "",
  },
  linearTeams: {
    "<team-key>": {
      apiKey: process.env.LINEAR_API_KEY_PROJECT ?? "",
      teamId: process.env.LINEAR_TEAM_ID_PROJECT ?? "",
      baseUrl: "https://linear.app/<workspace>/issue",
    },
  },
  instances: {
    "<instance-name>": {
      enabled: true,
      port: 4105,
      linearTeam: "<team-key>",
    },
  },
});
```

See [`watcher/README.md`](watcher/README.md) for Slack commands, runtime
behavior, and optional watcher configuration.

## 4. Create a Symphony instance

You will need:

- `<instance-name>` — the name used in `config.ts`
- `<repository-url>` — repository cloned into each issue workspace
- `<linear-project-slug>` — Linear project slug

Create the instance:

```sh
./scripts/setup-symphony.sh "<instance-name>"
```

The command asks you to choose between this repository's default `customize`
workflow and Symphony's `official` workflow. See
[`docs/workflows.md`](docs/workflows.md) for the differences and non-interactive
usage.

## 5. Configure the instance workflow

Edit `symphonies/<instance-name>/elixir/WORKFLOW.md` and set the Linear project
slug and repository URL. Each instance has an independent workflow, and
`symphonies/` is gitignored. See [`docs/workflows.md`](docs/workflows.md) for the
required fields and a complete example.

Build the copied instance:

```sh
cd "symphonies/<instance-name>/elixir"
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build
cd ../../..
```

## 6. Start Orchestrators

Start the Symphony instances:

```sh
pnpm start:symphonies
```

In another terminal, start the Slack watcher:

```sh
pnpm start:watcher
```

Each instance dashboard is available at `http://127.0.0.1:<port>`. Logs are
written to `data/symphony/logs/<instance-name>/`.

Restart both processes after adding or changing an instance because
configuration is loaded at startup.

## 7. Verify the setup

Confirm that:

- `http://127.0.0.1:<port>` opens the dashboard for each enabled instance.
- `data/symphony/logs/<instance-name>/` contains the instance logs.
- The watcher starts without Slack, Linear, or workflow validation errors.
- The bot responds in the configured Slack channel. See the
  [Slack commands](watcher/README.md#slack-commands) for a simple status check.

## Update Symphony

To update the source used for newly created instances, pull the latest
`openai/symphony` `main` branch into `symphony_template/`:

```sh
./scripts/update-symphony.sh
```

This does not update instances already copied to `symphonies/`.
