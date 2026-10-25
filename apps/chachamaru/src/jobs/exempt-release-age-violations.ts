import {
  addCommitToBranch,
  ensureIssueComment,
  getRepositoryPermission,
  minimizeOutdatedIssueComments,
  readOptionalRepositoryFile,
} from "@publira/github";
import type { EnsureIssueCommentResult, Octokit } from "@publira/github";
import {
  findApprovedReleaseAgeExemption,
  formatReleaseAgeExemptionApprovalMarker,
  formatReleaseAgeExemptionMarker,
  isMaintainerPermission,
  isRenovate,
  parseReleaseAgeExemptionQuestion,
  pendingReleaseAgeExemptionEntries,
  RELEASE_AGE_EXEMPTION_MARKER_START,
  releaseAgeExemptionEntries,
  releaseAgeExemptionHeadMarker,
  requestsReleaseAgeExemption,
} from "@publira/maintenance-policies";
import type {
  ReleaseAgeExemptionEntry,
  ReleaseAgeExemptionQuestion,
  ReleaseAgeViolationsReading,
} from "@publira/maintenance-policies";
import {
  addReleaseAgeExclusions,
  parseWorkspaceManifest,
} from "@publira/pnpm-workspace";

import { loggableFailure } from "#runtime/log.ts";
import type { LogFields } from "#runtime/log.ts";

const MANIFEST_PATH = "pnpm-workspace.yaml";

interface PullRequestOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /** The App's bot login, which asks, and which a request mentions. */
  botLogin: string;
  /** Decides and logs without commenting or committing. */
  dryRun?: boolean;
  /** Replaced in tests. */
  now?: Date;
}

/**
 * How many of the bot's questions it minimized as outdated, why it left
 * them, or why it could not.
 */
export type OutdatedQuestions =
  | { minimized: number }
  | { skipped: string }
  | { error: string; status?: number };

/** What became of the entries a maintainer approved. */
export type ExemptionCommitResult =
  | {
      /** The workspace's list is not in a form the bot can add to. */
      status: "refused";
      headSha: string;
      entries: string[];
      reason: string;
    }
  | {
      status: "would-commit";
      headSha: string;
      entries: string[];
      approvedIn: string;
      subject: string;
    }
  | {
      status: "committed";
      headSha: string;
      entries: string[];
      approvedIn: string;
      commitSha: string;
      outdatedQuestions: OutdatedQuestions;
    }
  | {
      /** The branch moved while the job ran; its push is evaluated anew. */
      status: "head-moved";
      headSha: string;
      entries: string[];
      approvedIn: string;
    };

export type AskReleaseAgeExemptionResult =
  | { status: "skipped"; headSha: string; reason: string }
  | { status: "would-ask"; headSha: string; entries: string[] }
  | {
      status: "asked";
      headSha: string;
      entries: string[];
      comment: EnsureIssueCommentResult;
      /** The questions on earlier heads, once it posted this one. */
      outdatedQuestions?: OutdatedQuestions;
    }
  | ExemptionCommitResult;

export type ApproveReleaseAgeExemptionResult =
  | { status: "skipped"; headSha?: string; reason: string }
  | ExemptionCommitResult;

interface IssueComment {
  id: number;
  body: string;
  author: string | undefined;
}

interface PostedQuestion extends ReleaseAgeExemptionQuestion {
  comment: IssueComment;
}

const listComments = async ({
  octokit,
  owner,
  repo,
  pullNumber,
}: PullRequestOptions): Promise<IssueComment[]> => {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    issue_number: pullNumber,
    owner,
    per_page: 100,
    repo,
  });

  return comments
    .map(({ id, body, user }) => ({
      author: user?.login,
      body: body ?? "",
      id,
    }))
    .toSorted((a, b) => a.id - b.id);
};

// The questions the bot asked, oldest first. Only the bot's own count, so
// nobody else can write an approval into one.
const questionsOf = (
  comments: readonly IssueComment[],
  botLogin: string
): PostedQuestion[] =>
  comments.flatMap((comment) => {
    const question =
      comment.author === botLogin
        ? parseReleaseAgeExemptionQuestion(comment.body)
        : undefined;

    return question === undefined ? [] : [{ ...question, comment }];
  });

const readManifest = async (
  { octokit, owner, repo }: PullRequestOptions,
  headSha: string
) => {
  const source = await readOptionalRepositoryFile(octokit, {
    owner,
    path: MANIFEST_PATH,
    ref: headSha,
    repo,
  });

  return source === undefined
    ? undefined
    : { manifest: parseWorkspaceManifest(source), source };
};

