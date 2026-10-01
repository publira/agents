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
| `packages/pnpm-workspace/` | Reading `pnpm-workspace.yaml` |
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

- **Webhook URL**: `https://<deployment>/github/webhooks`, with a random **webhook secret**.
- **Repository permissions**:
  - Metadata: read. Required by every App.
  - Contents: read and write. Reads files, and creates the branches and commits of maintenance pull requests.
  - Pull requests: read and write. Opens pull requests and submits reviews.
  - Checks: read, and Commit statuses: read. Tell whether a pull request's CI passed.
- **Organization and account permissions**: none.
- **Events**: only those the bot handles; see `apps/maintenance-bot/src/webhooks/handlers.ts`. GitHub sends installation events regardless.
- **Where can this App be installed**: only on this account. Install it on selected repositories, not all of them.

The bot reads the App's credentials from three environment variables:

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | The App ID |
| `GITHUB_APP_PRIVATE_KEY` | A private key of the App, in PEM; line breaks may be written as `\n` |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret |

Set the production App's values in the Vercel project's Production environment only, as sensitive variables. For local development, register a separate development App on a test repository, put its values in `apps/maintenance-bot/.env.local`, which Git ignores and `eve dev` and the command-line entries load, and forward its webhooks to the local server through a tunnel. `pnpm --filter @publira/maintenance-bot list-app-repositories` checks the credentials. The tests use generated keys and never reach GitHub.

## License

[Apache License 2.0](LICENSE)
