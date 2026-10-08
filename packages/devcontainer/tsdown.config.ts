import { defineConfig } from "tsdown";

export default defineConfig({
  // jsonc-parser is bundled, as a development dependency. Its main build is
  // UMD, which loads its modules with a `require` the eve build cannot
  // follow, and its ES module build does not run on Node.js as it is; the
  // bundle takes the ES module build.
  deps: { onlyBundle: ["jsonc-parser"] },
  dts: true,
  entry: ["src/index.ts"],
  format: "esm",
  inputOptions: { resolve: { mainFields: ["module", "main"] } },
});
