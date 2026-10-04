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

export interface RenovateUpdateJobs {
  approve: typeof approveEquivalentRenovateUpdate;
  autoMerge: typeof autoMergeRenovateUpdate;
}

/** The settings that decide what the evaluation may do; see `readSettings`. */
export type RenovateUpdateSettings = Pick<
  Settings,
  "dryRun" | "renovateApproval" | "renovateAutoMerge"
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
 * Evaluates one Renovate pull request: approves it when it is the same update
 * a maintainer approved elsewhere and approval is on, then has it
 * auto-merged when that is on and allowed. The auto-merge runs even when the
 * approval did not, or auto-merge is off, to take back a decision a new head
 * made stale. In a dry run, both only log what they would do. Both log their
 * outcome and failure, and neither throws.
 */
export const evaluateRenovateUpdate = async ({
  octokit,
  owner,
  repo,
  pullNumber,
  reviewer,
  settings: { dryRun, renovateApproval, renovateAutoMerge },
  log,
  precedentScanCache,
  jobs: {
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

  if (renovateApproval) {
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
    // With auto-merge off and nothing to take back, there is nothing to tell.
    if (result.status !== "disabled") {
      autoMergeLog(
        result.status === "refused" ? "warn" : "info",
        "Renovate update auto-merge evaluated",
        summarizeAutoMergeResult(result)
      );
    }
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
