# tsconfig

The TypeScript configuration shared across the workspace.

## Usage

A package under `packages/` extends `library.json`:

```json
{
  "extends": "@publira/tsconfig/library.json"
}
```

An app extends `base.json`, which `library.json` builds on.

Add `@publira/tsconfig` to the package's `devDependencies` as `workspace:*`.

## Notes

- A change here reaches every package, so type-check the whole workspace with `pnpm typecheck`.
- `erasableSyntaxOnly` keeps the code within erasable syntax, and `allowImportingTsExtensions` lets relative imports name the `.ts` file.
- `library.json` adds `isolatedDeclarations`, which tsdown needs to emit a package's declarations with Oxc.
