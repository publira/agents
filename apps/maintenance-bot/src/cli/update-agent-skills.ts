// Runs the job on one repository from a terminal, without eve:
//
//   pnpm --filter @publira/maintenance-bot update-agent-skills publira/publira --dry-run
//
// The update runs in a Vercel Sandbox, which needs the Vercel project's OIDC
// token in .env.local as VERCEL_OIDC_TOKEN: `vercel env pull` in this
// directory writes it, and it expires after 12 hours. With --dry-run it
// prints the paths the job would commit and changes nothing; it reads as the
// development GitHub App in .env.local when there is one, and otherwise
// anonymously or with GH_TOKEN, as check-release-age-exclusions does. A
// private repository needs the App, whose read-only token the sandbox clones
// it with; GH_TOKEN never reaches the sandbox. Without --dry-run it pushes the
// branch and opens the pull request, which only the App may do.
import { parseArgs } from "node:util";

import {
  createGitHubClient,
  createRepositoryReadToken,
  parseRepositoryName,
} from "@publira/github";

import { getGitHubApp } from "../github-app.ts";
import {
  SANDBOX_TIMEOUT_MS,
  updateAgentSkills,
} from "../jobs/update-agent-skills.ts";
import { log } from "../log.ts";
import { createVercelSandboxRunner } from "../sandbox-runner.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" } },
});

if (positionals.length !== 1) {
  console.error("Usage: update-agent-skills <owner/repo> [--dry-run]");
  process.exit(2);
}

const dryRun = values["dry-run"] ?? false;
const repository = parseRepositoryName(positionals[0] ?? "");
const app = getGitHubApp();

if (app === undefined && !dryRun) {
  console.error(
    "Opening a pull request needs the GitHub App's credentials in .env.local. Pass --dry-run to only print the update."
  );
  process.exit(2);
}

const createReadToken =
  app === undefined
    ? undefined
    : async () => {
        const { data } = await app.octokit.rest.apps.getRepoInstallation({
          owner: repository.owner,
          repo: repository.repo,
        });
        return createRepositoryReadToken(app, {
          installationId: data.id,
          repo: repository.repo,
        });
      };

const result = await updateAgentSkills({
  ...repository,
  createReadToken,
  dryRun,
  octokit:
    app === undefined
      ? createGitHubClient({ auth: process.env.GH_TOKEN })
      : await app.getRepositoryOctokit(repository),
  sandbox: createVercelSandboxRunner({ log, timeoutMs: SANDBOX_TIMEOUT_MS }),
});

const printPlan = (plan: {
  skills: { name: string; source: string; change: string }[];
  paths: string[];
  ignoredPaths: string[];
}) => {
  for (const { change, name, source } of plan.skills) {
    console.log(`${change}: ${name} (${source})`);
  }
  console.log("\nWould commit:");
  for (const path of plan.paths) {
    console.log(`  ${path}`);
  }
  if (plan.ignoredPaths.length > 0) {
    console.log("\nWould leave out:");
    for (const path of plan.ignoredPaths) {
      console.log(`  ${path}`);
    }
  }
};

switch (result.status) {
  case "no-lock-file": {
    console.log("No skills-lock.json on the default branch.");
    break;
  }
  case "failed": {
    console.error(
      `The ${result.step} failed with exit code ${result.exitCode}:\n${result.output}`
    );
    process.exitCode = 1;
    break;
  }
  case "unchanged": {
    console.log(`The skills are up to date at ${result.baseSha}.`);
    for (const path of result.ignoredPaths) {
      console.log(`  left out: ${path}`);
    }
    break;
  }
  case "planned": {
    printPlan(result);
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
