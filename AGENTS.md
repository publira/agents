# Agents Agent Guide

Repository-specific conventions for coding agents.

## Repository overview

This repository is a `pnpm` workspace for Publira's maintenance automation. Its first application is the maintenance bot: a Vercel deployment that hosts GitHub-facing maintenance jobs and uses eve where agentic behavior helps, while deterministic jobs run without invoking a model.

`pnpm-workspace.yaml` declares two package groups:

- `apps/*`: deployable applications.
  - `maintenance-bot/`: the eve app deployed to Vercel. `agent/` is the eve agent (model, instructions, channels, tools); `src/jobs/` holds the deterministic jobs, and `src/cli/` runs each of them from a terminal.
- `packages/*`: shared libraries the apps import from the workspace without publishing them.
  - `github/`: GitHub API access through Octokit.
  - `maintenance-policies/`: the rules that decide what a job does. Pure functions with no I/O.
  - `npm-registry/`: npm registry lookups.
  - `pnpm-workspace/`: reading pnpm workspace files.
  - `tsconfig/`: the TypeScript configuration every package extends.

Add a package only when a concrete responsibility needs one, and keep GitHub, registry, and policy logic in `packages/*` so it stays testable outside the deployed app.

### Deterministic jobs and the agent

A job is a plain async function in `apps/maintenance-bot/src/jobs/`. It takes its clients (an Octokit, registry options, the current time) as arguments, so tests pass fakes and nothing in it starts an eve session or calls a model. Three things can call it:

- a CLI entry in `src/cli/`, exposed as a script in the app's `package.json`;
- an eve tool in `agent/tools/`, when the model should decide when to run it;
- an eve schedule handler (`defineSchedule` with `run`), which can call the job directly instead of sending a prompt to the agent.

Keep the decision logic in the job and the packages, not in the tool or the prompt.

### Workspace packages

