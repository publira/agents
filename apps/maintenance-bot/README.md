# Maintenance Bot

An [eve](https://eve.dev/) app deployed to Vercel that hosts the jobs that keep Publira's repositories maintained. Jobs that follow fixed rules run as plain code without a model, and the eve agent takes the work that needs judgment.

## Development

Build the packages as the [repository README](../../README.md#development) describes, then start the bot locally from the repository root with `pnpm --filter @publira/maintenance-bot dev`. eve asks for a model connection the first time.

[AGENTS.md](AGENTS.md) describes the bot's conventions and the command-line entries of its jobs.

## GitHub App

The bot acts on repositories as a GitHub App, installed on the repositories it maintains. Register the App with:

- **Webhook URL**: `https://maintenance-bot.publira.dev/github/webhooks`, the production domain, with a random **webhook secret**. Use the custom domain, not a `*.vercel.app` one, which someone else could claim once the project gives it up. Install the App only once the production deployment has the credentials below; until then the route answers `503`. GitHub does not retry a failed delivery, and a delivery can be redelivered by hand only within three days.
- **Repository permissions**:
  - Metadata: read. Required by every App. Also tells whether the reviewer of a precedent can write to its repository, which is what makes them a maintainer: a review's author association reads `CONTRIBUTOR` to the App for a member whose organization membership is private.
  - Contents: read and write. Reads files, creates the branches and commits of maintenance pull requests, commits the synced Dev Container lock files and the regenerated output to Renovate pull requests, and merges the Renovate pull requests the bot auto-merges.
  - Pull requests: read and write. Opens pull requests, submits reviews and minimizes the bot's outdated ones, enables auto-merge or queues a pull request, and adds or removes the `ai-assisted` label.
  - Issues: read and write. Reads an issue's parent and sub-issues, closes an issue whose sub-issues are all closed, and comments on it.
  - Checks: read, and Commit statuses: read. Tell whether a pull request's CI passed.
- **Organization and account permissions**: none.
- **Events**: only those the bot handles; see `src/webhooks/handlers.ts`. GitHub sends installation events regardless. They are now:
  - Issues and Sub-issues: close an issue as completed when all of its sub-issues are closed.
  - Pull request: label a pull request `ai-assisted` when its commits disclose a coding agent.
  - Check suite, Pull request, and Status: commit the regenerated Dev Container lock file to a Renovate pull request that bumps a Feature, commit the regenerated output to one that updates a code generator, approve a Renovate pull request when a maintainer approved and merged the same update in another Publira repository, and auto-merge it when that is on.
- **Where can this App be installed**: only on this account. Install it on selected repositories, not all of them.

The bot reads the App's credentials from three environment variables:

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | The App ID |
| `GITHUB_APP_PRIVATE_KEY` | A private key of the App, in PEM; line breaks may be written as `\n` |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret |

Set the production App's values in the Vercel project's Production environment only, as sensitive variables. For local development, register a separate development App on a test repository, put its values in `.env.local` in this directory, which Git ignores and `eve dev` and the command-line entries load, and forward its webhooks to the local server through a tunnel. `pnpm --filter @publira/maintenance-bot list-app-repositories` checks the credentials. The tests use generated keys and never reach GitHub.

## Operation

### Settings

Environment variables of the Vercel project turn the bot's writes on and off. Each is `true` or `false`; without it, or with it empty, the default applies. Any other value is logged as an error and read as the safe side: a dry run, or auto-merge off. Vercel applies a changed value to the next deployment, so redeploy after changing one.

| Variable | Default | Effect |
| --- | --- | --- |
| `DRY_RUN` | `false` | Every job still evaluates and logs what it would do, but writes nothing to GitHub: no review, minimized review, auto-merge, commit, branch, or pull request. |
| `RENOVATE_AUTO_MERGE` | `false` | Has GitHub merge the Renovate pull requests the bot approved; see below. |

The bot acts only on the repositories the App is installed on. To start on a new feature or more repositories, install the App on a few of them, run with `DRY_RUN=true`, read the logs, and then turn `DRY_RUN` off and widen the installation.

Every write is idempotent. A job checks what is already in place before it writes, so a webhook delivered twice, a redelivery, or the next scheduled run changes nothing that is already done. The requests to GitHub and the npm registry time out, and the reads among them are tried again after a server error, a rate limit, or a failed connection; writes are not, since a failed write may still have been applied. A job that still cannot tell the state of a repository, its CI, or a pull request does nothing, and its next run tries again.

The model is asked only to remove expired `minimumReleaseAgeExclude` entries whose comments the fixed rules cannot sort out. It sees only that block of `pnpm-workspace.yaml`, and it is not asked when no entry has expired. No model takes part in approving, merging, syncing lock files, regenerating output, updating agent skills, closing issues, or labelling pull requests. The agent uses no sandbox: it has no shell or file tools, and `agent/sandbox.ts` keeps eve from creating a Vercel Sandbox. Only the regeneration of generated output and the agent skills update run in one, of their own, because they run third-party commands; see below.

### Logs

The bot writes one JSON object per line to the Vercel project's runtime logs, without tokens, keys, the webhook secret, or file contents. Each line names the `job` (or the `schedule`), the `installation`, the `owner` and `repo`, the `pullRequest`, `dryRun`, and the webhook `delivery` it comes from, where they apply. Beyond those:

- `approve-equivalent-renovate-update`: the `status`; for a skipped pull request, the failed `condition` and its `detail`; for an approval, the `precedent` pull request, the maintainer whose approval of it counts (`precedentApprovedBy`), the `review` with `reviewCreated`, and, once the bot submitted it, how many of its earlier reviews it minimized (`minimizedReviews`) or why it could not (`minimizeError`, `minimizeErrorStatus`, logged as a warning). `modelInvoked` is always `false`.
- `auto-merge-renovate-update`: the decision (`autoMerge`), its reason (`autoMergeReason`), the `mergeMethod`, and what it took back (`autoMergeWithdrew`).
- `close-completed-parent-issue`: the parent `issue` and the closed or removed `subIssue` that led to it, the `status`, the `reason` an issue was left open, the number of `subIssues`, and the `comment` with `commentCreated`. `modelInvoked` is always `false`.
- `label-agent-assisted-pull-request`: the `status`, the number of `commits` it read, and the `reason` it left the label as it is. `modelInvoked` is always `false`.
- `sync-devcontainer-lock-file`: the `status`, the `headSha` it read, the `lockFiles` it compared or committed, the `reason` it left the pull request alone, the `commit`, and whether approval and auto-merge wait for the commit's push (`evaluationDeferred`). `modelInvoked` is always `false`.
- `regenerate-generated-output`: the `status`, the `headSha` it read, the generated `paths` it committed or would, the `ignoredPaths` the command changed outside them, the `reason` it left the pull request alone, the `commit`, and whether approval and auto-merge wait for the commit's push (`evaluationDeferred`). When the sandbox could not fetch the head, install the generators, or run the command, the `step`, the `exitCode`, and the end of the command's `output`. `modelInvoked` is always `false`.
- `remove-expired-release-age-exclusions`: the `status`, the `expired` entries, whether the rules or a model chose the lines (`editedBy`), whether a model was asked in this run (`modelInvoked`, with the `model`), and the `pullRequest` with `pullRequestCreated`.
- `update-agent-skills`: the `status`, the default branch's commit the update ran on (`baseSha`), the `skills` it added, updated, or removed, the `paths` it commits and the `ignoredPaths` it leaves out, whether it committed (`committed`), and the `pullRequest` with `pullRequestCreated`. When the sandbox could not clone the repository or update its skills, the `step`, the `exitCode`, and the end of the command's `output`. `modelInvoked` is always `false`.

### Renovate approval

Each time a Renovate pull request moves to a new head, such as when Renovate rebases it, the bot evaluates the head anew and submits a new approval of it, since an approval is bound to the commit it was submitted for. Once it has submitted one, it minimizes its own reviews submitted before it as outdated, so the timeline shows the latest approval in full and the earlier ones stay readable when expanded. It leaves other people's reviews as they are. A failure to minimize is logged and leaves the approval standing.

### Renovate auto-merge

The bot can also have GitHub merge the Renovate pull requests it approved. This is off unless `RENOVATE_AUTO_MERGE` is `true`. Turning it off leaves approval as it is, and the bot takes back any auto-merge it enabled at its next evaluation, within the hour.

When it is on, the bot enables GitHub's auto-merge for the head it approved, and GitHub then merges the pull request or adds it to the merge queue. If the pull request can already be merged, the bot adds it to the merge queue or merges it at that head. It does this only where:

- the base branch's rulesets require an approving review and dismiss approvals on a push. Classic branch protection is not read, because that needs the Administration permission;
- the repository allows auto-merge; and
- the pull request leaves `.github/workflows/` unchanged, since merging such a change needs the Workflows permission, which the App does not have.

### Dev Container lock files

Renovate's devcontainer manager bumps a Feature's reference in `devcontainer.json` but leaves `devcontainer-lock.json` on the old version, which the Dev Container CLI then rewrites on every build. Each time the bot evaluates a Renovate pull request for approval, whether from a webhook or the hourly sweep, it first compares each `devcontainer.json` it changes (`.devcontainer/devcontainer.json`, `.devcontainer/<name>/devcontainer.json`, or `.devcontainer.json`) with the merge base. For each Feature whose tag changed, it replaces the entry in the lock file beside it with what `devcontainer upgrade` writes: the new reference, the version the Feature's metadata declares, and the digest of its manifest, read anonymously from its registry. The other entries, their order, and the formatting stay, and the bot commits only when the file differs from the branch's, on top of the head and only as a fast-forward. A head that the bot commits to, or would in a dry run, is neither approved nor merged; the commit's push is evaluated instead.

The bot leaves the pull request alone, and logs why, when a Feature was added or removed rather than bumped, its dependencies changed, its registry cannot be read, or the lock file is not as the CLI writes it. Renovate may discard the commit when it rewrites the branch, which the organization's preset lets it do, and the next push brings it back. Approval accepts the bot's signed commit on top of Renovate's, as long as it changes only the lock files beside the configurations the pull request changes.

### Generated output

Renovate updates a code generator's version, such as a pinned `buf` plugin or a tool version in a workflow, but cannot run the generator, so a release that changes the generated code leaves the pull request failing the repository's check of that code. The bot regenerates the output on such a pull request in a repository that declares how in `.github/maintenance-bot/regenerate.yml` on the pull request's base branch; it leaves every other repository alone. publira/publira's declaration:

```yaml
# The files whose change by Renovate calls for a regeneration.
triggers:
  - buf.gen.yaml
  - .github/workflows/ci.yml
# The workflow whose top-level `env` block, read at the pull request's head,
# is passed to `setup` and `command`: the versions CI verifies the output with.
workflowEnv: .github/workflows/ci.yml
# Install the generators. `~/.local/bin` is on the PATH.
setup:
  - curl -fsSL --retry 5 "https://github.com/go-task/task/releases/download/v${TASK_VERSION}/task_linux_amd64.tar.gz" | tar -xz -C "$HOME/.local/bin" task
  - curl -fsSL --retry 5 "https://github.com/sqlc-dev/sqlc/releases/download/v${SQLC_VERSION}/sqlc_${SQLC_VERSION}_linux_amd64.tar.gz" | tar -xz -C "$HOME/.local/bin" sqlc
  - curl -fsSL --retry 5 -o "$HOME/.local/bin/buf" "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-x86_64" && chmod +x "$HOME/.local/bin/buf"
# Regenerate, at the repository's root.
command: task gen
# The generated output: the only paths the bot commits.
paths:
  - server/internal/proto/gen/**
  - server/internal/db/gen/**
  - packages/api-client/src/gen/**
```

A pattern is a path from the root, or a directory and everything under it with a trailing `/**`. `setup` and `workflowEnv` are optional; the paths cannot match anything under `.github/workflows/`, which the App cannot write, so `.github/**` is refused too. The bot reads the declaration from the base branch, so a pull request cannot widen what the bot commits, and an invalid one leaves the pull request alone with the reason in the log.

The bot regenerates when Renovate opens a pull request that changes a trigger, reopens it, or pushes to it, and in the hourly sweep; a check or a status that completes leaves the head as that evaluation found it. An evaluation runs it after the Dev Container lock file sync and before approval. The sweep first regenerates a repository's Renovate pull requests, up to four at a time, and then evaluates them one at a time, except a pull request whose head the bot's commit moved, which its push's evaluation takes up. The setup and the command run the pull request's own code, so they run in a Vercel Sandbox of its own, deleted afterwards, as Bash scripts with `CI=true` and the workflow's `env` values. The sandbox fetches the head alone: anonymously for a public repository, and for a private one with a token that can only read that repository's contents. It holds no other credential, and the bot writes the commit from the app runtime.

The bot commits the changes under the generated paths, with their file modes, on top of the head and only as a fast-forward, with the subject `chore(gen): regenerate for the updated generator versions`, and logs any other path the command changed. It writes nothing when the output is current, and leaves a head that is its own regeneration commit alone without starting a sandbox. When the fetch, a setup command, or the command fails, it leaves the pull request alone and logs why; the repository's CI still rejects stale output. A head that the bot commits to, or would in a dry run, is neither approved nor merged; the commit's push is evaluated instead. Renovate may discard the commit when it rewrites the branch, and the next evaluation puts it back. Approval accepts the bot's signed commit as long as it changes only the paths the base branch declares.

Each sandbox lives at most 240 seconds, its fetch at most 60, each setup command at most 120, and the command at most 120, within the 300 seconds the Vercel Function of a webhook delivery or the sweep runs. Fetching publira/publira's head, installing its three generators, and running `task gen` took about 10 seconds in Amazon Linux 2023, the Vercel Sandbox's system. Running up to four at once keeps a regeneration that takes long, or times out every hour, from leaving the next pull requests too little of the sweep's time.

### Agent skills updates

Every Monday at 00:00 UTC the bot refreshes the agent skills vendored in each repository it is installed on whose default branch has a `skills-lock.json` at its root. A repository opts in by committing that file, which `npx skills add` writes.

The update runs `npx -y skills@<version> update -p -y`, which downloads the skills from their sources and runs third-party code, so it runs in a Vercel Sandbox of its own, which is deleted afterwards. The sandbox clones the default branch shallowly: anonymously for a public repository, and for a private one with an installation token that can only read that repository's contents and expires within an hour. It holds no other credential. The bot reads the changed files back from the sandbox and writes the commit and the pull request itself, from the app runtime. The skills CLI's version is pinned in `src/jobs/update-agent-skills.ts`, and Renovate updates it.

The bot commits only the changes under `.agents/skills/`, `.claude/skills/`, and `skills-lock.json`, with their file modes, so symbolic links and executables stay as they are, and logs any other path the update touched. It commits them to the `maintenance-bot/update-agent-skills` branch on top of the default branch and opens a pull request titled `chore(skills): update agent skills`, which lists the changed skills from the lock file and asks the reviewer to read the instruction changes. It neither approves nor merges the pull request: a skill changes what agents do, so a person reviews it.

When the update changes nothing, the bot writes nothing. While the open pull request holds the same skill files, it leaves the branch as it is, even once the default branch moved on; when the skills changed upstream again, it moves the branch to a new commit on the current default branch. When the clone or the update fails, it leaves the repository alone and logs why.

The schedule runs in a Vercel Function, which the project allows 300 seconds by default, and updates the repositories at the same time. Each sandbox lives at most 240 seconds, its clone at most 60, and the update at most 120; a shallow clone and an update of publira/publira took about 30 seconds together. Vercel Sandbox itself allows a sandbox up to 24 hours on the team's plan. On Vercel the sandbox authenticates with the project's OIDC token, which needs no setting.

### Closing completed issues

The bot closes an issue as completed once it has at least one sub-issue and all of them are closed, whatever their reason, and comments that it did so. It decides from the sub-issue structure alone, not from labels. It evaluates the parent when a sub-issue is closed and when a sub-issue is removed from it. The bot's own close of a parent is delivered as an event too, so the parent's parent is evaluated in turn.

A sub-issue can live in another repository than its parent. The bot closes a parent only in a repository the App is installed on. It leaves an issue that is already closed as it is, so one reopened by hand stays open until a sub-issue is closed or removed again. The exception is an issue the bot closed itself: if its comment is missing, such as after posting it failed, the next evaluation of the issue posts it.

### Labelling agent-assisted pull requests

The bot gives a pull request the `ai-assisted` label when any of its commits carries an `Assisted-by:` trailer, matched case-insensitively as trailer tokens are, and takes the label off when none does, so a force-push that drops the agent commits drops the label too. GitHub lists at most 250 commits of a pull request, so the bot keeps the label on a longer one whose listed commits have no trailer. It evaluates a pull request when it is opened, marked ready for review, or pushed to, and leaves a draft alone until it is ready. It reads the labels from the API rather than from the event, and adds the label only in a repository that defines it and has not archived it.
