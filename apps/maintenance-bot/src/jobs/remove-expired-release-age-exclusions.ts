import {
  commitToBranch,
  ensurePullRequest,
  listAppRepositories,
  readOptionalRepositoryFile,
} from "@publira/github";
import type { GitHubApp, Octokit } from "@publira/github";
import type { RegistryOptions } from "@publira/npm-registry";
import {
  deleteBlockLines,
  parseWorkspaceManifest,
  removeReleaseAgeExclusions,
  verifyReleaseAgeExclusionRemoval,
} from "@publira/pnpm-workspace";

import { loggableFailure } from "../log.ts";
import type { Log } from "../log.ts";
import { judgeReleaseAgeExclusions } from "./check-release-age-exclusions.ts";
import type { ReleaseAgeExclusionReport } from "./check-release-age-exclusions.ts";

const MANIFEST_PATH = "pnpm-workspace.yaml";

/** The branch the cleanup pull request comes from. */
export const CLEANUP_BRANCH =
  "maintenance-bot/remove-expired-release-age-exclusions";

const TITLE = "chore(deps): remove expired minimumReleaseAgeExclude entries";

// The name the bot discloses model help under, as the Assisted-by trailers
// of Publira repositories do.
const AGENT_NAME = "publira-maintenance-bot";

export interface ExclusionEditRequest {
  /** The `minimumReleaseAgeExclude` block; line 1 is the first. */
  lines: readonly string[];
  /** The entries to remove, already judged expired. */
  selectors: readonly string[];
  /** Why the rules could not make the edit. */
  reason: string;
}

export interface ExclusionEdit {
  /** The lines of the block to delete; line 1 is the first. */
  lineNumbers: number[];
  /** The model that chose them, such as `anthropic/claude-sonnet-5.5`. */
  model: string;
}

/**
 * Chooses the lines of a block to delete when the rules cannot tell which
 * comments go with the removed entries. It returns line numbers within the
 * block, so it can only delete lines, and the result is checked like any
 * other edit.
 */
export type ExclusionEditor = (
  request: ExclusionEditRequest
) => Promise<ExclusionEdit>;

export interface RemoveExpiredReleaseAgeExclusionsOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  /** The branch to clean up. Defaults to the default branch. */
  base?: string;
  registry?: RegistryOptions;
  now?: Date;
  /** Without one, a repository whose edit is ambiguous fails. */
  editor?: ExclusionEditor;
  /** Plans the edit without pushing a branch or opening a pull request. */
  dryRun?: boolean;
}

export interface ExpiredExclusion {
  selector: string;
  /** When pnpm started installing every version it pins without it. */
  availableAt: Date;
}

export type RemoveExpiredReleaseAgeExclusionsResult =
  | { status: "nothing-expired"; reports: ReleaseAgeExclusionReport[] }
  | {
      status: "planned";
      expired: ExpiredExclusion[];
      editedBy: "model" | "rules";
      source: string;
    }
  | {
      status: "pull-request";
      expired: ExpiredExclusion[];
      /** `undefined` when an open pull request already held the cleanup. */
      editedBy: "model" | "rules" | undefined;
      pullRequest: { number: number; url: string; created: boolean };
    };

// A change a model helped with discloses it, as every Publira commit and
// pull request does.
const assistedBy = (model: string | undefined) =>
  model === undefined ? [] : ["", `Assisted-by: ${AGENT_NAME}:${model}`];

const commitMessage = (
  expired: readonly ExpiredExclusion[],
  model: string | undefined
) =>
  [
    TITLE,
    "",
    "Every version these entries pin is older than minimumReleaseAge now:",
    "",
    ...expired.map(({ selector }) => `- ${selector}`),
    ...assistedBy(model),
  ].join("\n");

