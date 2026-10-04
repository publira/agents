import { defineSchedule } from "eve/schedules";

import { getGitHubApp } from "../../src/github-app.ts";
import { evaluateRenovateUpdatesEverywhere } from "../../src/jobs/evaluate-renovate-update.ts";
import { log } from "../../src/log.ts";
import { renovateAutoMergeEnabled } from "../../src/renovate-auto-merge.ts";

// Evaluates every open Renovate pull request in the repositories the App is
// installed on: approves the equivalent updates, and auto-merges them when
// RENOVATE_AUTO_MERGE is on. The webhook handlers evaluate them as they
// change; this catches up on a delivery that failed, which GitHub does not
// retry, and takes back an auto-merge that a new head or turning auto-merge
// off made stale. No model is involved.
export default defineSchedule({
  // Hourly, at minute 30.
  cron: "30 * * * *",
  async run() {
    const app = getGitHubApp();

    if (app === undefined) {
      log("warn", "Schedule skipped: the GitHub App is not configured");
      return;
    }

    await evaluateRenovateUpdatesEverywhere({
      app,
      autoMerge: renovateAutoMergeEnabled(log),
      log,
    });
  },
});
