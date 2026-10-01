// Runs the job from a terminal, without eve or a model:
//
//   pnpm --filter @publira/maintenance-bot check-release-age-exclusions publira/publira
//
// Requests are anonymous unless GH_TOKEN holds a token of your own, which
// raises the GitHub API rate limit. It is for local runs only: the deployed bot
// will authenticate as the GitHub App (#3).
import { parseArgs } from "node:util";

import { createGitHubClient, parseRepositoryName } from "@publira/github";

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
    case "waiting": {
      return ` (until ${verdict.availableAt.toISOString()})`;
    }
    case "unknown": {
      return ` (not in the registry: ${verdict.missingVersions.join(", ")})`;
    }
    default: {
      return "";
    }
  }
};

const reports = await checkReleaseAgeExclusions({
  ...parseRepositoryName(positionals[0] ?? ""),
  octokit: createGitHubClient({ auth: process.env.GH_TOKEN }),
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
