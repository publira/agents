import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { jsPluginSettings, selectJsPlugins } from "ultracite/oxlint/js-plugins";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins(["github", "sonarjs"]);

export default defineConfig({
  extends: [core, vitest, antiSlop, jsPlugins],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  overrides: [
    {
      // A webhook handler is named after the GitHub event it receives, such
      // as `pull_request`, which is snake_case.
      files: ["apps/chachamaru/src/webhooks/**"],
      rules: {
        "sonarjs/function-name": "off",
      },
    },
    {
      // `/tmp/repository` is where a job checks a repository out inside the
      // Vercel Sandbox it creates for itself, not a directory on the host, and
      // the tests name the same path in the commands they expect.
      files: [
        "apps/chachamaru/src/ai/apply-patch.test.ts",
        "apps/chachamaru/src/ai/lint-findings-fixer.test.ts",
        "apps/chachamaru/src/jobs/apply-lint-fixes.ts",
        "apps/chachamaru/src/jobs/apply-lint-fixes.test.ts",
        "apps/chachamaru/src/jobs/regenerate-generated-output.ts",
        "apps/chachamaru/src/jobs/regenerate-generated-output.test.ts",
        "apps/chachamaru/src/jobs/update-agent-skills.ts",
        "apps/chachamaru/src/jobs/update-agent-skills.test.ts",
      ],
      rules: {
        "sonarjs/publicly-writable-directories": "off",
      },
    },
    {
      // These tests build their Git repositories with the `git` on the PATH
      // of the developer or the CI runner that runs them.
      files: [
        "apps/chachamaru/src/jobs/apply-lint-fixes.test.ts",
        "apps/chachamaru/src/jobs/regenerate-generated-output.test.ts",
        "apps/chachamaru/src/jobs/update-agent-skills.test.ts",
      ],
      rules: {
        "sonarjs/no-os-command-from-path": "off",
      },
    },
    {
      // The test checks that an exclusion for a package from an `http://`
      // registry is kept; nothing requests the URL.
      files: [
        "packages/maintenance-policies/src/release-age-exclusion.test.ts",
      ],
      rules: {
        "sonarjs/no-clear-text-protocols": "off",
      },
    },
    {
      // `parsePatch` reads a patch line by line, with a branch for each kind
      // of line that ends in `continue`, and the precedent search tries each
      // merged pull request in turn, moving on to the next as soon as one
      // does not qualify.
      files: [
        "apps/chachamaru/src/ai/apply-patch.ts",
        "apps/chachamaru/src/jobs/approve-equivalent-renovate-update.ts",
      ],
      rules: {
        "sonarjs/cognitive-complexity": "off",
        "sonarjs/too-many-break-or-continue-in-loop": "off",
      },
    },
    {
      // The verdict on a Renovate pull request's commits checks each commit
      // against every condition in turn and returns at the first it fails.
      files: [
        "packages/maintenance-policies/src/equivalent-update-approval.ts",
      ],
      rules: {
        "sonarjs/cognitive-complexity": "off",
      },
    },
    {
      // These regular expressions are grammars written down whole, such as a
      // semantic version, an OCI reference, and an `apply_patch` heredoc, and
      // the comment above each says what it matches.
      files: [
        "apps/chachamaru/src/ai/apply-patch.ts",
        "packages/maintenance-policies/src/devcontainer-lock-file.ts",
        "packages/maintenance-policies/src/release-age-exclusion.ts",
      ],
      rules: {
        "sonarjs/regex-complexity": "off",
      },
    },
  ],
  rules: {
    // It counts each operand of a flat `&&`, `||`, or `??` chain, such as a
    // list of guard conditions or of fallbacks, which reads top to bottom.
    "sonarjs/expression-complexity": "off",
    // A union of string literals lists the cases a value can be, such as the
    // outcomes of a job, which the code tells apart.
    "sonarjs/max-union-size": "off",
    // The repeated strings are the members of string literal unions, such as
    // `status: "pull-request"`, which TypeScript already checks.
    "sonarjs/no-duplicate-string": "off",
    // A function that returns nothing on some paths ends them with `return;`,
    // since `unicorn/no-useless-undefined` rejects `return undefined;`.
    "sonarjs/no-inconsistent-returns": "off",
    // An absent value is `undefined` throughout, as an optional property is;
    // `null` is kept for what an API returns as `null`.
    "sonarjs/no-undefined-assignment": "off",
    // oxlint's own `no-unused-vars` reports unused bindings already, and lets
    // one whose name starts with `_` stay, such as a key a rest pattern drops.
    "sonarjs/no-unused-vars": "off",
  },
  settings: jsPluginSettings,
});
