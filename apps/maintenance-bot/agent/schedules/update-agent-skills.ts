import { defineSchedule } from "eve/schedules";

import { getGitHubApp } from "../../src/github-app.ts";
import {
  SANDBOX_TIMEOUT_MS,
  updateAgentSkillsEverywhere,
} from "../../src/jobs/update-agent-skills.ts";
import { log, withFields } from "../../src/log.ts";
import { createVercelSandboxRunner } from "../../src/sandbox-runner.ts";
import { readSettings } from "../../src/settings.ts";

// Opens a pull request in each repository the App is installed on that has
// a skills-lock.json, with the updates to its vendored agent skills. The
// update runs in a Vercel Sandbox of its own, which eve does not manage: an
// eve sandbox belongs to an agent session, and this job starts none. No
// model is involved.
export default defineSchedule({
  // Weekly on Monday at 00:00 UTC, 09:00 in Japan.
  cron: "0 0 * * 1",
  async run() {
    const scheduleLog = withFields(log, { schedule: "update-agent-skills" });
    const app = getGitHubApp();

    if (app === undefined) {
      scheduleLog("warn", "Schedule skipped: the GitHub App is not configured");
      return;
    }

    const { dryRun } = readSettings(scheduleLog);

    scheduleLog("info", "Schedule started", { dryRun });
    await updateAgentSkillsEverywhere({
      app,
      dryRun,
      log: scheduleLog,
      sandbox: createVercelSandboxRunner({
        log: scheduleLog,
        timeoutMs: SANDBOX_TIMEOUT_MS,
      }),
    });
  },
});
