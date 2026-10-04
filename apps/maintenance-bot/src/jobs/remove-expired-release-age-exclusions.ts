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

import { loggableFailure, withFields } from "../log.ts";
import type { Log, LogFields } from "../log.ts";
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
      /** The model that chose the lines, when the rules could not. */
      model?: string;
      source: string;
    }
  | {
      status: "pull-request";
      expired: ExpiredExclusion[];
      editedBy: "model" | "rules";
      /**
       * The model that chose the lines, when the rules could not. It was
       * asked in this run only when `committed` is `true`.
       */
      model?: string;
      /** `false` when the open pull request already held the cleanup. */
      committed: boolean;
      pullRequest: { number: number; url: string; created: boolean };
    }
  | {
      /** A maintainer closed the same cleanup without merging it. */
      status: "declined";
      expired: ExpiredExclusion[];
      pullRequest: { number: number; url: string };
    };

// A change a model helped with discloses it, as every Publira commit and
// pull request does.
const assistedBy = (model: string | undefined) =>
  model === undefined ? [] : ["", `Assisted-by: ${AGENT_NAME}:${model}`];

const ASSISTED_BY = new RegExp(
  `^Assisted-by: ${AGENT_NAME}:(?<model>\\S+)$`,
  "mu"
);

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

interface CleanupPullRequestOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  base: string;
}

/**
 * Finds the most recently opened cleanup pull request in a state. Only one
 * can be open at a time.
 */
const findCleanupPullRequest = async (
  { octokit, owner, repo, base }: CleanupPullRequestOptions,
  state: "open" | "closed"
) => {
  const {
    data: [pullRequest],
  } = await octokit.rest.pulls.list({
    base,
    direction: "desc",
    head: `${owner}:${CLEANUP_BRANCH}`,
    owner,
    per_page: 1,
    repo,
    sort: "created",
    state,
  });

  return pullRequest;
};

interface CleanupProposalOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  baseSha: string;
  /** The head commit of a cleanup pull request. */
  head: string;
}

/**
 * Reads a cleanup pull request's version of the file, and the model its
 * commit names in its Assisted-by trailer, when the pull request holds only
 * a cleanup: a single commit ahead of the base that changes only the file.
 * Anything else on the branch, such as a commit someone pushed, means it is
 * not the bot's cleanup. The base may have moved on since, which leaves the
 * pull request mergeable as it is.
 */
const readCleanupProposal = async ({
  octokit,
  owner,
  repo,
  baseSha,
  head,
}: CleanupProposalOptions) => {
  // The comparison runs from where the branch left the base, so it holds
  // every commit and change the pull request would merge. GitHub keeps the
  // head of a closed pull request even once its branch is deleted.
  const [{ data: comparison }, proposed] = await Promise.all([
    octokit.rest.repos.compareCommitsWithBasehead({
      basehead: `${baseSha}...${head}`,
      owner,
      repo,
    }),
    readOptionalRepositoryFile(octokit, {
      owner,
      path: MANIFEST_PATH,
      ref: head,
      repo,
    }),
  ]);
  const [commit] = comparison.commits;
  const model = commit?.commit.message.match(ASSISTED_BY)?.groups?.model;

  return comparison.ahead_by === 1 &&
    comparison.files?.length === 1 &&
    comparison.files[0]?.filename === MANIFEST_PATH &&
    proposed !== undefined
    ? { model, proposed }
    : undefined;
};

interface ExistingCleanupOptions extends CleanupPullRequestOptions {
  baseSha: string;
  /**
   * Whether an open pull request's version of the file is the cleanup, given
   * the model its commit names in its Assisted-by trailer.
   */
  isCleanup: (proposed: string, model: string | undefined) => boolean;
  /** Whether a closed pull request's version of the file is the cleanup. */
  isDeclined: (proposed: string) => boolean;
}

/**
 * Finds what the cleanup branch already says about the cleanup: an open pull
 * request that holds it, or else the last closed one, which declined it when
 * a maintainer closed it without merging it. A cleanup that differs, such as
 * one with more expired entries, was not declined, and neither was a pull
 * request that held more than a cleanup, which may have been closed for
 * that. Nor was any once a cleanup was merged since, and a closed pull
 * request does not count while a later one is open.
 */