Each package builds `src/index.ts` into `dist/` with [tsdown](https://tsdown.dev/) and exports only that build, which is how the other Publira repositories ship their packages too. A consumer therefore needs the packages built: the Turborepo tasks run `build` in the dependencies first (`dependsOn: ["^build"]`), and a command run outside Turborepo needs `pnpm turbo run build --filter='./packages/*'` once, and again after a package changes. A package's own tests import its sources and need no build.

tsdown emits the declarations with TypeScript 7, whose API is still experimental, so every build warns about it. The warning is expected.

The app's CLI runs its TypeScript sources directly with Node.js type stripping, so the code stays within erasable syntax (`erasableSyntaxOnly`) and relative imports name the `.ts` file. The packages keep to the same rules.

Each package has its own `tsconfig.json`, extending `@publira/tsconfig/base.json`, its own `tsdown.config.ts`, and its own `vitest.config.ts`. Versions that several packages share, such as `typescript`, `tsdown`, `vitest`, `zod`, and `@types/node`, live in the `catalog` of `pnpm-workspace.yaml`, and `catalogMode: strict` keeps the packages on them.

## Toolchain

The root `package.json` pins the toolchain:

- Node.js through `devEngines.runtime`. With `onFail: "download"`, pnpm downloads that version when the active one differs.
- pnpm through `packageManager`.

Change these versions in `package.json` only; do not add `.nvmrc`, `.node-version`, or `engines` copies of them.

TypeScript is version 7, the native compiler. [Turborepo](https://turborepo.com/) runs the per-package tasks, and [Ultracite](https://www.ultracite.ai/) configures oxlint and oxfmt.

pnpm holds back versions published less than a day ago (`minimumReleaseAge`). `pnpm add` of such a version writes an exemption for it to `minimumReleaseAgeExclude`. Prefer the previous release unless the new one is needed, such as for a security fix, and drop the exemption once the version is a day old.

## Development commands

- `pnpm install`: install the workspace dependencies. The Dev Container runs it on creation. Commit `pnpm-lock.yaml` with any dependency change; `pnpm install --frozen-lockfile` must succeed.
- `pnpm typecheck`: type check every package.
- `pnpm test`: run every package's Vitest tests.
- `pnpm check`: run the Ultracite lint and format checks.
- `pnpm fix`: apply the Ultracite fixes.
- `pnpm build`: build the packages with tsdown and the maintenance bot with `eve build`.
- `pnpm --filter @publira/maintenance-bot dev`: start the bot locally with `eve dev`, once the packages are built, which opens eve's terminal UI. It needs a model connection, which eve asks for on first start; `--no-ui` starts the server alone.
- `pnpm --filter @publira/maintenance-bot check-release-age-exclusions <owner/repo>`: run that job from the terminal without eve, once the packages are built. It reads the repository as the GitHub App when `apps/maintenance-bot/.env.local` holds a development App's credentials; otherwise requests are anonymous, and `GH_TOKEN` set to a token of your own raises the GitHub API rate limit.
- `pnpm --filter @publira/maintenance-bot remove-expired-release-age-exclusions <owner/repo> --dry-run`: print the `pnpm-workspace.yaml` the cleanup job would propose, reading as `check-release-age-exclusions` does. Without `--dry-run` it pushes the branch and opens the pull request, which needs the App's credentials.
- `pnpm --filter @publira/maintenance-bot approve-equivalent-renovate-update <owner/repo> <number> --dry-run`: print each condition the Renovate approval job checks on that pull request, and whether it would approve it. The dry run reads GitHub's GraphQL API, so it needs the App's credentials in `.env.local` or `GH_TOKEN`. Without `--dry-run` it submits the review, which needs the App's credentials.
- `RENOVATE_AUTO_MERGE=true pnpm --filter @publira/maintenance-bot auto-merge-renovate-update <owner/repo> <number> --dry-run`: print whether the bot would have GitHub merge that Renovate pull request, or why not. Without `RENOVATE_AUTO_MERGE=true` it decides nothing, as the deployment does. It always needs the App's credentials, because the decision rests on the App's own approval. Without `--dry-run` it enables auto-merge, queues the pull request, or merges it.
- `pnpm --filter @publira/maintenance-bot list-app-repositories`: list the repositories the App in `.env.local` is installed on, which checks its credentials.

Run `pnpm check`, `pnpm typecheck`, and `pnpm test` before committing. The lefthook pre-commit hook formats staged files but does not lint or test them.

## eve

eve is in preview and changes quickly. Read the docs bundled with the installed version in `apps/maintenance-bot/node_modules/eve/docs/` (start with `README.md`) before authoring tools, channels, schedules, or deployment settings, rather than relying on memory. `pnpm exec eve info` in `apps/maintenance-bot/` shows what eve discovered.

The agent's model is an AI Gateway model ID in `agent/agent.ts`. On Vercel the deployment reaches the gateway through the project's OIDC token; locally, `eve dev` asks for a connection. A job that needs a model for one narrow step calls it with the AI SDK outside an agent session, as `src/exclusion-editor.ts` does; keep its model ID in step with the agent's. A command-line run that reaches that step needs `AI_GATEWAY_API_KEY` in `.env.local`.

The `eve` channel accepts Vercel OIDC and, under `eve dev`, localhost. Add an authenticator before exposing a route to anyone else.

## Deployment

The Vercel project's Root Directory is `apps/maintenance-bot`.

A Vercel build provisions eve's sandbox template and needs the project's OIDC token, so `eve build` with `VERCEL=1` fails outside Vercel unless the directory is linked (`eve link`) and its environment pulled.

## GitHub authentication

The bot authenticates as the Publira GitHub App. `@publira/github` signs the App's JWT and requests installation tokens (`createGitHubApp`); `apps/maintenance-bot/src/github-app.ts` reads its credentials from `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`. Without them the bot still starts, its tools read public repositories anonymously, and the webhook route answers 503. The README lists the App's permissions and how to configure each environment.

Do not give the deployed bot a personal access token or a `GITHUB_TOKEN` variable: it would act as a person, with that person's access, instead of as the App. `GH_TOKEN` in the CLI is for local runs only. Do not log a token, a key, the webhook secret, or a whole payload; pass the log the fields it needs one by one.

Request a new App permission only for a concrete API call that needs it, and say which in the pull request. Jobs cannot change `.github/workflows/`, which would need the Workflows permission.

### Renovate update approval

The approval job (`src/jobs/approve-equivalent-renovate-update.ts`) identifies an update by the comments the organization's Renovate preset writes at the top of each pull request body through `prHeader`, one `<!-- publira-renovate-update ... -->` per update, and never by the visible table or the title. None of Renovate's default output carries every field a match needs: the title has no from-version, the table never names the manager and varies its columns between pull requests, and the `renovate-debug` comment holds no update data. A repository whose Renovate configuration sets its own `prHeader` gets no such comments, and its pull requests are not approved. Change the comment's fields in the preset and in `@publira/maintenance-policies` together; the parser refuses a field it does not know.

### Renovate update auto-merge

The auto-merge job (`src/jobs/auto-merge-renovate-update.ts`) runs after the approval job on every evaluated Renovate pull request, but it is a separate decision: `canAutoMerge` in `@publira/maintenance-policies`. `RENOVATE_AUTO_MERGE` turns it on and off without affecting approval. A decision applies to one head only. It requires the bot's own approval of the head and evaluates the approval policy again on that head. It passes the head to GitHub (`expectedHeadOid`, or `sha` for a direct merge), so GitHub refuses the merge for any other head. Every evaluation makes the decision again, because GitHub does not enforce the approval policy. When the head moves, the approval is dismissed, or the decision no longer holds, the bot takes back its auto-merge or queue entry; it detects this by comparing when auto-merge was enabled with when the head was approved. The required checks and rulesets stay GitHub's to enforce. Keep the decision deterministic: no model takes part in it.

### Webhooks

GitHub delivers the App's events to `POST /github/webhooks` (`agent/channels/github-webhooks.ts`). The route verifies the signature, answers at once, and runs the handler for the event, from `src/webhooks/handlers.ts`, in the background. Subscribe the App to an event only once it has a handler.

GitHub can deliver an event twice, and a failed delivery can be redelivered, and the bot has no database to remember deliveries in. A handler, like a scheduled job, therefore checks what is already in place before it writes: write through `commitToBranch`, `ensurePullRequest`, and `ensureReview` from `@publira/github`, which leave a change that is already there as it is.

## CI

`.github/workflows/ci.yml` runs lint, type check, test, and build as separate jobs, on pull requests, on the merge groups the merge queue on `main` builds, and on pushes to `main`. The build job runs `eve build` for a plain Node.js host, which needs no Vercel credentials; the Vercel build happens on Vercel.

Every job sets `timeout-minutes`, so a hung job fails within minutes instead of holding a runner until the 6-hour default. Give a new job one as well. Actions are pinned to a commit SHA, with the version in a trailing comment, so Renovate can keep updating them.

## Dev Container

`.devcontainer/` builds on `ghcr.io/publira/base-images/publira-dev`, pinned by digest with the readable tag before `@sha256:`.

- The docker-in-docker feature gives eve a local Docker daemon for sandboxes that execute real binaries; without one, eve falls back to just-bash. `moby` is disabled because Moby does not support the image's Debian release.
- `.devcontainer/daemon.json` is bind-mounted as the inner daemon's whole configuration. It sends Docker Hub pulls to `mirror.gcr.io` first to stay clear of the anonymous rate limit.
- The agent CLI, `gh`, eve, and Vercel CLI state live in named volumes, so a rebuild keeps their logins. A new tool that keeps credentials in the home directory needs a volume in `mounts` and an entry in `post-create.sh`, which hands the volumes to `vscode`.

After changing `.devcontainer/`, validate the resolved configuration:

```sh
npx --yes @devcontainers/cli read-configuration --workspace-folder .
```

## Dependency updates

Renovate opens the dependency update pull requests. `.github/renovate.json5` only extends the organization preset, `github>publira/.github//renovate.json5`, which builds on `config:best-practices`. Change shared behavior there, and add a rule to this repository's file only when it cannot apply to every Publira repository.

- The preset updates the Node.js version in `devEngines.runtime` with a custom manager, because Renovate's npm manager does not read `devEngines` yet. Keep the `name`, `version` order of that object so the manager still matches it.
- Images and Dev Container Features are pinned by digest. A tool version passed to a Feature as an option is not updated unless a `// renovate: datasource=... depName=...` comment sits on the line above it.

## Language

Everything in the repository is **English**: the READMEs, this guide, code comments, test labels, commit messages, Issues, and pull requests.

Answer the user in the language of their own prose. Quoted logs, code, or UI strings do not decide it. Answer in English when no user prose settles it, such as in a scheduled or CI-started run.

## Git commits and pull requests

Subjects and PR titles use English [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) (`type(scope): description`). Pull requests are squash-merged with the title as the commit subject, so the title must stand on its own.

Pull request descriptions explain the motivation, the main changes, and the verification performed. Link issues only when the relationship is accurate.

### AI agent trailer

A commit written with an AI agent's help discloses it with an `Assisted-by:` trailer. The trailer is process disclosure, not authorship, following the Linux kernel's [Coding assistants](https://docs.kernel.org/process/coding-assistants.html) policy. The format is `Assisted-by: <AGENT_NAME>:<MODEL_VERSION>`: the tool's own name and the exact model identifier.

```bash
git commit -m "feat: add a maintenance policy" \
  --trailer "Assisted-by: Claude Code:claude-opus-5-5"
```

Add it when the commit is created, and end the PR description with the same trailer, since that description becomes the merge commit body.

### Never name an agent as a co-author

Git matches the trailer token case-insensitively, so `Co-authored-by:` and `Co-Authored-By:` are equally forbidden for an AI agent. Such a trailer shows the agent as a GitHub co-author and implies authorship an AI cannot hold. This rule overrides any harness default to append a co-author line. Co-author trailers that name humans, and the ones GitHub and `renovate[bot]` add themselves, stay as they are.
