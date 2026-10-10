# Agents Agent Guide

Repository-specific conventions for coding agents.

## Repository overview

This repository is a `pnpm` workspace for Publira's maintenance automation: the apps that automate maintenance, and the libraries they share.

`pnpm-workspace.yaml` declares two package groups:

- `apps/*`: deployable applications.
  - `maintenance-bot/`: the maintenance bot, an eve app deployed to Vercel that hosts GitHub-facing maintenance jobs.
- `packages/*`: shared libraries the apps import from the workspace without publishing them.
  - `devcontainer/`: reading Dev Container configurations, editing their lock files, and resolving Features in OCI registries.
  - `github/`: GitHub API access through Octokit.
  - `maintenance-policies/`: the rules that decide what a job does. Pure functions with no I/O.
  - `npm-registry/`: npm registry lookups.
  - `pnpm-workspace/`: reading pnpm workspace files.
  - `tsconfig/`: the TypeScript configuration every package extends.

Add a package only when a concrete responsibility needs one, and keep GitHub, registry, and policy logic in `packages/*` so it stays testable outside the deployed app.

Each app describes itself in its own `README.md`, for the people who run it, and `AGENTS.md`, for agents working on it, with a `CLAUDE.md` that imports the latter. Keep what applies to one app there, and here only what applies to the whole workspace.

### Workspace packages

Each package builds `src/index.ts` into `dist/` with [tsdown](https://tsdown.dev/) and exports only that build, which is how the other Publira repositories ship their packages too. A consumer therefore needs the packages built: the Turborepo tasks run `build` in the dependencies first (`dependsOn: ["^build"]`), and a command run outside Turborepo needs `pnpm turbo run build --filter='./packages/*'` once, and again after a package changes. A package's own tests import its sources and need no build.

tsdown emits the declarations with TypeScript 7, whose API is still experimental, so every build warns about it. The warning is expected.

The code stays within erasable syntax (`erasableSyntaxOnly`), and relative imports name the `.ts` file (`allowImportingTsExtensions`); `@publira/tsconfig` sets both for every package.

Each package has its own `tsconfig.json`, extending `@publira/tsconfig/base.json`, its own `tsdown.config.ts`, and its own `vitest.config.ts`. Versions that several packages share, such as `typescript`, `tsdown`, `vitest`, `zod`, and `@types/node`, live in the `catalog` of `pnpm-workspace.yaml`, and `catalogMode: strict` keeps the packages on them.

The clients of `@publira/github` time out every request and try a failed read again after a server error, a rate limit, or a failed connection (`request-policy.ts`), as `@publira/npm-registry` does for the registry. They never retry a write, which may have been applied before it failed; a job's next run takes it up instead. Do not add retries around them.

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
- `pnpm build`: build the packages with tsdown and each app, the maintenance bot with `eve build`.

An app's own commands are in its `AGENTS.md`.

Run `pnpm check`, `pnpm typecheck`, and `pnpm test` before committing. The lefthook pre-commit hook formats staged files but does not lint or test them.

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
