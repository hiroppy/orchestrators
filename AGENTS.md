# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm workspace for running Symphony instances and reporting their state to Slack. `watcher/src/` contains the TypeScript application: entry points, Slack handlers, integrations, persistence, and watcher logic. Tests live beside implementation files as `*.test.ts`. Shared configuration types and loaders are in `config/src/`. Database migrations are under `watcher/drizzle/`; operational scripts are in `scripts/`; workflow customizations are maintained in `overlays/`. Treat `symphony_template/` as the upstream template and avoid mixing local runtime changes into it. Generated instances, private `config.ts`, and runtime data under `data/` are intentionally untracked.

## Build, Test, and Development Commands

- `npm run setup` enables Corepack; then run `pnpm install`.
- `pnpm start:watcher` starts the Slack watcher locally and applies pending database migrations during initialization.
- `pnpm start:symphonies` runs configured Symphony instances.
- `pnpm test` runs Node's built-in test runner with test-specific conditions.
- `pnpm typecheck` validates the watcher with strict TypeScript settings.
- `pnpm lint` runs Oxlint; `pnpm format:check` verifies Oxfmt output.
- `pnpm format` applies formatting, and `pnpm knip` finds unused code or dependencies.
- `pnpm db:generate` creates Drizzle migrations after schema changes.

Node.js 24+ and pnpm 11+ are required. Copy `config.example.ts` to the ignored `config.ts` for local development; never commit credentials.

## Coding Style & Naming Conventions

Use ESM TypeScript with explicit `.ts` imports, strict typing, two-space indentation, double quotes, and trailing commas as produced by Oxfmt. Name files and directories in kebab-case (except required convention files such as `AGENTS.md`), functions and variables in camelCase, and types/interfaces in PascalCase. Keep modules focused and place domain-specific code in the matching `watcher/src/<area>/` directory.

## Documentation Guidelines

Update the relevant documentation in the same change whenever implementation,
configuration, commands, workflows, or runtime behavior changes. Keep the
high-level product flow in `README.md`, installation steps in `SETUP.md`,
watcher-specific behavior in `watcher/README.md`, Symphony workflow details in
`docs/workflows.md`, and system internals in `docs/architecture.md`. Ensure
diagrams and examples remain consistent with the code and default
configuration.

## Data Handling

This is an internal product. Do not treat ordinary PII in internal runtime
state, logs, retry payloads, or local persistence as a concern by default, and
do not add data-minimization complexity unless a task explicitly requires it.
Credentials, API tokens, and other secrets remain sensitive and must never be
committed or exposed.

## Architecture Scope

This is an internal tool operated with a single watcher process. Design for
that deployment model by default. Do not add distributed coordination,
multi-watcher locking, exactly-once guarantees, or elaborate crash-recovery
machinery unless a concrete requirement or demonstrated failure justifies the
complexity. Prefer simple polling and the existing event log when they satisfy
the operational need, and document any intentionally accepted recovery gaps.

## Testing Guidelines

Use `node:test` with `node:assert/strict`; name tests `*.test.ts` beside the code under test. Add focused regression tests for fixes and cover important branches, state transitions, boundaries, and integration failure paths. Before opening a PR, run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm format:check`.

## Commit & Pull Request Guidelines

Follow Conventional Commits used in history, such as `feat(watcher): add status hooks` or `fix(slack): handle attachments`. Keep commits scoped and imperative. PR titles must also follow Conventional Commits. Base descriptions on `.github/pull_request_template.md`: summarize the change, link the Linear issue when available, and record commands and results. Select only relevant ISO/IEC 25010:2023 quality characteristics and appropriate ISTQB techniques, with acceptance criteria, primary test conditions, and explicit out-of-scope risks. Include screenshots for visible Slack UI changes.
