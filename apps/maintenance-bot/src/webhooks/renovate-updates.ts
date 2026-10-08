import { RENOVATE_LOGIN } from "@publira/maintenance-policies";
import { z } from "zod";

import {
  evaluateRenovateUpdate,
  evaluateRenovateUpdatesEverywhere,
} from "../jobs/evaluate-renovate-update.ts";
import {
  summarizeLockFileSyncResult,
  syncDevContainerLockFile,
} from "../jobs/sync-devcontainer-lock-file.ts";
import { loggableFailure, withFields } from "../log.ts";
import { readSettings } from "../settings.ts";
import type { WebhookHandler } from "./receive-webhook.ts";

// Renovate's default branch prefix, which the organization's preset keeps.
// It only spares the API calls for events of other branches; the job decides
// on the pull request itself.
const RENOVATE_BRANCH_PREFIX = "renovate/";

// The conclusions of a suite that can be what makes CI pass.
const PASSING_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);

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

// The actions after which Renovate's branch may hold a new Feature bump.
const LOCK_FILE_SYNC_ACTIONS = new Set(["opened", "synchronize"]);

type Payload = z.infer<typeof repositoryEvent>;

export interface RenovateUpdateHandlerOptions {
  evaluate: typeof evaluateRenovateUpdate;
  evaluateEverywhere: typeof evaluateRenovateUpdatesEverywhere;
  syncLockFile: typeof syncDevContainerLockFile;
  /** Reads the settings for each delivery. */
  readSettings: typeof readSettings;
}

/**
 * The handlers that approve equivalent Renovate updates, and auto-merge them,
 * as the settings allow, by event name:
 *
 * - `pull_request` evaluates a Renovate pull request when it opens or
 *   changes. When it opens or is pushed to, the Dev Container lock files are
 *   first synced with the Features it bumps; a commit for that skips the
 *   evaluation, which the commit's own push brings. When one merges, it may
 *   be the precedent that the open pull requests from the same branch in
 *   other repositories wait for, so those are evaluated.
 * - `check_suite` evaluates the Renovate pull requests of a suite that passed.
 * - `status` evaluates the Renovate pull requests of a commit once one of its
 *   statuses, such as `renovate/stability-days`, succeeds.
 *
 * A push to a pull request (`synchronize`) also lets the bot take back the
 * auto-merge it enabled for the earlier head.
 *
 * Tests replace the jobs.
 */
export const createRenovateUpdateHandlers = ({
  evaluate: evaluateOne = evaluateRenovateUpdate,
  evaluateEverywhere = evaluateRenovateUpdatesEverywhere,
  syncLockFile = syncDevContainerLockFile,
  readSettings: read = readSettings,
}: Partial<RenovateUpdateHandlerOptions> = {}): Record<
  "check_suite" | "pull_request" | "status",
  WebhookHandler
> => {
  const evaluate = async (
    payload: Payload,
    pullNumbers: readonly number[],
    { app, log }: Parameters<WebhookHandler>[1]
  ) => {
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const [octokit, reviewer] = await Promise.all([
      app.getInstallationOctokit(payload.installation.id),
      app.getBotLogin(),
    ]);
    const settings = read(log);
    const installationLog = withFields(log, {
      installation: payload.installation.id,
    });

    for (const pullNumber of new Set(pullNumbers)) {
      // oxlint-disable-next-line no-await-in-loop -- one pull request at a time
      await evaluateOne({
        log: installationLog,
        octokit,
        owner,
        pullNumber,
        repo,
        reviewer,
        settings,
      });
    }
  };

  /** Syncs the lock files, and tells whether it committed. Never throws. */
  const syncLockFiles = async (
    payload: Payload,
    pullNumber: number,
    { app, log }: Parameters<WebhookHandler>[1]
  ): Promise<boolean> => {
    const { dryRun } = read(log);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const jobLog = withFields(log, {
      dryRun,
      installation: payload.installation.id,
      job: "sync-devcontainer-lock-file",
      owner,
      pullRequest: pullNumber,
      repo,
    });

    try {
      const result = await syncLockFile({
        dryRun,
        octokit: await app.getInstallationOctokit(payload.installation.id),
        owner,
        pullNumber,
        repo,
      });
      jobLog(
        "info",
        "Dev Container lock file sync evaluated",
        summarizeLockFileSyncResult(result)
      );
      return result.status === "committed";
    } catch (error) {
      jobLog(
        "error",
        "Dev Container lock file sync failed",
        loggableFailure.safeParse(error).data
      );
      return false;
    }
  };

  return {
    async check_suite(delivery, context) {
      const payload = checkSuiteEvent.parse(delivery.payload);
      const { action, check_suite: suite } = payload;

      if (
        action !== "completed" ||
        !PASSING_CONCLUSIONS.has(suite.conclusion ?? "") ||
        !(suite.head_branch ?? "").startsWith(RENOVATE_BRANCH_PREFIX)
      ) {
        return;
      }

      await evaluate(
        payload,
        suite.pull_requests.map(({ number }) => number),
        context
      );
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
        if (
          LOCK_FILE_SYNC_ACTIONS.has(action) &&
          (await syncLockFiles(payload, pullRequest.number, context))
        ) {
          return;
        }
        await evaluate(payload, [pullRequest.number], context);
      }
    },

    async status(delivery, context) {
      const payload = statusEvent.parse(delivery.payload);

      if (
        payload.state !== "success" ||
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

      await evaluate(
        payload,
        pulls
          .filter(
            (pull) =>
              pull.state === "open" && pull.user?.login === RENOVATE_LOGIN
          )
          .map(({ number }) => number),
        context
      );
    },
  };
};
