// Evaluates one pull request from a terminal, without eve or a model, and
// labels it `ai-assisted` as the GitHub App when its commits disclose an
// agent, or takes the label off when they do not:
//
//   pnpm --filter @publira/maintenance-bot label-agent-assisted-pull-request publira/agents 70 --dry-run
//
// With --dry-run it prints what it would do and changes nothing; it reads as
// the development GitHub App in .env.local when there is one, and otherwise
// anonymously or with GH_TOKEN, as check-release-age-exclusions does.
// Without --dry-run it changes the label, which only the App may do.
import { parseArgs } from "node:util";

import { createGitHubClient, parseRepositoryName } from "@publira/github";

import { getGitHubApp } from "../github-app.ts";
import { labelAgentAssistedPullRequest } from "../jobs/label-agent-assisted-pull-request.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" } },
});
const pullNumber = Number(positionals[1]);

if (positionals.length !== 2 || !Number.isSafeInteger(pullNumber)) {
  console.error(
    "Usage: label-agent-assisted-pull-request <owner/repo> <pull request number> [--dry-run]"
  );
  process.exit(2);
}

const dryRun = values["dry-run"] ?? false;
const repository = parseRepositoryName(positionals[0] ?? "");
const app = getGitHubApp();

if (app === undefined && !dryRun) {
  console.error(
    "Changing a label needs the GitHub App's credentials in .env.local. Pass --dry-run to only evaluate it."
  );
  process.exit(2);
}

const result = await labelAgentAssistedPullRequest({
  ...repository,
  dryRun,
  octokit:
    app === undefined
      ? createGitHubClient({ auth: process.env.GH_TOKEN })
      : await app.getRepositoryOctokit(repository),
  pullNumber,
});
const commits = `${result.commits} commit${result.commits === 1 ? "" : "s"}`;

switch (result.status) {
  case "left": {
    console.log(`Left as it is (${commits}): ${result.reason}.`);
    break;
  }
  case "would-add": {
    console.log(
      `Would add ai-assisted: a commit discloses an agent (${commits}).`
    );
    break;
  }
  case "added": {
    console.log(`Added ai-assisted: a commit discloses an agent (${commits}).`);
    break;
  }
  case "would-remove": {
    console.log(
      `Would remove ai-assisted: no commit discloses an agent (${commits}).`
    );
    break;
  }
  case "removed": {
    console.log(
      `Removed ai-assisted: no commit discloses an agent (${commits}).`
    );
    break;
  }
  default: {
    break;
  }
}
