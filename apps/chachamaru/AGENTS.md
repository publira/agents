# Chachamaru Agent Guide

Conventions for Chachamaru, the maintenance bot, on top of the repository's [AGENTS.md](../../AGENTS.md). Paths are relative to `apps/chachamaru/`, and [README.md](README.md) describes the bot for its operators.

## Overview

Chachamaru is an eve app deployed to Vercel. It hosts GitHub-facing maintenance jobs and uses eve where agentic behavior helps, while deterministic jobs run without invoking a model. `agent/` is the eve agent (model, instructions, channels, tools); `src/jobs/` holds the deterministic jobs.

## Deterministic jobs and the agent

A job is a plain async function in `src/jobs/`. It takes its clients (an Octokit, registry options, the current time, the model step it may ask) as arguments, so tests pass fakes and nothing in it starts an eve session or calls a model of its own accord. Two things can call it:

- an eve tool in `agent/tools/`, when the model should decide when to run it;
- an eve schedule handler (`defineSchedule` with `run`), which can call the job directly instead of sending a prompt to the agent.

Keep the decision logic in the job and the packages, not in the tool or the prompt.

## Settings and logs

`src/settings.ts` reads the deployment's switches. Every job that writes takes a `dryRun` option and honors `DRY_RUN` by evaluating without writing. Only a dangerous operation, such as having GitHub merge a pull request (`RENOVATE_AUTO_MERGE`), gets a switch of its own, with the README's settings table updated; a job whose writes a maintainer still acts on, such as a review or a pull request, does not. An invalid value reads as the safe side, so keep the default of a new switch on that side.

Jobs log one JSON line per decision through `src/log.ts`. Name the `job` and bind the fields that identify the work with `withFields`, such as the installation and the webhook delivery, and log why a job skipped, what it wrote, and whether a model was asked (`modelInvoked`), so that a decision can be audited from the logs alone. The README lists the fields.

## Commands

Run this from the repository root, once the packages are built:

- `pnpm --filter @publira/chachamaru dev`: start the bot locally with `eve dev`, which opens eve's terminal UI. It needs a model connection, which eve asks for on first start; `--no-ui` starts the server alone.

## eve

eve is in preview and changes quickly. Read the docs bundled with the installed version in `node_modules/eve/docs/` (start with `README.md`) before authoring tools, channels, schedules, or deployment settings, rather than relying on memory. `pnpm exec eve info` in this directory shows what eve discovered.

The agent's model is an AI Gateway model ID in `agent/agent.ts`. On Vercel the deployment reaches the gateway through the project's OIDC token; locally, `eve dev` asks for a connection. A job that needs a model for one narrow step calls it with the AI SDK outside an agent session, as `src/exclusion-editor.ts` does; keep its model ID in step with the agent's. A model that has to work on a repository's files, as `src/lint-findings-fixer.ts` does on the lint findings the automatic fix leaves, runs in a loop of tool calls with the AI SDK too, with `bash`, `read_file`, and `write_file` tools that run in the job's sandbox. The job, not the model, then checks the result and decides what it commits; keep that decision in the job and the policies.

The `eve` channel accepts Vercel OIDC and, under `eve dev`, localhost. Add an authenticator before exposing a route to anyone else.

The agent uses no sandbox. `agent/agent.ts` sets `defaultTools: false`, which leaves the agent only its own tools, and `agent/sandbox.ts` replaces eve's default sandbox, which is a Vercel Sandbox on Vercel, with a provider that prepares nothing and refuses to start. Add a sandbox only for a feature that needs one, and say why in the pull request.

A job that has to run a third-party tool, such as the skills update running `npx skills update`, the regeneration running a repository's own generators, or the lint fix running a repository's ultracite, does so in a Vercel Sandbox it creates through `src/sandbox-runner.ts`, not in eve's: eve opens a sandbox only for an agent session, and a schedule handler or a webhook handler that calls a job starts none. The job takes the runner as an argument, so tests run its commands on a local repository instead, and reads back what changed through `src/sandbox-git.ts`. The sandbox gets no credential of the App beyond a token that can only read the one repository, and only for a private repository; the job writes the commit and the pull request from the app runtime.

The model that fixes the lint findings works in the lint fix's sandbox for the same reason: eve opens a sandbox only for an agent session, and a job can start no session with a declared subagent. Before the model starts, the job cuts the sandbox off from the network (`Sandbox.denyNetwork`); the model's calls run in the app runtime, so the sandbox needs none. Give the model only what the bot produces, such as a command's output or a diff, never text someone wrote on GitHub.

## Deployment

The Vercel project's Root Directory is `apps/chachamaru`.

A Vercel build has eve prepare its sandbox templates, which needs the project's OIDC token even for the bot's empty one, so `eve build` with `VERCEL=1` fails outside Vercel unless the directory is linked (`eve link`) and its environment pulled.