const pullRequestBody = (
  expired: readonly ExpiredExclusion[],
  minimumReleaseAge: number,
  model: string | undefined
) =>
  [
    "## Summary",
    "",
    `These \`minimumReleaseAgeExclude\` entries in \`${MANIFEST_PATH}\` let pnpm install versions published less than \`minimumReleaseAge\` (${minimumReleaseAge} minutes) ago. Every version they pin is older than that now, so pnpm installs it without the exemption, and the entries can go:`,
    "",
    "| Entry | Installable without it since |",
    "| --- | --- |",
    ...expired.map(
      ({ selector, availableAt }) =>
        `| \`${selector}\` | ${availableAt.toISOString()} |`
    ),
    "",
    "Removing them puts these packages back under the release-age check. The comments that described only these entries go with them.",
    "",
    "## Verification",
    "",
    "- The publish times come from the npm registry.",
    model === undefined
      ? "- The edit follows fixed rules; no model was involved."
      : "- The rules could not tell which comments belong to these entries, so a model chose the lines to delete. It can only delete lines, and it did not decide which entries expired.",
    "- The edited file parses, these entries are gone, and every other entry and setting, `minimumReleaseAge` included, keeps its value.",
    "",
    "The maintenance bot opened this pull request. It updates the branch when the cleanup changes.",
    ...assistedBy(model),
  ].join("\n");

interface CurrentPullRequestOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  base: string;
  /** Whether a version of the file removes exactly the expired entries. */
  isCleanup: (proposed: string) => boolean;
}

/**
 * Finds the open cleanup pull request when it already holds the cleanup: one
 * commit that changes only the file, and a file that removes exactly the
 * expired entries from the current one. Anything else on the branch, such as
 * a commit someone pushed, means the branch has to be replaced.
 */
const findCurrentPullRequest = async ({
  octokit,
  owner,
  repo,
  base,
  isCleanup,
}: CurrentPullRequestOptions) => {
  const { data: open } = await octokit.rest.pulls.list({
    base,
    head: `${owner}:${CLEANUP_BRANCH}`,
    owner,
    repo,
    state: "open",
  });
  const [pullRequest] = open;

  if (pullRequest === undefined) {
    return;
  }

  const [{ data: head }, proposed] = await Promise.all([
    octokit.rest.repos.getCommit({ owner, ref: pullRequest.head.sha, repo }),
    readOptionalRepositoryFile(octokit, {
      owner,
      path: MANIFEST_PATH,
      ref: pullRequest.head.sha,
      repo,
    }),
  ]);
  const changesOnlyTheFile =
    head.parents.length === 1 &&
    head.files?.length === 1 &&
    head.files[0]?.filename === MANIFEST_PATH;

  return changesOnlyTheFile && proposed !== undefined && isCleanup(proposed)
    ? pullRequest
    : undefined;
};

/**
 * Removes the `minimumReleaseAgeExclude` entries of a repository's
 * `pnpm-workspace.yaml` whose pinned versions are all older than
 * `minimumReleaseAge`, and opens a pull request with the change.
 *
 * The npm registry decides which entries expired. A repository without
 * expired entries ends there, without a model call or a write. The edit
 * follows fixed rules, and only when they cannot tell which comments go with
 * the entries does `editor` choose the lines to delete; either way the result
 * is checked before anything is pushed.
 *
 * Running it again changes nothing while the open pull request still holds
 * the same cleanup.
 */