const findExistingCleanup = async ({
  baseSha,
  isCleanup,
  isDeclined,
  ...options
}: ExistingCleanupOptions) => {
  const open = await findCleanupPullRequest(options, "open");

  if (open !== undefined) {
    const proposal = await readCleanupProposal({
      ...options,
      baseSha,
      head: open.head.sha,
    });
    return proposal !== undefined &&
      isCleanup(proposal.proposed, proposal.model)
      ? { model: proposal.model, status: "open" as const }
      : undefined;
  }

  const closed = await findCleanupPullRequest(options, "closed");

  if (closed === undefined || closed.merged_at !== null) {
    return;
  }

  const proposal = await readCleanupProposal({
    ...options,
    baseSha,
    head: closed.head.sha,
  });

  return proposal !== undefined && isDeclined(proposal.proposed)
    ? {
        pullRequest: { number: closed.number, url: closed.html_url },
        status: "declined" as const,
      }
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
 * the same cleanup, or while the last one, closed without merging, held it.
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

  const removal = removeReleaseAgeExclusions(source, selectors);
  const ruleEdit = removal.result === "edited" ? removal.source : undefined;
  const ensureCleanupPullRequest = (model: string | undefined) =>
    ensurePullRequest(octokit, {
      base: baseBranch,
      body: pullRequestBody(expired, manifest.minimumReleaseAge, model),
      head: CLEANUP_BRANCH,
      owner,
      repo,
      title: TITLE,
    });

  // An open pull request that already holds the cleanup does the job, so no
  // edit or model call is needed; only its title and body are restored. When
  // the rules can make the edit, its file must be exactly theirs; otherwise
  // the model that chose its lines must be named. A maintainer who closed the
  // cleanup without merging it declined it, whoever edited its file.
  const existing = dryRun
    ? undefined
    : await findExistingCleanup({
        base: baseBranch,
        baseSha,
        isCleanup: (proposed, model) =>
          ruleEdit === undefined
            ? model !== undefined && verify(proposed).length === 0
            : model === undefined && proposed === ruleEdit,
        isDeclined: (proposed) => verify(proposed).length === 0,
        octokit,
        owner,
        repo,
      });

  if (existing?.status === "declined") {
    return { expired, pullRequest: existing.pullRequest, status: "declined" };
  }

  if (existing?.status === "open") {
    return {
      committed: false,
      editedBy: existing.model === undefined ? "rules" : "model",
      expired,
      model: existing.model,
      pullRequest: await ensureCleanupPullRequest(existing.model),
      status: "pull-request",
    };
  }

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
    return { editedBy, expired, model, source: edited, status: "planned" };
  }

  await commitToBranch(octokit, {
    baseSha,
    branch: CLEANUP_BRANCH,
    files: { [MANIFEST_PATH]: edited },
    message: commitMessage(expired, model),
    owner,
    repo,
  });

  return {
    committed: true,
    editedBy,
    expired,
    model,
    pullRequest: await ensureCleanupPullRequest(model),
    status: "pull-request",
  };
};

/**
 * The fields of a result to log, without the file: which entries expired,
 * the model that chose the lines, and the pull request. Whether a model was
 * asked in this run is up to the caller, which sees its calls.
 */
export const summarizeCleanupResult = (
  result: RemoveExpiredReleaseAgeExclusionsResult
): LogFields => ({
  committed: result.status === "pull-request" ? result.committed : undefined,
  editedBy: "editedBy" in result ? result.editedBy : undefined,
  expired:
    result.status === "nothing-expired"
      ? []
      : result.expired.map(({ selector }) => selector),
  model:
    result.status === "planned" || result.status === "pull-request"
      ? result.model
      : undefined,
  pullRequest: "pullRequest" in result ? result.pullRequest.number : undefined,
  pullRequestCreated:
    result.status === "pull-request" ? result.pullRequest.created : undefined,
  status: result.status,
});

export interface RemoveExpiredReleaseAgeExclusionsEverywhereOptions {
  app: GitHubApp;
  editor?: ExclusionEditor;
  log: Log;
  /** Plans each cleanup without pushing a branch or opening a pull request. */
  dryRun?: boolean;
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
  dryRun = false,
  registry,
  now = new Date(),
  job = removeExpiredReleaseAgeExclusions,
}: RemoveExpiredReleaseAgeExclusionsEverywhereOptions): Promise<void> => {
  const repositories = await listAppRepositories(app);

  await Promise.all(
    repositories
      .filter(({ archived }) => !archived)
      .map(async ({ defaultBranch, installationId, owner, repo }) => {
        const repositoryLog = withFields(log, {
          dryRun,
          installation: installationId,
          job: "remove-expired-release-age-exclusions",
          owner,
          repo,
        });
        // Whether the model was asked, which a failure's line tells too: an
        // edit it chose can still fail the checks, or the call can time out.
        let modelInvoked = false;
        const trackedEditor: ExclusionEditor | undefined =
          editor === undefined
            ? undefined
            : (request) => {
                modelInvoked = true;
                return editor(request);
              };
        try {
          const result = await job({
            base: defaultBranch,
            dryRun,
            editor: trackedEditor,
            now,
            octokit: await app.getInstallationOctokit(installationId),
            owner,
            registry,
            repo,
          });
          repositoryLog("info", "Release age exclusions checked", {
            ...summarizeCleanupResult(result),
            modelInvoked,
          });
        } catch (error) {
          repositoryLog("error", "Release age exclusion cleanup failed", {
            ...loggableFailure.safeParse(error).data,
            modelInvoked,
          });
        }
      })
  );
};