## GitHub authentication

The bot authenticates as the Publira GitHub App. `@publira/github` signs the App's JWT and requests installation tokens (`createGitHubApp`); `src/github-app.ts` reads its credentials from `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`. Without them the bot still starts, its tools read public repositories anonymously, and the webhook route answers 503. The README lists the App's permissions and how to configure each environment.

Do not give the deployed bot a personal access token or a `GITHUB_TOKEN` variable: it would act as a person, with that person's access, instead of as the App. Do not log a token, a key, the webhook secret, or a whole payload; pass the log the fields it needs one by one.

Request a new App permission only for a concrete API call that needs it, and say which in the pull request. Jobs cannot change `.github/workflows/`, which would need the Workflows permission.

### Renovate update approval

The approval job (`src/jobs/approve-equivalent-renovate-update.ts`) identifies an update by the comments the organization's Renovate preset writes at the top of each pull request body through `prHeader`, one `<!-- publira-renovate-update ... -->` per update, and never by the visible table or the title. None of Renovate's default output carries every field the job needs: the title has no from-version, the table varies its columns between pull requests and never names the manager, which the review reports, and the `renovate-debug` comment holds no update data. A repository whose Renovate configuration sets its own `prHeader` gets no such comments, and its pull requests are not approved. Change the comment's fields in the preset and in `@publira/maintenance-policies` together; the parser refuses a field it does not know.

The bot's own commits that sync the Dev Container lock files (`src/jobs/sync-devcontainer-lock-file.ts`), regenerate generated output (`src/jobs/regenerate-generated-output.ts`), and apply the automatic lint fixes (`src/jobs/apply-lint-fixes.ts`) do not make a pull request foreign: `evaluateRenovateCommits` accepts a verified commit by the bot that changes only the lock files beside the `devcontainer.json` files the pull request changes, or only the generated paths that `.chachamaru/regenerate.yml` declares on the base branch, or that carries the lint fix's subject and changes no lock file, `package.json`, or file under `.github/` (`isLintFixRefusedPath`). Keep the job's refusal and the policy's on that one function. Any other commit by the bot still counts as foreign, and so does, whatever it changes, its commit of a model's fixes of the lint findings (`LINT_FINDINGS_FIX_COMMIT_SUBJECT`): a maintainer reviews code a model wrote.

A precedent has to match every field except the manager. The datasource, the package name, the versions, and the digests identify the release that a maintainer vouched for. The manager only names the kind of file Renovate rewrote, and the same manager already rewrites different files in each repository. The commits and CI of the pull request itself guard what differs. Keep the manager out of the fingerprint unless a concrete case shows two different releases that only the manager tells apart.

An approval is bound to its commit, and the API changes neither a review's commit nor its state, so every new head gets a new `APPROVE` review. Only the run that submitted it (`created: true`), with the head unchanged afterwards, then minimizes the bot's own reviews submitted before that approval through `minimizeOutdatedReviews` from `@publira/github`, with the `OUTDATED` classifier. It compares review IDs rather than commits, so a concurrent run's approval of a newer head stays expanded. Do not rewrite an earlier review's body instead: it records what the bot checked when it approved that commit. A failed minimization is logged and not retried; the approval stands.

### Renovate update auto-merge

The auto-merge job (`src/jobs/auto-merge-renovate-update.ts`) runs after the approval job on every evaluated Renovate pull request, but it is a separate decision: `canAutoMerge` in `@publira/maintenance-policies`. `RENOVATE_AUTO_MERGE` turns it on and off without affecting approval. A decision applies to one head only. It requires the bot's own approval of the head and evaluates the approval policy again on that head. It passes the head to GitHub (`expectedHeadOid`, or `sha` for a direct merge), so GitHub refuses the merge for any other head. Every evaluation makes the decision again, because GitHub does not enforce the approval policy. When the head moves, the approval is dismissed, or the decision no longer holds, the bot takes back its auto-merge or queue entry; it detects this by comparing when auto-merge was enabled with when the head was approved. The required checks and rulesets stay GitHub's to enforce. Keep the decision deterministic: no model takes part in it.

### Webhooks

GitHub delivers the App's events to `POST /github/webhooks` (`agent/channels/github-webhooks.ts`). The route verifies the signature, answers at once, and runs the handler for the event, from `src/webhooks/handlers.ts`, in the background. Subscribe the App to an event only once it has a handler.

GitHub can deliver an event twice, and a failed delivery can be redelivered, and the bot has no database to remember deliveries in. A handler, like a scheduled job, therefore checks what is already in place before it writes: write through `commitToBranch`, `ensurePullRequest`, and `ensureReview` from `@publira/github`, which leave a change that is already there as it is.
