import { defineSchedule } from "eve/schedules";

import { createModelExclusionEditor } from "#ai/exclusion-editor.ts";
import { removeExpiredReleaseAgeExclusionsEverywhere } from "#jobs/remove-expired-release-age-exclusions.ts";
import { getGitHubApp } from "#runtime/github-app.ts";
import { log, withFields } from "#runtime/log.ts";
import { readSettings } from "#runtime/settings.ts";

// Opens a pull request in each repository the App is installed on that
// removes its expired minimumReleaseAgeExclude entries. The job runs without
// an agent session; the model is asked only when the rules cannot tell which
// comments to remove with the entries.
export default defineSchedule({
  // Daily at 00:00 UTC, 09:00 in Japan.
  cron: "0 0 * * *",
  async run() {
    const scheduleLog = withFields(log, {
      schedule: "remove-expired-release-age-exclusions",
    });

    const app = getGitHubApp();

    if (app === undefined) {
      scheduleLog("warn", "Schedule skipped: the GitHub App is not configured");

      return;
    }

    const { dryRun } = readSettings(scheduleLog);

    scheduleLog("info", "Schedule started", { dryRun });
    await removeExpiredReleaseAgeExclusionsEverywhere({
      app,
      dryRun,
      editor: createModelExclusionEditor(),
      log: scheduleLog,
    });
  },
});
