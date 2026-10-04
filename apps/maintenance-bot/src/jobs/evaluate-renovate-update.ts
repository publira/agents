import { listAppRepositories } from "@publira/github";
import type { GitHubApp, Octokit } from "@publira/github";
import { isRenovate } from "@publira/maintenance-policies";

import { loggableFailure } from "../log.ts";
import type { Log } from "../log.ts";
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

export interface EvaluateRenovateUpdateOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /** The App's bot login, which approves and merges. */
  reviewer: string;
  /** Whether auto-merge is on; see `readRenovateAutoMerge`. */
  autoMerge: boolean;
  log: Log;
  precedentScanCache?: PrecedentScanCache;
  /** Replaced in tests. */
  jobs?: Partial<RenovateUpdateJobs>;
}

/**
 * Evaluates one Renovate pull request: approves it when it is the same update
 * a maintainer approved elsewhere, then has it auto-merged when that is on and
 * allowed. The auto-merge runs even when the approval did not, to take back a
 * decision a new head made stale. Both log their outcome and failure, and
 * neither throws.
 */
export const evaluateRenovateUpdate = async ({
  octokit,
  owner,
  repo,
  pullNumber,
  reviewer,
  autoMerge: enabled,
  log,
  precedentScanCache,
  jobs: {
    approve = approveEquivalentRenovateUpdate,
    autoMerge = autoMergeRenovateUpdate,
  } = {},
}: EvaluateRenovateUpdateOptions): Promise<void> => {
  const fields = { owner, pullRequest: pullNumber, repo };
  const location = { octokit, owner, precedentScanCache, pullNumber, repo };

  try {
    const result = await approve({ ...location, reviewer });
    log("info", "Renovate update evaluated", {
      ...fields,
      ...summarizeApprovalResult(result),
    });
  } catch (error) {
    log("error", "Renovate update approval failed", {
      ...fields,
      ...loggableFailure.safeParse(error).data,
    });
  }

  try {
    const result = await autoMerge({ ...location, enabled, reviewer });
    // With auto-merge off and nothing to take back, there is nothing to tell.
    if (result.status !== "disabled") {
      log(
        result.status === "refused" ? "warn" : "info",
        "Renovate update auto-merge evaluated",
        { ...fields, ...summarizeAutoMergeResult(result) }
      );
    }
  } catch (error) {
    log("error", "Renovate update auto-merge failed", {
      ...fields,
      ...loggableFailure.safeParse(error).data,
    });
  }
};

export interface EvaluateRenovateUpdatesEverywhereOptions {
  app: GitHubApp;
  log: Log;
  /** Whether auto-merge is on; see `readRenovateAutoMerge`. */
  autoMerge: boolean;
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
  autoMerge,
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
              autoMerge,
              log,
              octokit,
              owner,
              precedentScanCache,
              pullNumber: pull.number,
              repo,
              reviewer,
            });
          }
        } catch (error) {
          log("error", "Renovate update evaluation failed", {
            owner,
            repo,
            ...loggableFailure.safeParse(error).data,
          });
        }
      })
  );
};