export const removeExpiredReleaseAgeExclusions = async ({
  octokit,
  owner,
  repo,
  base,
  registry,
  now = new Date(),
  editor,
  dryRun = false,
}: RemoveExpiredReleaseAgeExclusionsOptions): Promise<RemoveExpiredReleaseAgeExclusionsResult> => {
  const getDefaultBranch = async () => {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return data.default_branch;
  };
  const baseBranch = base ?? (await getDefaultBranch());
  const {
    data: {
      commit: { sha: baseSha },
    },
  } = await octokit.rest.repos.getBranch({ branch: baseBranch, owner, repo });
  const at = { owner, ref: baseSha, repo };
  const source = await readOptionalRepositoryFile(octokit, {
    ...at,
    path: MANIFEST_PATH,
  });

  if (source === undefined) {
    return { reports: [], status: "nothing-expired" };
  }

  const manifest = parseWorkspaceManifest(source);

  if (manifest.minimumReleaseAgeExclude.length === 0) {
    return { reports: [], status: "nothing-expired" };
  }

  const reports = await judgeReleaseAgeExclusions({
    manifest,
    now,
    npmrc: await readOptionalRepositoryFile(octokit, { ...at, path: ".npmrc" }),
    registry,
  });
  const expired = reports.flatMap(({ selector, verdict }) =>
    verdict.action === "expired"
      ? [{ availableAt: verdict.availableAt, selector }]
      : []
  );

  if (expired.length === 0) {
    return { reports, status: "nothing-expired" };
  }

  const selectors = expired.map(({ selector }) => selector);
  const verify = (edited: string) =>
    verifyReleaseAgeExclusionRemoval(source, edited, selectors);

  // An open pull request that already holds the cleanup does the job, so no
  // edit or model call is needed.
  const current = dryRun
    ? undefined
    : await findCurrentPullRequest({
        base: baseBranch,
        isCleanup: (proposed) => verify(proposed).length === 0,
        octokit,
        owner,
        repo,
      });

  if (current !== undefined) {
    return {
      editedBy: undefined,
      expired,
      pullRequest: {
        created: false,
        number: current.number,
        url: current.html_url,
      },
      status: "pull-request",
    };
  }

  const removal = removeReleaseAgeExclusions(source, selectors);
  let edited: string;
  let model: string | undefined;

  if (removal.result === "edited") {
    edited = removal.source;
  } else {
    if (editor === undefined) {
      throw new Error(
        `${owner}/${repo}: the rules cannot remove the expired entries (${removal.reason}), and no editor was given`
      );
    }
    const edit = await editor({
      lines: removal.block.lines,
      reason: removal.reason,
      selectors,
    });
    edited = deleteBlockLines(source, removal.block, edit.lineNumbers);
    ({ model } = edit);
  }

  const editedBy = model === undefined ? "rules" : "model";
  const problems = verify(edited);

  if (problems.length > 0) {
    throw new Error(
      `${owner}/${repo}: the ${editedBy === "model" ? "model's" : "rules'"} edit of ${MANIFEST_PATH} is wrong: ${problems.join("; ")}`
    );
  }

  if (dryRun) {
    return { editedBy, expired, source: edited, status: "planned" };
  }

  await commitToBranch(octokit, {
    baseSha,
    branch: CLEANUP_BRANCH,
    files: { [MANIFEST_PATH]: edited },
    message: commitMessage(expired, model),
    owner,
    repo,
  });
  const pullRequest = await ensurePullRequest(octokit, {
    base: baseBranch,
    body: pullRequestBody(expired, manifest.minimumReleaseAge, model),
    head: CLEANUP_BRANCH,
    owner,
    repo,
    title: TITLE,
  });

  return { editedBy, expired, pullRequest, status: "pull-request" };
};

export interface RemoveExpiredReleaseAgeExclusionsEverywhereOptions {
  app: GitHubApp;
  editor?: ExclusionEditor;
  log: Log;
  registry?: RegistryOptions;
  now?: Date;
  /** Replaced in tests. */
  job?: typeof removeExpiredReleaseAgeExclusions;
}

/**
 * Runs {@link removeExpiredReleaseAgeExclusions} on the default branch of
 * every unarchived repository the App is installed on. A repository that
 * fails is logged, and the others still run.
 */
export const removeExpiredReleaseAgeExclusionsEverywhere = async ({
  app,
  editor,
  log,
  registry,
  now = new Date(),
  job = removeExpiredReleaseAgeExclusions,
}: RemoveExpiredReleaseAgeExclusionsEverywhereOptions): Promise<void> => {
  const repositories = await listAppRepositories(app);

  await Promise.all(
    repositories
      .filter(({ archived }) => !archived)
      .map(async ({ defaultBranch, installationId, owner, repo }) => {
        try {
          const result = await job({
            base: defaultBranch,
            editor,
            now,
            octokit: await app.getInstallationOctokit(installationId),
            owner,
            registry,
            repo,
          });
          log("info", "Release age exclusions checked", {
            editedBy:
              result.status === "pull-request" ? result.editedBy : undefined,
            expired:
              result.status === "nothing-expired" ? 0 : result.expired.length,
            owner,
            pullRequest:
              result.status === "pull-request"
                ? result.pullRequest.number
                : undefined,
            repo,
            status: result.status,
          });
        } catch (error) {
          log("error", "Release age exclusion cleanup failed", {
            owner,
            repo,
            ...loggableFailure.safeParse(error).data,
          });
        }
      })
  );
};
