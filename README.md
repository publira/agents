# Publira Agents

Maintenance automation for the [Publira](https://github.com/publira) organization on GitHub.

The first application is the maintenance bot, an [eve](https://eve.dev/) app deployed to Vercel. It hosts the jobs that keep Publira's repositories maintained. Jobs that follow fixed rules run as plain code without a model, and the eve agent takes the work that needs judgment.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/maintenance-bot/` | The maintenance bot: the eve agent in `agent/`, the deterministic jobs in `src/jobs/`, and their command-line entries in `src/cli/` |
| `packages/devcontainer/` | Reading Dev Container configurations, editing their lock files, and resolving Features in OCI registries |
| `packages/github/` | GitHub API access |
| `packages/maintenance-policies/` | The rules that decide what a job does |
| `packages/npm-registry/` | npm registry lookups |
| `packages/pnpm-workspace/` | Reading and editing `pnpm-workspace.yaml`, and the registries `.npmrc` sets |
| `packages/tsconfig/` | The TypeScript configuration every package extends |

## Development

Open the repository in the Dev Container, or use Node.js and pnpm at the versions pinned in `package.json`. Then run these from the repository root:

```sh
pnpm install
pnpm build      # build the packages and the bot
pnpm typecheck
pnpm test
pnpm check      # lint and format checks; `pnpm fix` applies the fixes
```

Start the bot locally with `pnpm --filter @publira/maintenance-bot dev`. eve asks for a model connection the first time.

[AGENTS.md](AGENTS.md) describes the conventions in more detail.

## GitHub App

The bot acts on repositories as a GitHub App, installed on the repositories it maintains. Register the App with:

- **Webhook URL**: `https://maintenance-bot.publira.dev/github/webhooks`, the production domain, with a random **webhook secret**. Use the custom domain, not a `*.vercel.app` one, which someone else could claim once the project gives it up. Install the App only once the production deployment has the credentials below; until then the route answers `503`. GitHub does not retry a failed delivery, and a delivery can be redelivered by hand only within three days.
- **Repository permissions**:
  - Metadata: read. Required by every App. Also tells whether the reviewer of a precedent can write to its repository, which is what makes them a maintainer: a review's author association reads `CONTRIBUTOR` to the App for a member whose organization membership is private.
  - Contents: read and write. Reads files, creates the branches and commits of maintenance pull requests, commits the synced Dev Container lock files to Renovate pull requests, and merges the Renovate pull requests the bot auto-merges.
  - Pull requests: read and write. Opens pull requests, submits reviews, and enables auto-merge or queues a pull request.
  - Issues: read and write. Reads an issue's parent and sub-issues, closes an issue whose sub-issues are all closed, and comments on it.
  - Checks: read, and Commit statuses: read. Tell whether a pull request's CI passed.
- **Organization and account permissions**: none.
- **Events**: only those the bot handles; see `apps/maintenance-bot/src/webhooks/handlers.ts`. GitHub sends installation events regardless. They are now:
  - Issues and Sub-issues: close an issue as completed when all of its sub-issues are closed.
  - Check suite, Pull request, and Status: commit the regenerated Dev Container lock file to a Renovate pull request that bumps a Feature, approve a Renovate pull request when a maintainer approved and merged the same update in another Publira repository, and auto-merge it when that is on.
- **Where can this App be installed**: only on this account. Install it on selected repositories, not all of them.

The bot reads the App's credentials from three environment variables:

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | The App ID |
| `GITHUB_APP_PRIVATE_KEY` | A private key of the App, in PEM; line breaks may be written as `\n` |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret |

Set the production App's values in the Vercel project's Production environment only, as sensitive variables. For local development, register a separate development App on a test repository, put its values in `apps/maintenance-bot/.env.local`, which Git ignores and `eve dev` and the command-line entries load, and forward its webhooks to the local server through a tunnel. `pnpm --filter @publira/maintenance-bot list-app-repositories` checks the credentials. The tests use generated keys and never reach GitHub.

## Operation

### Settings

Environment variables of the Vercel project turn the bot's writes on and off. Each is `true` or `false`; without it, or with it empty, the default applies. Any other value is logged as an error and read as the safe side: a dry run, or auto-merge off. Vercel applies a changed value to the next deployment, so redeploy after changing one.

| Variable | Default | Effect |
| --- | --- | --- |
| `DRY_RUN` | `false` | Every job still evaluates and logs what it would do, but writes nothing to GitHub: no review, auto-merge, commit, branch, or pull request. |
| `RENOVATE_AUTO_MERGE` | `false` | Has GitHub merge the Renovate pull requests the bot approved; see below. |

The bot acts only on the repositories the App is installed on. To start on a new feature or more repositories, install the App on a few of them, run with `DRY_RUN=true`, read the logs, and then turn `DRY_RUN` off and widen the installation.

Every write is idempotent. A job checks what is already in place before it writes, so a webhook delivered twice, a redelivery, or the next scheduled run changes nothing that is already done. The requests to GitHub and the npm registry time out, and the reads among them are tried again after a server error, a rate limit, or a failed connection; writes are not, since a failed write may still have been applied. A job that still cannot tell the state of a repository, its CI, or a pull request does nothing, and its next run tries again.

The model is asked only to remove expired `minimumReleaseAgeExclude` entries whose comments the fixed rules cannot sort out. It sees only that block of `pnpm-workspace.yaml`, and it is not asked when no entry has expired. No model takes part in approving, merging, syncing lock files, or closing issues. The bot uses no sandbox: the agent has no shell or file tools, and `agent/sandbox.ts` keeps eve from creating a Vercel Sandbox.

### Logs

The bot writes one JSON object per line to the Vercel project's runtime logs, without tokens, keys, the webhook secret, or file contents. Each line names the `job` (or the `schedule`), the `installation`, the `owner` and `repo`, the `pullRequest`, `dryRun`, and the webhook `delivery` it comes from, where they apply. Beyond those:

- `approve-equivalent-renovate-update`: the `status`; for a skipped pull request, the failed `condition` and its `detail`; for an approval, the `precedent` pull request, the maintainer whose approval of it counts (`precedentApprovedBy`), and the `review` with `reviewCreated`. `modelInvoked` is always `false`.
- `auto-merge-renovate-update`: the decision (`autoMerge`), its reason (`autoMergeReason`), the `mergeMethod`, and what it took back (`autoMergeWithdrew`).
- `close-completed-parent-issue`: the parent `issue` and the closed or removed `subIssue` that led to it, the `status`, the `reason` an issue was left open, the number of `subIssues`, and the `comment` with `commentCreated`. `modelInvoked` is always `false`.
- `sync-devcontainer-lock-file`: the `status`, the `headSha` it read, the `lockFiles` it compared or committed, the `reason` it left the pull request alone, the `commit`, and whether approval and auto-merge wait for the commit's push (`evaluationDeferred`). `modelInvoked` is always `false`.
- `remove-expired-release-age-exclusions`: the `status`, the `expired` entries, whether the rules or a model chose the lines (`editedBy`), whether a model was asked in this run (`modelInvoked`, with the `model`), and the `pullRequest` with `pullRequestCreated`.

### Renovate auto-merge

The bot can also have GitHub merge the Renovate pull requests it approved. This is off unless `RENOVATE_AUTO_MERGE` is `true`. Turning it off leaves approval as it is, and the bot takes back any auto-merge it enabled at its next evaluation, within the hour.

When it is on, the bot enables GitHub's auto-merge for the head it approved, and GitHub then merges the pull request or adds it to the merge queue. If the pull request can already be merged, the bot adds it to the merge queue or merges it at that head. It does this only where:

- the base branch's rulesets require an approving review and dismiss approvals on a push. Classic branch protection is not read, because that needs the Administration permission;
- the repository allows auto-merge; and
- the pull request leaves `.github/workflows/` unchanged, since merging such a change needs the Workflows permission, which the App does not have.

### Dev Container lock files

Renovate's devcontainer manager bumps a Feature's reference in `devcontainer.json` but leaves `devcontainer-lock.json` on the old version, which the Dev Container CLI then rewrites on every build. Each time the bot evaluates a Renovate pull request for approval, whether from a webhook or the hourly sweep, it first compares each `devcontainer.json` it changes (`.devcontainer/devcontainer.json`, `.devcontainer/<name>/devcontainer.json`, or `.devcontainer.json`) with the merge base. For each Feature whose tag changed, it replaces the entry in the lock file beside it with what `devcontainer upgrade` writes: the new reference, the version the Feature's metadata declares, and the digest of its manifest, read anonymously from its registry. The other entries, their order, and the formatting stay, and the bot commits only when the file differs from the branch's, on top of the head and only as a fast-forward. A head that the bot commits to, or would in a dry run, is neither approved nor merged; the commit's push is evaluated instead.

The bot leaves the pull request alone, and logs why, when a Feature was added or removed rather than bumped, its dependencies changed, its registry cannot be read, or the lock file is not as the CLI writes it. Renovate may discard the commit when it rewrites the branch, which the organization's preset lets it do, and the next push brings it back. Approval accepts the bot's signed commit on top of Renovate's, as long as it changes only the lock files beside the configurations the pull request changes.

### Closing completed issues

The bot closes an issue as completed once it has at least one sub-issue and all of them are closed, whatever their reason, and comments that it did so. It decides from the sub-issue structure alone, not from labels. It evaluates the parent when a sub-issue is closed and when a sub-issue is removed from it. The bot's own close of a parent is delivered as an event too, so the parent's parent is evaluated in turn.

A sub-issue can live in another repository than its parent. The bot closes a parent only in a repository the App is installed on. It leaves an issue that is already closed as it is, so one reopened by hand stays open until a sub-issue is closed or removed again. The exception is an issue the bot closed itself: if its comment is missing, such as after posting it failed, the next evaluation of the issue posts it.

## License

[Apache License 2.0](LICENSE)
