import {
  createRepositoryReadToken,
  listAppRepositories,
} from "@publira/github";
import type { GitHubApp, Octokit } from "@publira/github";
import { isRenovate } from "@publira/maintenance-policies";

import { loggableFailure, withFields } from "../log.ts";
import type { Log } from "../log.ts";
import type { SandboxRunner } from "../sandbox-runner.ts";
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
  regenerateGeneratedOutput,
  summarizeRegenerationResult,
} from "./regenerate-generated-output.ts";
import type { RegenerateGeneratedOutputResult } from "./regenerate-generated-output.ts";
import {
  summarizeLockFileSyncResult,
  syncDevContainerLockFile,
} from "./sync-devcontainer-lock-file.ts";
import type { SyncDevContainerLockFileResult } from "./sync-devcontainer-lock-file.ts";

export interface RenovateUpdateJobs {
  syncLockFile: typeof syncDevContainerLockFile;
  regenerate: typeof regenerateGeneratedOutput;
  approve: typeof approveEquivalentRenovateUpdate;
  autoMerge: typeof autoMergeRenovateUpdate;
}

// The outcomes after which the head the evaluation read is not the one to
// decide on: the bot's lock file commit moves it, or would in a dry run, or it
// moved already. The push is delivered as `synchronize` and evaluated then.
const DEFERRING_SYNC_STATUSES = new Set<
  SyncDevContainerLockFileResult["status"]
>(["committed", "head-moved", "would-commit"]);

// The same for the bot's commit of regenerated output.
const DEFERRING_REGENERATION_STATUSES = new Set<
  RegenerateGeneratedOutputResult["status"]
>(["committed", "head-moved", "would-commit"]);

/** What the evaluation regenerates a repository's generated output with. */
export interface Regeneration {
  sandbox: SandboxRunner;
  /** Creates a token that can only read the repository; see the job. */
  createReadToken: () => Promise<string>;
}

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
  /**
   * Runs the repository's generators when the pull request calls for it.
   * Without it, the evaluation leaves the output as it is: one that the head
   * did not change, such as a check's completion, has no new output to
   * regenerate, and the push's evaluation already did.
   */
  regeneration?: Regeneration;
  precedentScanCache?: PrecedentScanCache;
  /** Replaced in tests. */
  jobs?: Partial<RenovateUpdateJobs>;
}

interface RegenerateOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  reviewer: string;
  dryRun: boolean;
  log: Log;
  regeneration: Regeneration;
  regenerate: typeof regenerateGeneratedOutput;
}

/**
 * Regenerates a pull request's generated output and logs the outcome or the
 * failure. Tells whether approval and auto-merge wait for the push of the
 * bot's commit.
 */
const regenerateAndLog = async ({
  octokit,
  owner,
  repo,
  pullNumber,
  reviewer,
  dryRun,
  log,
  regeneration,
  regenerate,
}: RegenerateOptions): Promise<boolean> => {
  const regenerationLog = withFields(log, {
    dryRun,
    job: "regenerate-generated-output",
    owner,
    pullRequest: pullNumber,
    repo,
  });
  try {
    const result = await regenerate({
      ...regeneration,
      botLogin: reviewer,
      dryRun,
      octokit,
      owner,
      pullNumber,
      repo,
    });
    const deferred = DEFERRING_REGENERATION_STATUSES.has(result.status);
    regenerationLog(
      result.status === "failed" ? "warn" : "info",
      "Generated output regeneration evaluated",
      { ...summarizeRegenerationResult(result), evaluationDeferred: deferred }
    );
    return deferred;
  } catch (error) {
    // The output stays as it is; the repository's CI tells whether it is
    // stale, and approval waits for CI.
    regenerationLog(
      "error",
      "Generated output regeneration failed",
      loggableFailure.safeParse(error).data
    );
    return false;
  }
};

/**
 * Evaluates one Renovate pull request: syncs the Dev Container lock files
 * with the Features it bumps, regenerates the output of the generators it
 * updates, approves it when it is the same update a maintainer approved
 * elsewhere, then has it auto-merged when that is on and allowed. A head that
 * the bot commits to, or would in a dry run, is neither approved nor merged:
 * the commit's push is evaluated instead. The
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
  regeneration,
  precedentScanCache,
  jobs: {
    syncLockFile = syncDevContainerLockFile,
    regenerate = regenerateGeneratedOutput,
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

  if (
    regeneration !== undefined &&
    (await regenerateAndLog({
      dryRun,
      log,
      octokit,
      owner,
      pullNumber,
      regenerate,
      regeneration,
      repo,
      reviewer,
    }))
  ) {
    return;
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
  /** Regenerates generated output in this sandbox; see `regeneration`. */
  sandbox?: SandboxRunner;
  /** Replaced in tests. */
  evaluate?: typeof evaluateRenovateUpdate;
  /** Replaced in tests. */
  regenerate?: typeof regenerateGeneratedOutput;
}

/**
 * How many regenerations of one repository the sweep runs at once. Each can
 * hold a sandbox for up to 240 seconds, close to the 300 the function running
 * the sweep has, so one after another, a slow one would leave the next too
 * little time, every hour again.
 */
export const SWEEP_REGENERATION_CONCURRENCY = 4;

// Runs a task for each item, at most `limit` at once.
const forEachConcurrently = async <T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
) => {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        // oxlint-disable-next-line no-await-in-loop -- one per worker at a time
        await task(item);
      }
    })
  );
};

/**
 * Runs {@link evaluateRenovateUpdate} on every open Renovate pull request in
 * the unarchived repositories the App is installed on. A repository that
 * fails is logged, and the others still run.
 *
 * With a sandbox, it first regenerates the generated output of a
 * repository's pull requests, a few at a time, and then evaluates the rest
 * one at a time; a pull request whose head the regeneration moves, or would
 * in a dry run, is left to the push's evaluation.
 */
export const evaluateRenovateUpdatesEverywhere = async ({
  app,
  log,
  settings,
  headRef,
  sandbox,
  evaluate = evaluateRenovateUpdate,
  regenerate = regenerateGeneratedOutput,
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

          const renovatePulls = pulls
            .filter(({ user }) => isRenovate(user))
            .map(({ number }) => number);
          const deferred = new Set<number>();

          if (sandbox !== undefined) {
            const regeneration = {
              createReadToken: () =>
                createRepositoryReadToken(app, { installationId, repo }),
              sandbox,
            };
            await forEachConcurrently(
              renovatePulls,
              SWEEP_REGENERATION_CONCURRENCY,
              async (pullNumber) => {
                if (
                  await regenerateAndLog({
                    dryRun: settings.dryRun,
                    log: repositoryLog,
                    octokit,
                    owner,
                    pullNumber,
                    regenerate,
                    regeneration,
                    repo,
                    reviewer,
                  })
                ) {
                  deferred.add(pullNumber);
                }
              }
            );
          }

          // One at a time, so a repository with many updates does not burst.
          for (const pullNumber of renovatePulls) {
            if (!deferred.has(pullNumber)) {
              // oxlint-disable-next-line no-await-in-loop -- see above
              await evaluate({
                log: repositoryLog,
                octokit,
                owner,
                precedentScanCache,
                pullNumber,
                repo,
                reviewer,
                settings,
              });
            }
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
