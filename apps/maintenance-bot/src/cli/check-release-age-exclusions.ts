// Runs the job from a terminal, without eve or a model:
//
//   pnpm --filter @publira/maintenance-bot check-release-age-exclusions publira/publira
//
// With the GITHUB_APP_* variables of a development GitHub App in .env.local,
// it reads the repository as that App. Otherwise requests are anonymous unless
// GH_TOKEN holds a token of your own, which raises the GitHub API rate limit;
// that token is for local runs only, and the deployed bot never has one.
import { parseArgs } from "node:util";

import { createGitHubClient, parseRepositoryName } from "@publira/github";

import { getGitHubApp } from "../github-app.ts";
import { checkReleaseAgeExclusions } from "../jobs/check-release-age-exclusions.ts";
import type { ReleaseAgeExclusionReport } from "../jobs/check-release-age-exclusions.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { ref: { type: "string" } },
});

if (positionals.length !== 1) {
  console.error(
    "Usage: check-release-age-exclusions <owner/repo> [--ref <ref>]"
  );
  process.exit(2);
}

const formatDetails = ({ verdict }: ReleaseAgeExclusionReport): string => {
  switch (verdict.action) {
    case "keep": {
      return ` (${verdict.reason})`;
    }
    case "waiting": {
      return ` (until ${verdict.availableAt.toISOString()})`;
    }
    case "expired": {
      return ` (since ${verdict.availableAt.toISOString()})`;
    }
    case "unknown": {
      return ` (not in the registry: ${verdict.missingVersions.join(", ")})`;
    }
    default: {
      return "";
    }
  }
};

const repository = parseRepositoryName(positionals[0] ?? "");
const app = getGitHubApp();
const reports = await checkReleaseAgeExclusions({
  ...repository,
  octokit:
    app === undefined
      ? createGitHubClient({ auth: process.env.GH_TOKEN })
      : await app.getRepositoryOctokit(repository),
  ref: values.ref,
});

if (reports.length === 0) {
  console.log("No minimumReleaseAgeExclude entries.");
}

for (const report of reports) {
  console.log(
    `${report.verdict.action.padEnd(8)} ${report.selector}${formatDetails(report)}`
  );
}
