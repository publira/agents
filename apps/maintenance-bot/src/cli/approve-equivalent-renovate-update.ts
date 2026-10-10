// Evaluates one Renovate pull request from a terminal, without eve or a
// model, and approves it as the GitHub App when it qualifies:
//
//   pnpm --filter @publira/maintenance-bot approve-equivalent-renovate-update publira/agents 31 --dry-run
//
// With --dry-run it prints each condition and whether the pull request would
// be approved, and changes nothing. Reading who edited the description needs
// GitHub's GraphQL API, which takes no anonymous requests: the dry run reads
// as the development GitHub App in .env.local, or with GH_TOKEN, a token of
// your own for local runs only. Without --dry-run it submits the review, which
// only the App may do.
import { parseArgs } from "node:util";

import { createGitHubClient, parseRepositoryName } from "@publira/github";

import { getGitHubApp } from "../github-app.ts";
import { approveEquivalentRenovateUpdate } from "../jobs/approve-equivalent-renovate-update.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" } },
});
const pullNumber = Number(positionals[1]);

if (positionals.length !== 2 || !Number.isSafeInteger(pullNumber)) {
  console.error(
    "Usage: approve-equivalent-renovate-update <owner/repo> <pull request number> [--dry-run]"
  );
  process.exit(2);
}

const dryRun = values["dry-run"] ?? false;
const repository = parseRepositoryName(positionals[0] ?? "");
const app = getGitHubApp();
const token = process.env.GH_TOKEN;

if (app === undefined && (!dryRun || token === undefined)) {
  console.error(
    dryRun
      ? "Set GH_TOKEN, or the GitHub App's credentials in .env.local: the dry run reads GitHub's GraphQL API."
      : "Approving needs the GitHub App's credentials in .env.local. Pass --dry-run to only evaluate the pull request."
  );
  process.exit(2);
}

const result = await approveEquivalentRenovateUpdate({
  ...repository,
  dryRun,
  octokit:
    app === undefined
      ? createGitHubClient({ auth: token })
      : await app.getRepositoryOctokit(repository),
  pullNumber,
  reviewer: app === undefined ? undefined : await app.getBotLogin(),
});

if (result.status === "already-reviewed") {
  console.log(
    `Already reviewed ${result.headSha} (review ${result.reviewId}).`
  );
} else {
  for (const { condition, detail, passed } of result.conditions) {
    console.log(
      `${passed ? "pass" : "FAIL"} ${condition.padEnd(11)} ${detail}`
    );
  }

  const verdicts = {
    approved: `Approved ${result.headSha}.`,
    skipped: "Not approved.",
    withdrawn: `Approved, then dismissed: the head moved to ${result.status === "withdrawn" ? result.newHeadSha : ""}.`,
    "would-approve": `Would approve ${result.headSha} with this review:`,
  };
  console.log(`\n${verdicts[result.status]}`);

  if (result.status === "would-approve") {
    console.log(`\n${result.body}`);
  }
  if (result.status === "approved" && result.outdatedReviews !== undefined) {
    console.log(
      "minimized" in result.outdatedReviews
        ? `Minimized ${result.outdatedReviews.minimized} earlier review(s) of other heads as outdated.`
        : `Could not minimize the earlier reviews of other heads: ${result.outdatedReviews.error}`
    );
  }
}
