# Chachamaru

An [eve](https://eve.dev/) app deployed to Vercel that hosts the jobs that keep Publira's repositories maintained. Jobs that follow fixed rules run as plain code without a model, and the eve agent takes the work that needs judgment.

## Development

Build the packages as the [repository README](../../README.md#development) describes, then start the bot locally from the repository root with `pnpm --filter @publira/chachamaru dev`. eve asks for a model connection the first time.

[AGENTS.md](AGENTS.md) describes the bot's conventions.

## GitHub App

The bot acts on repositories as a GitHub App, installed on the repositories it maintains. Register the App with:

- **GitHub App name**: `Chachamaru Bot`. GitHub derives the slug, `chachamaru-bot`, and the bot's login, `chachamaru-bot[bot]`, from the name.
- **Webhook URL**: `https://chachamaru.publira.dev/github/webhooks`, the production domain, with a random **webhook secret**. Use the custom domain, not a `*.vercel.app` one, which someone else could claim once the project gives it up. Install the App only once the production deployment has the credentials below; until then the route answers `503`. GitHub does not retry a failed delivery, and a delivery can be redelivered by hand only within three days.
- **Repository permissions**:
  - Metadata: read. Required by every App. Also tells whether the reviewer of a precedent can write to its repository, which is what makes them a maintainer: a review's author association reads `CONTRIBUTOR` to the App for a member whose organization membership is private.
  - Contents: read and write. Reads files, creates the branches and commits of maintenance pull requests, commits the synced Dev Container lock files, the regenerated output, and the lint fixes to Renovate pull requests, and merges the Renovate pull requests the bot auto-merges.
  - Pull requests: read and write. Opens pull requests, submits reviews and minimizes the bot's outdated ones, enables auto-merge or queues a pull request, adds or removes the `ai-assisted` label, and comments on a Renovate pull request whose lint findings a model could not fix.
  - Issues: read and write. Reads an issue's parent and sub-issues, closes an issue whose sub-issues are all closed, and comments on it.
  - Checks: read, and Commit statuses: read. Tell whether a pull request's CI passed.
- **Organization and account permissions**: none.
- **Events**: only those the bot handles; see `src/webhooks/handlers.ts`. GitHub sends installation events regardless. They are now:
  - Issues and Sub-issues: close an issue as completed when all of its sub-issues are closed.
  - Pull request: label a pull request `ai-assisted` when its commits disclose a coding agent.
  - Check suite, Pull request, and Status: commit the regenerated Dev Container lock file to a Renovate pull request that bumps a Feature, commit the regenerated output to one that updates a code generator, commit the automatic lint fixes, or a model's fixes of the findings they leave, to one whose checks failed, approve a Renovate pull request when a maintainer approved and merged the same update in another Publira repository, and auto-merge it when that is on.
- **Where can this App be installed**: only on this account. Install it on selected repositories, not all of them.

The bot reads the App's credentials from three environment variables:

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | The App ID |
| `GITHUB_APP_PRIVATE_KEY` | A private key of the App, in PEM; line breaks may be written as `\n` |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret |

Set the production App's values in the Vercel project's Production environment only, as sensitive variables. For local development, register a separate development App on a test repository, put its values in `.env.local` in this directory, which Git ignores and `eve dev` loads, and forward its webhooks to the local server through a tunnel. The tests use generated keys and never reach GitHub.

## Operation

### Settings

Environment variables of the Vercel project turn the bot's writes on and off. Each is `true` or `false`; without it, or with it empty, the default applies. Any other value is logged as an error and read as the safe side: a dry run, or auto-merge off. Vercel applies a changed value to the next deployment, so redeploy after changing one.

| Variable | Default | Effect |
| --- | --- | --- |
| `DRY_RUN` | `false` | Every job still evaluates and logs what it would do, but writes nothing to GitHub: no review, minimized review, auto-merge, commit, branch, or pull request. |
| `RENOVATE_AUTO_MERGE` | `false` | Has GitHub merge the Renovate pull requests the bot approved; see below. |

The bot acts only on the repositories the App is installed on. To start on a new feature or more repositories, install the App on a few of them, run with `DRY_RUN=true`, read the logs, and then turn `DRY_RUN` off and widen the installation.

Every write is idempotent. A job checks what is already in place before it writes, so a webhook delivered twice, a redelivery, or the next scheduled run changes nothing that is already done. The requests to GitHub and the npm registry time out, and the reads among them are tried again after a server error, a rate limit, or a failed connection; writes are not, since a failed write may still have been applied. A job that still cannot tell the state of a repository, its CI, or a pull request does nothing, and its next run tries again.

A model takes part in two jobs only. It removes expired `minimumReleaseAgeExclude` entries whose comments the fixed rules cannot sort out; it sees only that block of `pnpm-workspace.yaml`, and it is not asked when no entry has expired. And it fixes the [lint findings](#findings-the-automatic-fix-leaves) that the automatic lint fixes leave on a Renovate pull request, in that fix's sandbox, cut off from the network; it sees only the check's output and the automatic fix's diff, and the bot checks its changes itself before it commits them. No model takes part in approving, merging, syncing lock files, regenerating output, the automatic lint fixes, updating agent skills, closing issues, or labelling pull requests. The agent uses no sandbox: it has no shell or file tools, and `agent/sandbox.ts` keeps eve from creating a Vercel Sandbox. Only the regeneration of generated output, the lint fixes, and the agent skills update run in one, of their own, because they run third-party commands; see below.

### Logs

The bot writes one JSON object per line to the Vercel project's runtime logs, without tokens, keys, the webhook secret, or file contents. Each line names the `job` (or the `schedule`), the `installation`, the `owner` and `repo`, the `pullRequest`, `dryRun`, and the webhook `delivery` it comes from, where they apply. Beyond those:

- `apply-lint-fixes`: the `status`, the `headSha` it read, the `paths` it committed or would, the `reason` it left the pull request alone or why the automatic fix was not enough, whether `ultracite check` passed after the fix (`checkPassed`) and the end of its `output` when it did not, the `refusedPaths` that kept it from committing, the `commit`, and whether approval and auto-merge wait for the commit's push (`evaluationDeferred`). When the sandbox could not fetch the head or install, or a tool was killed during the check or the fix, the `step`, the `exitCode`, the start and the end of the command's `output`, and, for a killed tool, which one and by which signal (`reason`); when the model ran before a tool was killed in the check after its changes, the `model`, `modelStopped`, and `modelPaths` fields below as well. Whether a model was asked to fix the findings the automatic fix left (`modelInvoked`), with the `modelReason` when the automatic fix left findings but the sandbox had no time left for the model; when it was asked, the `model`, whether it was stopped before it finished (`modelStopped`) and by what (`modelStopReason`: the `deadline`, its number of `steps`, or the `time` it may keep starting steps), how many steps it finished (`modelSteps`), the start of its last reply when it finished on its own (`modelReply`), the tools it called, in order, with each command's exit code but not their input or output (`modelToolCalls`), and the model calls that failed, with their status, whether or not they were made again (`modelFailedCalls`), the last three also when its run failed, whether `ultracite check` passed after its changes (`modelCheckPassed`), the paths its changes and the automatic fix's change against the head (`modelPaths`), why the bot did not commit them (`modelReason`), with the `modelRefusedPaths` and the `suppressions`, as `path:line`, that refused them, or the error its run failed with (`modelError`), and the `comment` with `commentCreated`.
- `approve-equivalent-renovate-update`: the `status`; for a skipped pull request, the failed `condition` and its `detail`; for an approval, the `precedent` pull request, the maintainer whose approval of it counts (`precedentApprovedBy`), the `review` with `reviewCreated`, and, once the bot submitted it, how many of its earlier reviews it minimized (`minimizedReviews`) or why it could not (`minimizeError`, `minimizeErrorStatus`, logged as a warning). `modelInvoked` is always `false`.
- `auto-merge-renovate-update`: the decision (`autoMerge`), its reason (`autoMergeReason`), the `mergeMethod`, and what it took back (`autoMergeWithdrew`).
- `close-completed-parent-issue`: the parent `issue` and the closed or removed `subIssue` that led to it, the `status`, the `reason` an issue was left open, the number of `subIssues`, and the `comment` with `commentCreated`. `modelInvoked` is always `false`.
- `label-agent-assisted-pull-request`: the `status`, the number of `commits` it read, and the `reason` it left the label as it is. `modelInvoked` is always `false`.
- `sync-devcontainer-lock-file`: the `status`, the `headSha` it read, the `lockFiles` it compared or committed, the `reason` it left the pull request alone, the `commit`, and whether approval and auto-merge wait for the commit's push (`evaluationDeferred`). `modelInvoked` is always `false`.
- `regenerate-generated-output`: one line for each [target](#several-targets) the pull request triggers, naming the `target`, or one line without it for a pull request the job left alone. The `status`, the `headSha` it read, the target's generated `paths` it committed or would, the `ignoredPaths` its command changed outside them, the `reason` it left the pull request or the target alone, the `commit`, and whether approval and auto-merge wait for the commit's push (`evaluationDeferred`). When the sandbox could not fetch the head, install the generators, or run the command, the `step`, the `exitCode`, and the end of the command's `output`; when the target's regeneration threw, such as when no sandbox could start, the `error`, logged as an error. `modelInvoked` is always `false`.
- `remove-expired-release-age-exclusions`: the `status`, the `reason` a repository was skipped, such as a default branch that does not exist yet or has no `pnpm-workspace.yaml`, the `expired` entries, whether the rules or a model chose the lines (`editedBy`), whether a model was asked in this run (`modelInvoked`, with the `model`), and the `pullRequest` with `pullRequestCreated`.
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

Renovate updates a code generator's version, such as a pinned `buf` plugin or a tool version in a workflow, but cannot run the generator, so a release that changes the generated code leaves the pull request failing the repository's check of that code. The bot regenerates the output on such a pull request in a repository that declares how in `.chachamaru/regenerate.yml` on the pull request's base branch; it leaves every other repository alone. publira/publira's declaration:

```yaml
# yaml-language-server: $schema=https://chachamaru.publira.dev/schemas/regenerate/v1.json
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

A pattern is a path from the root, or a directory and everything under it with a trailing `/**`. `setup`, `workflowEnv`, and the [time limits](#time-limits) are optional; the paths cannot match anything under `.github/workflows/`, which the App cannot write, so `.github/**` is refused too. The bot reads the declaration from the base branch, so a pull request cannot widen what the bot commits, and an invalid one leaves the pull request alone with the reason in the log.

The bot serves the declaration's JSON Schema at `https://chachamaru.publira.dev/schemas/regenerate/v1.json`, from the deployment that parses the declaration. With the `yaml-language-server` comment at the top, as above, an editor completes and validates the file, and a CI tool such as `check-jsonschema` can check it. JSON Schema cannot express the rules for the patterns, the paths under `.github/workflows/`, the [time limits](#time-limits)' total, or how the [targets](#several-targets)' paths and triggers may meet, so the schema states them in its descriptions, and the bot's parser stays the authority. `v1` is the schema's major version, raised only for a change that makes a valid declaration invalid, such as a removed or renamed field, so a declaration keeps the version it was written for.

#### Several targets

A repository whose generated output comes from more than one toolchain declares each as a named target under `targets`, with the fields above:

```yaml
targets:
  codegen:
    triggers:
      - buf.gen.yaml
      - .github/workflows/ci.yml
    workflowEnv: .github/workflows/ci.yml
    setup:
      - ...
    command: task gen
    paths:
      - server/internal/proto/gen/**
      - server/internal/db/gen/**
      - packages/api-client/src/gen/**
  ios-packages:
    triggers:
      - mobile/pubspec.yaml
      - mobile/pubspec.lock
    command: ...
    paths:
      - mobile/ios/Runner.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
      - mobile/ios/Runner.xcworkspace/xcshareddata/swiftpm/Package.resolved
```

A target's name is lowercase letters and digits, joined by single hyphens. A pull request runs every target whose triggers Renovate's commits change, each in a sandbox of its own and at the same time, and no other. Each target contributes only its own paths to the commit, so no two targets may declare paths that can match the same file, such as `gen/**` and `gen/api/**`. No target's triggers may match another target's paths either: the bot reads the triggers from Renovate's commits, never from its own, so a target triggered by another's output would never run. Run a generator that feeds another in the same target's command instead. A declaration that breaks either rule is invalid. A declaration without `targets` is read as one target named `default`.

The bot regenerates when Renovate opens a pull request that changes a trigger, reopens it, or pushes to it, and in the hourly sweep; a check or a status that completes leaves the head as that evaluation found it. An evaluation runs it after the Dev Container lock file sync and before approval. The sweep first regenerates a repository's Renovate pull requests and applies the [automatic lint fixes](#lint-fixes) to them, up to four pull requests at a time, and then evaluates them one at a time, except a pull request whose head the bot's commit moved, which its push's evaluation takes up. The setup and the command run the pull request's own code, so they run in a Vercel Sandbox of its own, deleted afterwards, as Bash scripts with `CI=true` and the workflow's `env` values. The sandbox fetches the head alone: anonymously for a public repository, and for a private one with a token that can only read that repository's contents. It holds no other credential, and the bot writes the commit from the app runtime.

The bot commits the changes under each target's generated paths, with their file modes, in one commit on top of the head and only as a fast-forward, with the subject `chore(gen): regenerate for the updated generator versions`, each target's name and command in the body, and a `Regenerated-target` trailer for each target it completed, whose output it commits or found current; it logs any other path a target's command changed. It writes nothing when the output is current. On a head that is its own regeneration commit, it regenerates only the targets that the regeneration commits on top of Renovate's do not name, and starts no sandbox when none remain; a commit from before targets, which names none, completed only the target named `default`, as a declaration without `targets` is read. When the fetch, a setup command, or the command of a target fails, it leaves that target's output alone and logs why, still commits the other targets' output, and tries the failed target again in a later evaluation, such as the hourly sweep; the repository's CI still rejects stale output meanwhile. A head that the bot commits to, or would in a dry run, is neither approved nor merged; the commit's push is evaluated instead. Renovate may discard the commit when it rewrites the branch, and the next evaluation puts it back. Approval accepts the bot's signed commit as long as it changes only the paths of the targets the base branch declares whose triggers Renovate's commits change, even when the bot restored such a trigger and the pull request's diff no longer lists it.

#### Time limits

Each setup command runs at most `setupTimeout` seconds and the command at most `timeout`, both 120 unless the declaration, or the target, sets them, in whole seconds. A repository whose generators take longer to install or to run declares what they need:

```yaml
# Each setup command may run 180 seconds, and the command 300.
setupTimeout: 180
timeout: 300
```

Together they may take at most 480 seconds, `timeout` plus `setupTimeout` once for each setup command; publira/publira's three setup commands and its command reach that with the defaults. A declaration over it is invalid, and the reason in the log names the field. The sandbox lives as long as they and the Git commands around them may run, with 120 seconds more to fetch and check out the head and 90 to read the output back, so at most 690 seconds, within the 800 seconds the project allows the Vercel Function of a webhook delivery or the sweep. Fetching publira/publira's head, installing its three generators, and running `task gen` took about 10 seconds in Amazon Linux 2023, the Vercel Sandbox's system. The limits apply to each target on its own, since the targets run at the same time. Running up to four pull requests at once keeps a regeneration that takes long, or times out every hour, from leaving the next pull requests too little of the sweep's time.

### Lint fixes

An update of a linter or a formatter, or of a plugin the linter loads, can change what a repository's lint check accepts, so the Renovate pull request fails until someone applies the fix. A maintainer who commits it marks the branch as modified, and Renovate stops updating it; the bot's commit does not, because the organization's Renovate preset ignores the bot as an author. The bot applies the fix on a Renovate pull request in a repository whose root `package.json` at the pull request's head lists `ultracite` in `dependencies` or `devDependencies`, and whose `packageManager` names pnpm or npm. The repository declares nothing else.

The bot starts when a check run or a commit status on the head completed with a failure: when a check suite or a status of a Renovate branch fails, and in the hourly sweep. Which check failed does not matter, since check names differ between repositories. A pull request whose checks pass, or are still running, starts no sandbox.

In a Vercel Sandbox of its own, deleted afterwards, with four vCPUs and the 8 GB of memory they bring, the bot checks out the head, installs the dependencies with `pnpm install --frozen-lockfile` or `npm ci`, and runs `ultracite check` through `pnpm exec` or `npm exec`, with `CI=true`. When the check passes, another check failed, and the bot writes nothing. Otherwise it runs `ultracite fix` and `ultracite check` again. `ultracite fix` exits with 1 when findings remain that it does not fix, so only another exit code counts as a failed fix. ultracite also exits with 1 when a tool it runs is killed by a signal, such as oxlint aborting on a panic, and says so in its output, as `Error: Oxlint was killed by signal SIGABRT`. The bot reads that from the output of every check and of the fix and treats the command as failed, whatever its exit code, since what the tool would have found is unknown: it writes nothing, asks no model, and logs the tool and the signal. The sandbox fetches the head as the regeneration's does, and holds no other credential.

The bot commits the files Git tracks that the fix changed, on top of the head and only as a fast-forward, with the subject `chore(lint): apply automatic fixes for the updated lint tools`, also when the check still fails after the fix and the bot does not commit a [model's fix](#findings-the-automatic-fix-leaves) of what remains. It refuses the whole fix, and logs the paths, when it changes a lock file (`pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`), a `package.json`, or a file under `.github/`, and when the install or the first check changed a file Git tracks, such as through a lifecycle script, since the commit could not tell that change from the fix's. When the fix changes nothing and the check still fails, or when a check fails on a head that is the bot's own commit of lint fixes, automatic or a model's, the automatic fix is not enough, and the bot logs it as `unfixed` without running the fix again on that head. It leaves the pull request alone, and logs why, when the fetch or the install fails, or a tool is killed during the check or the fix; the log keeps the start of the command's output, where the tool's own message is, as well as its end. A head that the bot commits to, or would in a dry run, is neither approved nor merged; the commit's push is evaluated instead. Renovate may discard the commit when it rewrites the branch, and the next evaluation puts it back.

A pull request that fails for a reason other than lint starts a sandbox at each evaluation of its head, from a failed check suite or status and then from each hourly sweep, and writes nothing. Approval accepts the bot's signed commit with this subject as long as it changes none of the refused paths, and every check on the head still has to pass.

#### Findings the automatic fix leaves

A rule without an automatic fix, or one whose fix ultracite does not apply on its own, leaves findings that someone has to fix in the code. When `ultracite check` still fails after the automatic fix, the bot has a model fix them in the same sandbox, once for each head. It first cuts the sandbox off from the network: fixing and checking need none, and the model's calls run in the app runtime, not in the sandbox. The model gets only what the bot produces: the check's command and the end of its output, and the diff the automatic fix made against the head. Nothing anyone wrote on the pull request reaches it: not its title or body, the release notes, the commit messages, or the comments. It works on the checkout through three tools that run in the sandbox, `bash`, `read_file`, and `write_file`. Codex models edit files by running `apply_patch` with a patch in Codex's format, a command bash does not have, so the `bash` tool applies such a command's patch itself; a patch that does not apply changes nothing, and one that adds, deletes, or renames a file is refused. The model is `openai/gpt-5.1-codex-mini`, through AI Gateway: the fixes are many small, bounded coding tasks, each within the time the sandbox has left, and the bot checks every result itself. `src/models.ts` names it, with the agent's model.

Afterwards the bot, not the model, removes the files Git does not track that the model wrote, since the commit would leave them out, runs `ultracite fix` on the files the model changed, so that their formatting is the formatter's rather than the model's, runs `ultracite check`, and reads the diff against the head. It commits the model's changes together with the automatic fix's, on top of the head and only as a fast-forward, with the subject `chore(lint): fix findings for the updated lint tools` and the trailer `Assisted-by: Chachamaru:<model>`, which gets the pull request labelled `ai-assisted`, only when the check passes and the diff

- changes no lock file, `package.json`, file under `.github/`, or lint configuration (`oxlint.config.*`, `oxfmt.config.*`, `.oxlintrc*`, `.oxfmtrc*`, `.prettierignore`), and
- adds no line that turns a finding off: `eslint-disable`, `oxlint-disable`, `oxfmt-ignore`, `prettier-ignore`, `biome-ignore`, `@ts-ignore`, `@ts-expect-error`, or `@ts-nocheck`.

Otherwise, and when the model's run fails, such as on an error from AI Gateway, it commits the automatic fix alone, as above, and comments on the pull request once for the head, with the reason and the end of the check's output after the automatic fix, so a maintainer sees from the pull request that it needs them. The comment also records the attempt: the bot does not give the model a head with that comment again, or a head that is the model's commit. A tool killed during the fix or the check after the model's changes fails the job instead, as during the checks before: the bot commits nothing, not the automatic fix either, and does not comment, so the head does not count as tried; the log still says the model ran, and what it changed. When the steps before the model took so long that its time is up before it starts, the bot does not ask it: it commits the automatic fix alone, comments that it had no time left to ask a model, which records the attempt as above, and logs that the model was not invoked and why. Approval never accepts the model's commit, so the bot neither approves nor auto-merges a pull request with one; a maintainer reviews it. In a dry run, the model still runs, and the bot logs what it would commit, without commenting.

The sandbox lives at most 480 seconds, within the 800 seconds the project allows the Vercel Function of a webhook delivery or the sweep; its fetch takes at most 60, the install at most 120, and each run of ultracite at most 120. With four vCPUs, fetching publira/publira's head and installing its dependencies took about 10 seconds, and each run of ultracite 51 to 64, so the three runs before the model leave it its whole time. The model takes at most 40 steps, and starts none after 90 seconds. Each step is a request to AI Gateway, whose free tier lets the team make 5 a minute to the model, so a run usually has to wait: a request refused for the rate limit is made again once AI Gateway says it may be, however long that is, until the time the model has to be done by, rather than failing the run. It has to be done 165 seconds before the sandbox stops, which leaves the bot the time to run `ultracite fix` on the files it changed, for at most 30 seconds, and to check its changes: a model call or a command of the model still running then is cut off, and what the model changed by then is checked like a finished fix. A run cut off before the model's first step is done counts as failed.

### Agent skills updates

Every Monday at 00:00 UTC the bot refreshes the agent skills vendored in each repository it is installed on whose default branch has a `skills-lock.json` at its root. A repository opts in by committing that file, which `npx skills add` writes.

The update runs `npx -y skills@<version> update -p -y`, which downloads the skills from their sources and runs third-party code, so it runs in a Vercel Sandbox of its own, which is deleted afterwards. The sandbox clones the default branch shallowly: anonymously for a public repository, and for a private one with an installation token that can only read that repository's contents and expires within an hour. It holds no other credential. The bot reads the changed files back from the sandbox and writes the commit and the pull request itself, from the app runtime. The skills CLI's version is pinned in `src/jobs/update-agent-skills.ts`, and Renovate updates it.

The bot commits only the changes under `.agents/skills/`, `.claude/skills/`, and `skills-lock.json`, with their file modes, so symbolic links and executables stay as they are, and logs any other path the update touched. It commits them to the `chachamaru/update-agent-skills` branch on top of the default branch and opens a pull request titled `chore(skills): update agent skills`, which lists the changed skills from the lock file and asks the reviewer to read the instruction changes. It neither approves nor merges the pull request: a skill changes what agents do, so a person reviews it.

When the update changes nothing, the bot writes nothing. While the open pull request holds the same skill files, it leaves the branch as it is, even once the default branch moved on; when the skills changed upstream again, it moves the branch to a new commit on the current default branch. When the clone or the update fails, it leaves the repository alone and logs why.

The schedule runs in a Vercel Function, which the project allows 800 seconds, and updates the repositories at the same time. Each sandbox lives at most 240 seconds, its clone at most 60, and the update at most 120; a shallow clone and an update of publira/publira took about 30 seconds together. Vercel Sandbox itself allows a sandbox up to 24 hours on the team's plan. On Vercel the sandbox authenticates with the project's OIDC token, which needs no setting.

### Closing completed issues

The bot closes an issue as completed once it has at least one sub-issue and all of them are closed, whatever their reason, and comments that it did so. It decides from the sub-issue structure alone, not from labels. It evaluates the parent when a sub-issue is closed and when a sub-issue is removed from it. The bot's own close of a parent is delivered as an event too, so the parent's parent is evaluated in turn.

A sub-issue can live in another repository than its parent. The bot closes a parent only in a repository the App is installed on. It leaves an issue that is already closed as it is, so one reopened by hand stays open until a sub-issue is closed or removed again. The exception is an issue the bot closed itself: if its comment is missing, such as after posting it failed, the next evaluation of the issue posts it.

### Labelling agent-assisted pull requests

The bot gives a pull request the `ai-assisted` label when any of its commits carries an `Assisted-by:` trailer, matched case-insensitively as trailer tokens are, and takes the label off when none does, so a force-push that drops the agent commits drops the label too. GitHub lists at most 250 commits of a pull request, so the bot keeps the label on a longer one whose listed commits have no trailer. It evaluates a pull request when it is opened, marked ready for review, or pushed to, and leaves a draft alone until it is ready. It reads the labels from the API rather than from the event, and adds the label only in a repository that defines it and has not archived it.
