// Runs the job on one repository from a terminal, without eve:
//
//   pnpm --filter @publira/maintenance-bot remove-expired-release-age-exclusions publira/publira --dry-run
//
// With --dry-run it prints the edited pnpm-workspace.yaml and changes
// nothing; it reads as the development GitHub App in .env.local when there is
// one, and otherwise anonymously or with GH_TOKEN, as
// check-release-age-exclusions does. Without --dry-run it pushes the branch and
// opens the pull request, which only the App may do.
//
// The model is asked only when the rules cannot make the edit. It is reached
// through AI Gateway, so set AI_GATEWAY_API_KEY in .env.local for that case.
import { parseArgs } from "node:util";

import { createGitHubClient, parseRepositoryName } from "@publira/github";

import { createModelExclusionEditor } from "../exclusion-editor.ts";
import { getGitHubApp } from "../github-app.ts";
import { removeExpiredReleaseAgeExclusions } from "../jobs/remove-expired-release-age-exclusions.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    "dry-run": { type: "boolean" },
  },
});

if (positionals.length !== 1) {
  console.error(
    "Usage: remove-expired-release-age-exclusions <owner/repo> [--base <branch>] [--dry-run]"
  );
  process.exit(2);
}

const dryRun = values["dry-run"] ?? false;
const repository = parseRepositoryName(positionals[0] ?? "");
const app = getGitHubApp();

if (app === undefined && !dryRun) {
  console.error(
    "Opening a pull request needs the GitHub App's credentials in .env.local. Pass --dry-run to only print the edit."
  );
  process.exit(2);
}

const result = await removeExpiredReleaseAgeExclusions({
  ...repository,
  base: values.base,
  dryRun,
  editor: createModelExclusionEditor(),
  octokit:
    app === undefined
      ? createGitHubClient({ auth: process.env.GH_TOKEN })
      : await app.getRepositoryOctokit(repository),
});

switch (result.status) {
  case "nothing-expired": {
    console.log("No expired minimumReleaseAgeExclude entries.");
    break;
  }
  case "planned": {
    console.log(`Expired, edited by the ${result.editedBy}:`);
    for (const { selector } of result.expired) {
      console.log(`  ${selector}`);
    }
    console.log(`\n${result.source}`);
    break;
  }
  case "pull-request": {
    const { created, url } = result.pullRequest;
    if (created) {
      console.log(`Opened ${url}`);
    } else if (result.committed) {
      console.log(`Updated ${url}`);
    } else {
      console.log(`Already open: ${url}`);
    }
    break;
  }
  default: {
    break;
  }
}
