import { defineSchedule } from "eve/schedules";

import { createModelLintFindingsFixer } from "#ai/lint-findings-fixer.ts";
import { evaluateRenovateUpdatesEverywhere } from "#jobs/evaluate-renovate-update.ts";
import { getGitHubApp } from "#runtime/github-app.ts";
import { log, withFields } from "#runtime/log.ts";
import { readSettings } from "#runtime/settings.ts";
import { createVercelSandboxRunner } from "#sandbox/runner.ts";

// Evaluates every open Renovate pull request in the repositories the App is
// installed on: syncs their Dev Container lock files, regenerates their
// generated output in a Vercel Sandbox, applies the automatic lint fixes in
// one to those whose checks failed, has a model fix the findings they leave,
// approves the equivalent updates, and auto-merges them, as the settings
// allow. The webhook handlers evaluate them as they change; this catches up
// on a delivery that failed, which GitHub does not retry, and takes back an
// auto-merge that a new head or turning auto-merge off made stale. No model
// takes part in approval or auto-merge.
export default defineSchedule({
  // Hourly, at minute 30.
  cron: "30 * * * *",
  async run() {
    const scheduleLog = withFields(log, {
      schedule: "evaluate-renovate-updates",
    });

    const app = getGitHubApp();

    if (app === undefined) {
      scheduleLog("warn", "Schedule skipped: the GitHub App is not configured");

      return;
    }

    const settings = readSettings(scheduleLog);
    scheduleLog("info", "Schedule started", { ...settings });
    await evaluateRenovateUpdatesEverywhere({
      app,
      fixer: createModelLintFindingsFixer(),
      log: scheduleLog,
      sandbox: createVercelSandboxRunner({ log: scheduleLog }),
      settings,
    });
  },
});
