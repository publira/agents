import { createRepositoryReadToken } from "@publira/github";
import { RENOVATE_LOGIN } from "@publira/maintenance-policies";
import { z } from "zod";

import {
  evaluateRenovateUpdate,
  evaluateRenovateUpdatesEverywhere,
  fixLintAndLog,
} from "../jobs/evaluate-renovate-update.ts";
import { SANDBOX_TIMEOUT_MS } from "../jobs/regenerate-generated-output.ts";
import { withFields } from "../log.ts";
import type { Log } from "../log.ts";
import { createVercelSandboxRunner } from "../sandbox-runner.ts";
import type { SandboxRunner } from "../sandbox-runner.ts";
import { readSettings } from "../settings.ts";
import type { WebhookHandler } from "./receive-webhook.ts";

// Renovate's default branch prefix, which the organization's preset keeps.
// It only spares the API calls for events of other branches; the job decides
// on the pull request itself.
const RENOVATE_BRANCH_PREFIX = "renovate/";

// The conclusions of a suite that can be what makes CI pass.
const PASSING_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);

// The states of a commit status that failed.
const FAILED_STATES = new Set(["error", "failure"]);

const repositoryEvent = z.object({
  installation: z.object({ id: z.number() }),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

const pullRequestEvent = repositoryEvent.extend({
  action: z.string(),
  pull_request: z.object({
    head: z.object({ ref: z.string() }),
    merged: z.boolean().nullish(),
    number: z.number(),
    user: z.object({ login: z.string() }).nullable(),
  }),
});

const checkSuiteEvent = repositoryEvent.extend({
  action: z.string(),
  check_suite: z.object({
    conclusion: z.string().nullable(),
    head_branch: z.string().nullable(),
    pull_requests: z.array(z.object({ number: z.number() })),
  }),
});

const statusEvent = repositoryEvent.extend({
  branches: z.array(z.object({ name: z.string() })),
  sha: z.string(),
  state: z.string(),
});

// The actions after which an open pull request may have become approvable.
const EVALUATED_ACTIONS = new Set([
  "edited",
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

// The actions that give a pull request a head whose generated output may need
// regenerating. The other events leave the head as the push's evaluation
// found it, and starting a sandbox for each of them would only repeat it.
const REGENERATING_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

type Payload = z.infer<typeof repositoryEvent>;

export interface RenovateUpdateHandlerOptions {
  evaluate: typeof evaluateRenovateUpdate;
  evaluateEverywhere: typeof evaluateRenovateUpdatesEverywhere;
  fixLint: typeof fixLintAndLog;
  /** Reads the settings for each delivery. */
  readSettings: typeof readSettings;
  /**
   * Creates the sandbox runner that regenerates generated output and
   * applies the automatic lint fixes.
   */
  createSandbox: (log: Log) => SandboxRunner;
}

const createRepositorySandbox = (log: Log) =>
  createVercelSandboxRunner({ log, timeoutMs: SANDBOX_TIMEOUT_MS });

/**
 * The handlers that approve equivalent Renovate updates, and auto-merge them,
 * as the settings allow, by event name:
 *
 * - `pull_request` evaluates a Renovate pull request when it opens or
 *   changes, and regenerates its generated output when it opens or is
 *   pushed to. When one merges, it may be the precedent that the open pull
 *   requests from the same branch in other repositories wait for, so those
 *   are evaluated.
 * - `check_suite` evaluates the Renovate pull requests of a suite that
 *   passed, and applies the automatic lint fixes to those of a suite that
 *   failed.
 * - `status` evaluates the Renovate pull requests of a commit once one of its
 *   statuses, such as `renovate/stability-days`, succeeds, and applies the
 *   automatic lint fixes to them once one fails.
 *
 * A push to a pull request (`synchronize`) also lets the bot take back the
 * auto-merge it enabled for the earlier head.
 *
 * Tests replace the jobs.
 */
export const createRenovateUpdateHandlers = ({
  evaluate: evaluateOne = evaluateRenovateUpdate,
  evaluateEverywhere = evaluateRenovateUpdatesEverywhere,
  fixLint = fixLintAndLog,
  readSettings: read = readSettings,
  createSandbox = createRepositorySandbox,
}: Partial<RenovateUpdateHandlerOptions> = {}): Record<
  "check_suite" | "pull_request" | "status",
  WebhookHandler
> => {
  // What the jobs of one delivery share.
  const prepare = async (
    payload: Payload,
    { app, log }: Parameters<WebhookHandler>[1]
  ) => {
    const repo = payload.repository.name;
    const [octokit, reviewer] = await Promise.all([
      app.getInstallationOctokit(payload.installation.id),
      app.getBotLogin(),
    ]);
    const installationLog = withFields(log, {
      installation: payload.installation.id,
    });
    return {
      log: installationLog,
      octokit,
      owner: payload.repository.owner.login,
      repo,
      repositorySandbox: () => ({
        createReadToken: () =>
          createRepositoryReadToken(app, {
            installationId: payload.installation.id,
            repo,
          }),
        sandbox: createSandbox(installationLog),
      }),
      reviewer,
      settings: read(log),
    };
  };

  const evaluate = async (
    payload: Payload,
    pullNumbers: readonly number[],
    context: Parameters<WebhookHandler>[1],
    { regenerate = false } = {}
  ) => {
    const { log, octokit, owner, repo, repositorySandbox, reviewer, settings } =
      await prepare(payload, context);
    const regeneration = regenerate ? repositorySandbox() : undefined;

    for (const pullNumber of new Set(pullNumbers)) {
      // oxlint-disable-next-line no-await-in-loop -- one pull request at a time
      await evaluateOne({
        log,
        octokit,
        owner,
        pullNumber,
        regeneration,
        repo,
        reviewer,
        settings,
      });
    }
  };

  // Applies the automatic lint fixes to pull requests whose head a check
  // failed on. Approval waits for the checks to pass, so nothing else is
  // evaluated.
  const fixLintOf = async (
    payload: Payload,
    pullNumbers: readonly number[],
    context: Parameters<WebhookHandler>[1]
  ) => {
    const { log, octokit, owner, repo, repositorySandbox, reviewer, settings } =
      await prepare(payload, context);
    const lintFix = repositorySandbox();

    for (const pullNumber of new Set(pullNumbers)) {
      // oxlint-disable-next-line no-await-in-loop -- one pull request at a time
      await fixLint({
        dryRun: settings.dryRun,
        lintFix,
        log,
        octokit,
        owner,
        pullNumber,
        repo,
        reviewer,
      });
    }
  };

  return {
    async check_suite(delivery, context) {
      const payload = checkSuiteEvent.parse(delivery.payload);
      const { action, check_suite: suite } = payload;

      if (
        action !== "completed" ||
        suite.conclusion === null ||
        !(suite.head_branch ?? "").startsWith(RENOVATE_BRANCH_PREFIX)
      ) {
        return;
      }

      const pullNumbers = suite.pull_requests.map(({ number }) => number);
      await (PASSING_CONCLUSIONS.has(suite.conclusion)
        ? evaluate(payload, pullNumbers, context)
        : fixLintOf(payload, pullNumbers, context));
    },

    async pull_request(delivery, context) {
      const payload = pullRequestEvent.parse(delivery.payload);
      const { action, pull_request: pullRequest } = payload;

      if (pullRequest.user?.login !== RENOVATE_LOGIN) {
        return;
      }

      if (action === "closed" && pullRequest.merged === true) {
        await evaluateEverywhere({
          ...context,
          headRef: pullRequest.head.ref,
          settings: read(context.log),
        });
      } else if (EVALUATED_ACTIONS.has(action)) {
        await evaluate(payload, [pullRequest.number], context, {
          regenerate: REGENERATING_ACTIONS.has(action),
        });
      }
    },

    async status(delivery, context) {
      const payload = statusEvent.parse(delivery.payload);

      if (
        (payload.state !== "success" && !FAILED_STATES.has(payload.state)) ||
        !payload.branches.some(({ name }) =>
          name.startsWith(RENOVATE_BRANCH_PREFIX)
        )
      ) {
        return;
      }

      const octokit = await context.app.getInstallationOctokit(
        payload.installation.id
      );
      const { data: pulls } =
        await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          commit_sha: payload.sha,
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
        });

      const pullNumbers = pulls
        .filter(
          (pull) => pull.state === "open" && pull.user?.login === RENOVATE_LOGIN
        )
        .map(({ number }) => number);
      await (payload.state === "success"
        ? evaluate(payload, pullNumbers, context)
        : fixLintOf(payload, pullNumbers, context));
    },
  };
};
