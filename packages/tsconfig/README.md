# tsconfig

The TypeScript configuration shared across the workspace.

## Usage

```json
{
  "extends": "@publira/tsconfig/base.json"
}
```

Add `@publira/tsconfig` to the package's `devDependencies` as `workspace:*`.

## Notes

- A change here reaches every package, so type-check the whole workspace with `pnpm typecheck`.
- `erasableSyntaxOnly` keeps the code within erasable syntax, and `allowImportingTsExtensions` lets relative imports name the `.ts` file.
