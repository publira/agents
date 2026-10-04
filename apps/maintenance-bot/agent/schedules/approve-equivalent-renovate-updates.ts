import { defineSchedule } from "eve/schedules";

import { getGitHubApp } from "../../src/github-app.ts";
import { approveEquivalentRenovateUpdatesEverywhere } from "../../src/jobs/approve-equivalent-renovate-update.ts";
import { log } from "../../src/log.ts";

// Evaluates every open Renovate pull request in the repositories the App is
// installed on. The webhook handlers evaluate them as they change; this
// catches up on a delivery that failed, which GitHub does not retry. No model
// is involved.
export default defineSchedule({
  // Hourly, at minute 30.
  cron: "30 * * * *",
  async run() {
    const app = getGitHubApp();

    if (app === undefined) {
      log("warn", "Schedule skipped: the GitHub App is not configured");
      return;
    }

    await approveEquivalentRenovateUpdatesEverywhere({ app, log });
  },
});
