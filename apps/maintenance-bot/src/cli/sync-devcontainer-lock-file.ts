// Evaluates one Renovate pull request from a terminal, without eve or a
// model, and commits the regenerated Dev Container lock file to it as the
// GitHub App when the pull request bumps a Feature:
//
//   pnpm --filter @publira/maintenance-bot sync-devcontainer-lock-file publira/publira 3874 --dry-run
//
// With --dry-run it prints the lock files it would commit and changes
// nothing; it reads as the development GitHub App in .env.local when there is
// one, and otherwise anonymously or with GH_TOKEN, as
// check-release-age-exclusions does. Without --dry-run it commits to the pull
// request's branch, which only the App may do.
import { parseArgs } from "node:util";

import { createGitHubClient, parseRepositoryName } from "@publira/github";

import { getGitHubApp } from "../github-app.ts";
import { syncDevContainerLockFile } from "../jobs/sync-devcontainer-lock-file.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" } },
});
const pullNumber = Number(positionals[1]);

if (positionals.length !== 2 || !Number.isSafeInteger(pullNumber)) {
  console.error(
    "Usage: sync-devcontainer-lock-file <owner/repo> <pull request number> [--dry-run]"
  );
  process.exit(2);
}

const dryRun = values["dry-run"] ?? false;
const repository = parseRepositoryName(positionals[0] ?? "");
const app = getGitHubApp();

if (app === undefined && !dryRun) {
  console.error(
    "Committing to a pull request needs the GitHub App's credentials in .env.local. Pass --dry-run to only evaluate it."
  );
  process.exit(2);
}

const result = await syncDevContainerLockFile({
  ...repository,
  dryRun,
  octokit:
    app === undefined
      ? createGitHubClient({ auth: process.env.GH_TOKEN })
      : await app.getRepositoryOctokit(repository),
  pullNumber,
});

switch (result.status) {
  case "skipped": {
    console.log(`Left alone: ${result.reason}.`);
    break;
  }
  case "in-sync": {
    console.log(`Already in step: ${result.lockFiles.join(", ")}.`);
    break;
  }
  case "would-commit": {
    console.log(`Would commit "${result.message}" on ${result.headSha}:`);
    for (const [path, contents] of Object.entries(result.files)) {
      console.log(`\n--- ${path}\n${contents}`);
    }
    break;
  }
  case "committed": {
    console.log(`Committed "${result.message}" as ${result.commitSha}.`);
    break;
  }
  case "head-moved": {
    console.log(
      `The branch moved from ${result.headSha} meanwhile; nothing was committed.`
    );
    break;
  }
  default: {
    break;
  }
}
