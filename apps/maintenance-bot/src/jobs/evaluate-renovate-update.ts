import { listAppRepositories } from "@publira/github";
import type { GitHubApp, Octokit } from "@publira/github";
import { isRenovate } from "@publira/maintenance-policies";

import { loggableFailure, withFields } from "../log.ts";
import type { Log } from "../log.ts";
import type { Settings } from "../settings.ts";
import {
  approveEquivalentRenovateUpdate,
  createPrecedentScanCache,
  summarizeApprovalResult,
} from "./approve-equivalent-renovate-update.ts";
import type { PrecedentScanCache } from "./approve-equivalent-renovate-update.ts";
import {
  autoMergeRenovateUpdate,
  summarizeAutoMergeResult,
} from "./auto-merge-renovate-update.ts";
import {
  summarizeLockFileSyncResult,
  syncDevContainerLockFile,
} from "./sync-devcontainer-lock-file.ts";
import type { SyncDevContainerLockFileResult } from "./sync-devcontainer-lock-file.ts";

export interface RenovateUpdateJobs {
  syncLockFile: typeof syncDevContainerLockFile;
  approve: typeof approveEquivalentRenovateUpdate;
  autoMerge: typeof autoMergeRenovateUpdate;
}

// The outcomes after which the head the evaluation read is not the one to
// decide on: the bot's lock file commit moves it, or would in a dry run, or it
// moved already. The push is delivered as `synchronize` and evaluated then.
const DEFERRING_SYNC_STATUSES = new Set<
  SyncDevContainerLockFileResult["status"]
>(["committed", "head-moved", "would-commit"]);

/** The settings that decide what the evaluation may do; see `readSettings`. */
export type RenovateUpdateSettings = Pick<
  Settings,
  "dryRun" | "renovateAutoMerge"
>;

export interface EvaluateRenovateUpdateOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /** The App's bot login, which approves and merges. */
  reviewer: string;
  settings: RenovateUpdateSettings;
  log: Log;
  precedentScanCache?: PrecedentScanCache;
  /** Replaced in tests. */
  jobs?: Partial<RenovateUpdateJobs>;
}

/**
 * Evaluates one Renovate pull request: syncs the Dev Container lock files
 * with the Features it bumps, approves it when it is the same update a
 * maintainer approved elsewhere, then has it auto-merged when that is on and
 * allowed. A head whose lock files the bot commits to, or would in a dry run,
 * is neither approved nor merged: the commit's push is evaluated instead. The
 * auto-merge runs even when the approval did not, or auto-merge is off, to
 * take back a decision a new head made stale. In a dry run, each only logs
 * what it would do. Each logs its outcome and failure, and none throws.
 */
export const evaluateRenovateUpdate = async ({
  octokit,
  owner,
  repo,
  pullNumber,
  reviewer,
  settings: { dryRun, renovateAutoMerge },
  log,
  precedentScanCache,
  jobs: {
    syncLockFile = syncDevContainerLockFile,
    approve = approveEquivalentRenovateUpdate,
    autoMerge = autoMergeRenovateUpdate,
  } = {},
}: EvaluateRenovateUpdateOptions): Promise<void> => {
  const fields = { dryRun, owner, pullRequest: pullNumber, repo };
  const location = {
    dryRun,
    octokit,
    owner,
    precedentScanCache,
    pullNumber,
    repo,
  };

  const syncLog = withFields(log, {
    ...fields,
    job: "sync-devcontainer-lock-file",
  });
  try {
    const result = await syncLockFile({
      dryRun,
      octokit,
      owner,
      pullNumber,
      repo,
    });
    const deferred = DEFERRING_SYNC_STATUSES.has(result.status);
    syncLog("info", "Dev Container lock file sync evaluated", {
      ...summarizeLockFileSyncResult(result),
      evaluationDeferred: deferred,
    });
    if (deferred) {
      return;
    }
  } catch (error) {
    // The lock files stay as they are; approval decides on the head as it is.
    syncLog(
      "error",
      "Dev Container lock file sync failed",
      loggableFailure.safeParse(error).data
    );
  }

  const approvalLog = withFields(log, {
    ...fields,
    job: "approve-equivalent-renovate-update",
  });
  try {
    const result = await approve({ ...location, reviewer });
    approvalLog(
      "info",
      "Renovate update evaluated",
      summarizeApprovalResult(result)
    );
  } catch (error) {
    approvalLog(
      "error",
      "Renovate update approval failed",
      loggableFailure.safeParse(error).data
    );
  }

  const autoMergeLog = withFields(log, {
    ...fields,
    job: "auto-merge-renovate-update",
  });
  try {
    const result = await autoMerge({
      ...location,
      enabled: renovateAutoMerge,
      reviewer,
    });
    // Every outcome, `disabled` included, so the logs tell why a pull
    // request was not merged.
    autoMergeLog(
      result.status === "refused" ? "warn" : "info",
      "Renovate update auto-merge evaluated",
      summarizeAutoMergeResult(result)
    );
  } catch (error) {
    autoMergeLog(
      "error",
      "Renovate update auto-merge failed",
      loggableFailure.safeParse(error).data
    );
  }
};

export interface EvaluateRenovateUpdatesEverywhereOptions {
  app: GitHubApp;
  log: Log;
  settings: RenovateUpdateSettings;
  /** Only the pull requests from this branch, such as after a precedent merged. */
  headRef?: string;
  /** Replaced in tests. */
  evaluate?: typeof evaluateRenovateUpdate;
}

/**
 * Runs {@link evaluateRenovateUpdate} on every open Renovate pull request in
 * the unarchived repositories the App is installed on. A repository that
 * fails is logged, and the others still run.
 */
export const evaluateRenovateUpdatesEverywhere = async ({
  app,
  log,
  settings,
  headRef,
  evaluate = evaluateRenovateUpdate,
}: EvaluateRenovateUpdatesEverywhereOptions): Promise<void> => {
  const [repositories, reviewer] = await Promise.all([
    listAppRepositories(app),
    app.getBotLogin(),
  ]);
  const precedentScanCache = createPrecedentScanCache();

  await Promise.all(
    repositories
      .filter(({ archived }) => !archived)
      .map(async ({ installationId, owner, repo }) => {
        const repositoryLog = withFields(log, {
          installation: installationId,
        });
        try {
          const octokit = await app.getInstallationOctokit(installationId);
          const pulls = await octokit.paginate(octokit.rest.pulls.list, {
            head: headRef === undefined ? undefined : `${owner}:${headRef}`,
            owner,
            per_page: 100,
            repo,
            state: "open",
          });

          // One at a time, so a repository with many updates does not burst.
          for (const pull of pulls.filter(({ user }) => isRenovate(user))) {
            // oxlint-disable-next-line no-await-in-loop -- see above
            await evaluate({
              log: repositoryLog,
              octokit,
              owner,
              precedentScanCache,
              pullNumber: pull.number,
              repo,
              reviewer,
              settings,
            });
          }
        } catch (error) {
          repositoryLog("error", "Renovate update evaluation failed", {
            owner,
            repo,
            ...loggableFailure.safeParse(error).data,
          });
        }
      })
  );
};
