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

## License

[Apache License 2.0](LICENSE)