const selectorsOf = (entries: readonly ReleaseAgeExemptionEntry[]) =>
  entries.map(({ selector }) => selector);

// A selector's package name: what comes before the version's `@`.
const packageOf = (selector: string) =>
  selector.slice(0, selector.lastIndexOf("@"));

const mentionOf = (botLogin: string) => `@${botLogin.replace(/\[bot\]$/u, "")}`;

const questionBody = (
  headSha: string,
  entries: readonly ReleaseAgeExemptionEntry[],
  {
    botLogin,
    minimumReleaseAge,
  }: { botLogin: string; minimumReleaseAge: number }
) =>
  [
    formatReleaseAgeExemptionMarker(headSha, entries),
    `pnpm refuses to install ${headSha}: these versions were published less than \`minimumReleaseAge\` (${minimumReleaseAge} minutes) ago. Chachamaru can add them to \`minimumReleaseAgeExclude\` in \`pnpm-workspace.yaml\` on this branch, so that the pull request installs before then:`,
    "",
    "| Entry | Installs without it from |",
    "| --- | --- |",
    ...entries.map(
      ({ selector, availableAt }) =>
        `| \`${selector}\` | ${availableAt.toISOString()} |`
    ),
    "",
    `To add them, reply with a comment that mentions the bot and says to add them, such as \`${mentionOf(botLogin)} add\`. Only a reply from someone who can write to this repository counts, and Chachamaru adds nothing on its own. Without the entries, the pull request installs once Renovate rebases it after the versions are old enough.`,
  ].join("\n");

/**
 * Minimizes the bot's questions on the pull request as outdated: those
 * posted before the given one, or, once the bot committed the entries, all
 * of them. It does so only while the pull request's head is still the given
 * one, so a run that a newer head overtook leaves that head's question alone.
 */
const minimizeEarlierQuestions = async (
  { octokit, owner, repo, pullNumber, botLogin }: PullRequestOptions,
  head: string,
  commentId?: number
): Promise<OutdatedQuestions> => {
  try {
    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner,
      pull_number: pullNumber,
      repo,
    });

    if (pullRequest.head.sha !== head) {
      return { skipped: "the head moved" };
    }

    return {
      minimized: await minimizeOutdatedIssueComments(octokit, {
        author: botLogin,
        commentId,
        issueNumber: pullNumber,
        marker: RELEASE_AGE_EXEMPTION_MARKER_START,
        owner,
        repo,
      }),
    };
  } catch (error) {
    // The comment or the commit stands; the earlier questions only stay
    // expanded.
    return loggableFailure.safeParse(error).data ?? { error: "unknown" };
  }
};

interface CommitRequest {
  branch: string;
  headSha: string;
  /** The workspace file at the head. */
  source: string;
  entries: readonly ReleaseAgeExemptionEntry[];
  /** The comment that approved the entries. */
  approvedIn: string;
}

/**
 * Adds the entries to `minimumReleaseAgeExclude` at the head, on top of it
 * and only as a fast-forward, with a comment that says why and links the
 * approval.
 */
const commitExemption = async (
  options: PullRequestOptions,
  { branch, headSha, source, entries, approvedIn }: CommitRequest
): Promise<ExemptionCommitResult> => {
  const { octokit, owner, repo, pullNumber, dryRun = false } = options;
  const selectors = selectorsOf(entries);
  const decided = { approvedIn, entries: selectors, headSha };

  const addition = addReleaseAgeExclusions(source, selectors, [
    `Exempted for #${pullNumber}, a Renovate update, on a maintainer's approval:`,
    approvedIn,
  ]);

  if (addition.result === "refused") {
    return {
      entries: selectors,
      headSha,
      reason: addition.reason,
      status: "refused",
    };
  }

  const subject = `chore(deps): exempt ${[...new Set(selectors.map(packageOf))].join(", ")} from minimumReleaseAge`;

  if (dryRun) {
    return { ...decided, status: "would-commit", subject };
  }

  const commit = await addCommitToBranch(octokit, {
    branch,
    files: { [MANIFEST_PATH]: addition.source },
    headSha,
    message: [
      subject,
      "",
      `pnpm refused to install these versions on ${headSha} until they are older than minimumReleaseAge:`,
      "",
      ...entries.map(
        ({ selector, availableAt }) =>
          `- ${selector}, installable without the entry from ${availableAt.toISOString()}`
      ),
      "",
      `A maintainer asked to exempt them in ${approvedIn}.`,
    ].join("\n"),
    owner,
    repo,
  });

  return commit.status === "moved"
    ? { ...decided, status: "head-moved" }
    : {
        ...decided,
        commitSha: commit.sha,
        outdatedQuestions: await minimizeEarlierQuestions(options, commit.sha),
        status: "committed",
      };
};

