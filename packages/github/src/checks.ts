import type { Octokit } from "@octokit/rest";

export interface CheckRunState {
  name: string;
  /** The App that reports the check, such as `github-actions`. */
  appSlug: string | undefined;
  status: string;
  /** `null` until the run completes. */
  conclusion: string | null;
}

export interface CommitStatusState {
  context: string;
  state: string;
}

export interface CommitChecks {
  /** The latest run of each check. */
  checkRuns: CheckRunState[];
  /** The latest status of each context. */
  statuses: CommitStatusState[];
}

export interface CommitLocation {
  owner: string;
  repo: string;
  /** A commit SHA, branch, or tag. */
  ref: string;
}

/** Reads the check runs and commit statuses reported for a commit. */
export const getCommitChecks = async (
  octokit: Octokit,
  { owner, repo, ref }: CommitLocation
): Promise<CommitChecks> => {
  const [checkRuns, statuses] = await Promise.all([
    octokit.paginate(octokit.rest.checks.listForRef, {
      filter: "latest",
      owner,
      per_page: 100,
      ref,
      repo,
    }),
    // Newest first, with every status a context ever reported.
    octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, {
      owner,
      per_page: 100,
      ref,
      repo,
    }),
  ]);
  const latestStatuses = new Map<string, CommitStatusState>();

  for (const { context, state } of statuses) {
    if (!latestStatuses.has(context)) {
      latestStatuses.set(context, { context, state });
    }
  }

  return {
    checkRuns: checkRuns.map((run) => ({
      appSlug: run.app?.slug,
      conclusion: run.conclusion,
      name: run.name,
      status: run.status,
    })),
    statuses: [...latestStatuses.values()],
  };
};

export interface RequiredStatusCheck {
  context: string;
  /** The App that must report it; any App may when it is `undefined`. */
  integrationId: number | undefined;
}

export interface BranchLocation {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * Lists the status checks the repository's and organization's rulesets
 * require on a branch. Classic branch protection is not read: it needs the
 * Administration permission.
 */
export const getRequiredStatusChecks = async (
  octokit: Octokit,
  { owner, repo, branch }: BranchLocation
): Promise<RequiredStatusCheck[]> => {
  const rules = await octokit.paginate(octokit.rest.repos.getBranchRules, {
    branch,
    owner,
    per_page: 100,
    repo,
  });
  const required = new Map<string, RequiredStatusCheck>();

  for (const rule of rules) {
    if (rule.type === "required_status_checks") {
      for (const check of rule.parameters?.required_status_checks ?? []) {
        const key = `${check.context}\0${check.integration_id ?? ""}`;
        required.set(key, {
          context: check.context,
          integrationId: check.integration_id,
        });
      }
    }
  }

  return [...required.values()];
};
