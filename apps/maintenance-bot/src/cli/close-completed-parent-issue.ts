// Evaluates one issue from a terminal, without eve or a model, and closes it
// as the GitHub App when all of its sub-issues are closed:
//
//   pnpm --filter @publira/maintenance-bot close-completed-parent-issue publira/publira 3408 --dry-run
//
// With --dry-run it prints whether the issue would be closed and changes
// nothing; it reads as the development GitHub App in .env.local when there is
// one, and otherwise anonymously or with GH_TOKEN, as
// check-release-age-exclusions does. Without --dry-run it closes the issue
// and comments on it, which only the App may do.
import { parseArgs } from "node:util";

import { createGitHubClient, parseRepositoryName } from "@publira/github";

import { getGitHubApp } from "../github-app.ts";
import { closeCompletedParentIssue } from "../jobs/close-completed-parent-issue.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" } },
});
const issueNumber = Number(positionals[1]);

if (positionals.length !== 2 || !Number.isSafeInteger(issueNumber)) {
  console.error(
    "Usage: close-completed-parent-issue <owner/repo> <issue number> [--dry-run]"
  );
  process.exit(2);
}

const dryRun = values["dry-run"] ?? false;
const repository = parseRepositoryName(positionals[0] ?? "");
const app = getGitHubApp();

if (app === undefined && !dryRun) {
  console.error(
    "Closing an issue needs the GitHub App's credentials in .env.local. Pass --dry-run to only evaluate it."
  );
  process.exit(2);
}

const result = await closeCompletedParentIssue({
  ...repository,
  author: app === undefined ? undefined : await app.getBotLogin(),
  dryRun,
  issueNumber,
  octokit:
    app === undefined
      ? createGitHubClient({ auth: process.env.GH_TOKEN })
      : await app.getRepositoryOctokit(repository),
});

switch (result.status) {
  case "left": {
    console.log(`Left open: ${result.reason}.`);
    break;
  }
  case "would-close": {
    console.log(
      `Would close it as completed: all ${result.subIssues} sub-issues are closed.`
    );
    break;
  }
  case "closed": {
    console.log(
      `Closed it as completed: all ${result.subIssues} sub-issues are closed.`
    );
    console.log(
      result.comment.created
        ? `Commented (comment ${result.comment.id}).`
        : `Its comment was already there (comment ${result.comment.id}).`
    );
    break;
  }
  default: {
    break;
  }
}