export interface AskReleaseAgeExemptionOptions extends PullRequestOptions {
  /** The head whose install failed. */
  headSha: string;
  /** What the install's output says about the release age. */
  reading: Exclude<ReleaseAgeViolationsReading, { result: "none" }>;
}

/**
 * Asks on a Renovate pull request, once for the head, whether to add the
 * versions that pnpm refused for `minimumReleaseAge` to
 * `minimumReleaseAgeExclude`. It adds nothing on its own, except the entries
 * a maintainer already approved on the pull request for the same versions,
 * such as before Renovate rewrote the branch and dropped the bot's commit.
 * Once it posted the question, it minimizes its questions on the earlier
 * heads as outdated. No model is asked.
 */
export const askReleaseAgeExemption = async (
  options: AskReleaseAgeExemptionOptions
): Promise<AskReleaseAgeExemptionResult> => {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    botLogin,
    headSha,
    reading,
    dryRun = false,
    now = new Date(),
  } = options;

  const skip = (reason: string) =>
    ({ headSha, reason, status: "skipped" }) as const;

  if (reading.result === "unreadable") {
    return skip(reading.reason);
  }

  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    pull_number: pullNumber,
    repo,
  });

  if (pullRequest.head.sha !== headSha) {
    return skip("the head moved");
  }

  const workspace = await readManifest(options, headSha);

  if (workspace === undefined) {
    return skip(`the head has no ${MANIFEST_PATH}`);
  }

  const { manifest, source } = workspace;

  const entries = pendingReleaseAgeExemptionEntries(
    releaseAgeExemptionEntries({
      minimumReleaseAge: manifest.minimumReleaseAge,
      now,
      violations: reading.violations,
    }),
    { excluded: manifest.minimumReleaseAgeExclude, now }
  );

  if (entries.length === 0) {
    return skip("no refused version needs an entry any more");
  }

  const selectors = selectorsOf(entries);

  const approved = findApprovedReleaseAgeExemption(
    questionsOf(await listComments(options), botLogin),
    selectors
  );

  if (approved?.approvedIn !== undefined) {
    return commitExemption(options, {
      approvedIn: approved.approvedIn,
      branch: pullRequest.head.ref,
      entries,
      headSha,
      source,
    });
  }

  if (dryRun) {
    return { entries: selectors, headSha, status: "would-ask" };
  }

  const comment = await ensureIssueComment(octokit, {
    author: botLogin,
    body: questionBody(headSha, entries, {
      botLogin,
      minimumReleaseAge: manifest.minimumReleaseAge,
    }),
    issueNumber: pullNumber,
    marker: releaseAgeExemptionHeadMarker(headSha),
    owner,
    repo,
  });

  return {
    comment,
    entries: selectors,
    headSha,
    status: "asked",
    // A run that found the question posted left the earlier ones to the run
    // that posted it.
    ...(comment.created && {
      outdatedQuestions: await minimizeEarlierQuestions(
        options,
        headSha,
        comment.id
      ),
    }),
  };
};

export interface ApproveReleaseAgeExemptionOptions extends PullRequestOptions {
  /** The new comment on the pull request. */
  comment: { id: number; body: string; author: string; url: string };
}

/**
 * Takes a new comment on a Renovate pull request as a maintainer's approval
 * of the bot's question, and commits the entries it asked for. It counts
 * only when it mentions the bot and says to add them, its author can write
 * to the repository, and the question for the pull request's current head
 * was posted before it and still asks for entries the workspace does not
 * list and whose versions are still inside the window. The bot records the
 * approval in its question, so that a new head with the same versions gets
 * the entries again without asking. No model is asked.
 */
