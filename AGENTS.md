# Agents Agent Guide

Repository-specific conventions for coding agents.

## Repository overview

This repository is a `pnpm` workspace for Publira's maintenance automation. Its first application is the maintenance bot: a Vercel deployment that hosts GitHub-facing maintenance jobs and uses eve where agentic behavior helps, while deterministic jobs run without invoking a model.

`pnpm-workspace.yaml` declares two package groups:

- `apps/*`: deployable applications. `apps/maintenance-bot/` is planned.
- `packages/*`: shared libraries the apps import from the workspace without publishing them. Planned are `github/` (GitHub API access), `maintenance-policies/` (the rules that decide what a job does), `npm-registry/` (npm registry lookups), and `pnpm-workspace/` (reading and editing pnpm workspace files).

Neither directory exists yet; #2 sets them up. Add a package only when a concrete responsibility needs one, and keep GitHub, registry, and policy logic in `packages/*` so it stays testable outside the deployed app.

## Toolchain

The root `package.json` pins the toolchain:

- Node.js through `devEngines.runtime`. With `onFail: "download"`, pnpm downloads that version when the active one differs.
- pnpm through `packageManager`.

Change these versions in `package.json` only; do not add `.nvmrc`, `.node-version`, or `engines` copies of them.

## Development commands

- `pnpm install`: install the workspace dependencies. The Dev Container runs it on creation. Commit `pnpm-lock.yaml` with any dependency change; `pnpm install --frozen-lockfile` must succeed.

Type checking, tests, lint and format, and running the app locally arrive with #2; document each command here once it exists.

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
