import { defineSchedule } from "eve/schedules";

import { getGitHubApp } from "../../src/github-app.ts";
import { evaluateRenovateUpdatesEverywhere } from "../../src/jobs/evaluate-renovate-update.ts";
import { SANDBOX_TIMEOUT_MS } from "../../src/jobs/regenerate-generated-output.ts";
import { createModelLintFindingsFixer } from "../../src/lint-findings-fixer.ts";
import { log, withFields } from "../../src/log.ts";
import { createVercelSandboxRunner } from "../../src/sandbox-runner.ts";
import { readSettings } from "../../src/settings.ts";

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
      sandbox: createVercelSandboxRunner({
        log: scheduleLog,
        timeoutMs: SANDBOX_TIMEOUT_MS,
      }),
      settings,
    });
  },
});