export const approveReleaseAgeExemption = async (
  options: ApproveReleaseAgeExemptionOptions
): Promise<ApproveReleaseAgeExemptionResult> => {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    botLogin,
    comment,
    dryRun = false,
    now = new Date(),
  } = options;

  if (comment.author === botLogin) {
    return { reason: "the comment is the bot's own", status: "skipped" };
  }

  if (!requestsReleaseAgeExemption(comment.body, botLogin)) {
    return {
      reason: `the comment does not mention ${mentionOf(botLogin)} and say to add`,
      status: "skipped",
    };
  }

  const permission = await getRepositoryPermission(octokit, {
    owner,
    repo,
    username: comment.author,
  });

  if (permission === undefined || !isMaintainerPermission(permission)) {
    return {
      reason:
        permission === undefined
          ? "the author's permission on the repository cannot be read"
          : "the author cannot write to the repository",
      status: "skipped",
    };
  }

  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    pull_number: pullNumber,
    repo,
  });

  const headSha = pullRequest.head.sha;

  const skip = (reason: string) =>
    ({ headSha, reason, status: "skipped" }) as const;

  if (!isRenovate(pullRequest.user)) {
    return skip("Renovate did not open the pull request");
  }

  if (pullRequest.state !== "open") {
    return skip("the pull request is closed");
  }

  if (pullRequest.head.repo?.full_name !== pullRequest.base.repo.full_name) {
    return skip("its branch is in another repository");
  }

  const question = questionsOf(await listComments(options), botLogin).findLast(
    (asked) => asked.headSha === headSha && asked.comment.id < comment.id
  );

  if (question === undefined) {
    return skip("no question of the bot for the head precedes the comment");
  }

  const workspace = await readManifest(options, headSha);

  if (workspace === undefined) {
    return skip(`the head has no ${MANIFEST_PATH}`);
  }

  const entries = pendingReleaseAgeExemptionEntries(question.entries, {
    excluded: workspace.manifest.minimumReleaseAgeExclude,
    now,
  });

  if (entries.length === 0) {
    return skip("the entries the question asks for are no longer needed");
  }

  if (!dryRun && question.approvedIn === undefined) {
    await octokit.rest.issues.updateComment({
      body: [
        question.comment.body,
        "",
        formatReleaseAgeExemptionApprovalMarker(comment.url),
        `Approved in ${comment.url}.`,
      ].join("\n"),
      comment_id: question.comment.id,
      owner,
      repo,
    });
  }

  return commitExemption(options, {
    approvedIn: comment.url,
    branch: pullRequest.head.ref,
    entries,
    headSha,
    source: workspace.source,
  });
};

export type MinimizeOutdatedReleaseAgeQuestionsOptions = PullRequestOptions;

/**
 * Minimizes the bot's questions that no longer ask for anything as
 * outdated: those for a head the pull request no longer has, and those
 * whose versions have all left the window, since the pull request installs
 * without the entries once Renovate rebases it. Returns how many.
 */
export const minimizeOutdatedReleaseAgeQuestions = async ({
  octokit,
  owner,
  repo,
  pullNumber,
  botLogin,
  now = new Date(),
}: MinimizeOutdatedReleaseAgeQuestionsOptions): Promise<number> => {
  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    pull_number: pullNumber,
    repo,
  });

  return minimizeOutdatedIssueComments(octokit, {
    author: botLogin,
    isOutdated: (body) => {
      const question = parseReleaseAgeExemptionQuestion(body);

      return (
        question === undefined ||
        question.headSha !== pullRequest.head.sha ||
        pendingReleaseAgeExemptionEntries(question.entries, {
          excluded: [],
          now,
        }).length === 0
      );
    },
    issueNumber: pullNumber,
    marker: RELEASE_AGE_EXEMPTION_MARKER_START,
    owner,
    repo,
  });
};

const outdatedQuestionsFields = (
  outdated: OutdatedQuestions | undefined
): LogFields => {
  if (outdated !== undefined && "error" in outdated) {
    return {
      minimizeError: outdated.error,
      minimizeErrorStatus: outdated.status,
    };
  }

  return outdated !== undefined && "skipped" in outdated
    ? { minimizeSkipped: outdated.skipped }
    : { minimizedComments: outdated?.minimized };
};

/** The fields of a result to log. */
export const summarizeReleaseAgeExemptionResult = (
  result: AskReleaseAgeExemptionResult | ApproveReleaseAgeExemptionResult
): LogFields => ({
  ...outdatedQuestionsFields(
    "outdatedQuestions" in result ? result.outdatedQuestions : undefined
  ),
  approvedIn: "approvedIn" in result ? result.approvedIn : undefined,
  comment: result.status === "asked" ? result.comment.id : undefined,
  commentCreated:
    result.status === "asked" ? result.comment.created : undefined,
  commit: result.status === "committed" ? result.commitSha : undefined,
  entries: "entries" in result ? result.entries : undefined,
  headSha: result.headSha,
  modelInvoked: false,
  reason: "reason" in result ? result.reason : undefined,
  status: result.status,
  subject: result.status === "would-commit" ? result.subject : undefined,
});
