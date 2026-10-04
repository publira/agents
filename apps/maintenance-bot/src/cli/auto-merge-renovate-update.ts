// Decides from a terminal, without eve or a model, whether the maintenance
// bot may have GitHub merge one Renovate pull request it approved, and acts
// on it as the GitHub App:
//
//   RENOVATE_AUTO_MERGE=true pnpm --filter @publira/maintenance-bot auto-merge-renovate-update publira/agents 31 --dry-run
//
// It follows RENOVATE_AUTO_MERGE as the deployment does, so it decides
// nothing while that is off. With --dry-run it prints the decision and
// changes nothing. The decision rests on the bot's own approval, so it reads
// as the development GitHub App in .env.local even for a dry run.
import { parseArgs } from "node:util";

import { parseRepositoryName } from "@publira/github";

import { getGitHubApp } from "../github-app.ts";
import { autoMergeRenovateUpdate } from "../jobs/auto-merge-renovate-update.ts";
import { readRenovateAutoMerge } from "../renovate-auto-merge.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" } },
});
const pullNumber = Number(positionals[1]);

if (positionals.length !== 2 || !Number.isSafeInteger(pullNumber)) {
  console.error(
    "Usage: auto-merge-renovate-update <owner/repo> <pull request number> [--dry-run]"
  );
  process.exit(2);
}

const repository = parseRepositoryName(positionals[0] ?? "");
const app = getGitHubApp();

if (app === undefined) {
  console.error(
    "Auto-merge decides on the GitHub App's own approval: set the App's credentials in .env.local."
  );
  process.exit(2);
}

const enabled = readRenovateAutoMerge();
const result = await autoMergeRenovateUpdate({
  ...repository,
  dryRun: values["dry-run"] ?? false,
  enabled,
  octokit: await app.getRepositoryOctokit(repository),
  pullNumber,
  reviewer: await app.getBotLogin(),
});

console.log(`Auto-merge is ${enabled ? "on" : "off"}.`);

if (result.withdrew !== undefined) {
  console.log(
    `Took back the earlier decision${values["dry-run"] === true ? " (dry run: would)" : ""}: ${result.withdrew}.`
  );
}

const outcomes: Record<typeof result.status, string> = {
  closed: "The pull request is not open.",
  declined: "Declined",
  disabled: "Nothing to do.",
  enabled: "Enabled auto-merge",
  enqueued: "Added it to the merge queue",
  merged: "Merged it",
  pending: `Its auto-merge for ${result.headSha} stands.`,
  refused: "GitHub refused",
  withdrawn: "Took back its auto-merge",
  "would-merge": "Would merge it",
};
let detail = "";

if ("reason" in result) {
  detail = `: ${result.reason}.`;
} else if ("mergeMethod" in result) {
  const queue =
    "mergeQueue" in result && result.mergeQueue
      ? ", through the merge queue"
      : "";
  detail = ` at ${result.headSha} (${result.mergeMethod}${queue}).`;
}

console.log(`${outcomes[result.status]}${detail}`);
