# Publira Agents

Maintenance automation for the [Publira](https://github.com/publira) organization on GitHub.

The first application is the maintenance bot, an [eve](https://eve.dev/) app deployed to Vercel. It hosts the jobs that keep Publira's repositories maintained. Jobs that follow fixed rules run as plain code without a model, and the eve agent takes the work that needs judgment.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/maintenance-bot/` | The maintenance bot: the eve agent in `agent/`, the deterministic jobs in `src/jobs/`, and their command-line entries in `src/cli/` |
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
  - Metadata: read. Required by every App.
  - Contents: read and write. Reads files, creates the branches and commits of maintenance pull requests, and merges the Renovate pull requests the bot auto-merges.
  - Pull requests: read and write. Opens pull requests, submits reviews, and enables auto-merge or queues a pull request.
  - Checks: read, and Commit statuses: read. Tell whether a pull request's CI passed.
- **Organization and account permissions**: none.
- **Events**: only those the bot handles; see `apps/maintenance-bot/src/webhooks/handlers.ts`. GitHub sends installation events regardless. They are now:
  - Check suite, Pull request, and Status: approve a Renovate pull request when a maintainer approved and merged the same update in another Publira repository, and auto-merge it when that is on.
- **Where can this App be installed**: only on this account. Install it on selected repositories, not all of them.

The bot reads the App's credentials from three environment variables:

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | The App ID |
| `GITHUB_APP_PRIVATE_KEY` | A private key of the App, in PEM; line breaks may be written as `\n` |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret |

### Renovate auto-merge

The bot can also have GitHub merge the Renovate pull requests it approved. This is off unless `RENOVATE_AUTO_MERGE` is `true`. An empty value or `false` leaves it off, and any other value is logged as an error and treated as off. Turning it off leaves approval as it is, and the bot takes back any auto-merge it enabled at its next evaluation, within the hour.

When it is on, the bot enables GitHub's auto-merge for the head it approved, and GitHub then merges the pull request or adds it to the merge queue. If the pull request can already be merged, the bot adds it to the merge queue or merges it at that head. It does this only where:

- the base branch's rulesets require an approving review and dismiss approvals on a push. Classic branch protection is not read, because that needs the Administration permission;
- the repository allows auto-merge; and
- the pull request leaves `.github/workflows/` unchanged, since merging such a change needs the Workflows permission, which the App does not have.

Set the production App's values in the Vercel project's Production environment only, as sensitive variables. For local development, register a separate development App on a test repository, put its values in `apps/maintenance-bot/.env.local`, which Git ignores and `eve dev` and the command-line entries load, and forward its webhooks to the local server through a tunnel. `pnpm --filter @publira/maintenance-bot list-app-repositories` checks the credentials. The tests use generated keys and never reach GitHub.

## License

[Apache License 2.0](LICENSE)
