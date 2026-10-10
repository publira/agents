# Publira Agents

Maintenance automation for the [Publira](https://github.com/publira) organization on GitHub.

Its first application is the [maintenance bot](apps/maintenance-bot/README.md), an [eve](https://eve.dev/) app deployed to Vercel that hosts the jobs that keep Publira's repositories maintained.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/maintenance-bot/` | The [maintenance bot](apps/maintenance-bot/README.md): the eve agent in `agent/`, and the deterministic jobs in `src/jobs/` |
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
pnpm build      # build the packages and the apps
pnpm typecheck
pnpm test
pnpm check      # lint and format checks; `pnpm fix` applies the fixes
```

Each app's README describes how to run and operate it.

[AGENTS.md](AGENTS.md) describes the conventions in more detail.

## License

[Apache License 2.0](LICENSE)
