import {
  addCommitToBranch,
  getCommitChecks,
  readOptionalRepositoryFile,
} from "@publira/github";
import type { Octokit } from "@publira/github";
import {
  evaluateCommitChecks,
  isLintFixRefusedPath,
  isRenovate,
  LINT_FIX_COMMIT_SUBJECT,
  readLintSetup,
} from "@publira/maintenance-policies";
import type { LintPackageManager } from "@publira/maintenance-policies";

import type { GitFileChange } from "../git-output.ts";
import type { LogFields } from "../log.ts";
import {
  git,
  readBlobs,
  readTokenOptions,
  runChecked,
  stageChanges,
  tail,
} from "../sandbox-git.ts";
import type { Sandbox, SandboxRunner } from "../sandbox-runner.ts";

// Where the sandbox checks the pull request out.
const WORKTREE = "/tmp/repository";

const FETCH_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
const LINT_TIMEOUT_MS = 60_000;

// How each package manager installs the locked dependencies and runs a
// binary of them.
const PACKAGE_MANAGER_ARGS: Record<
  LintPackageManager,
  { install: string[]; exec: string[] }
> = {
  npm: { exec: ["exec", "--no", "--"], install: ["ci"] },
  pnpm: { exec: ["exec"], install: ["install", "--frozen-lockfile"] },
};

// The exit codes of `ultracite fix` that tell it ran: 1 means findings
// remain that it does not fix, whether it fixed others or not.
const FIX_RAN_EXIT_CODES = new Set([0, 1]);

export interface ApplyLintFixesOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /** The App's bot login, which authors the commit. */
  botLogin: string;
  sandbox: SandboxRunner;
  /**
   * Creates a token that can only read the repository, which the sandbox
   * fetches a private repository with. A public one is fetched anonymously.
   */
  createReadToken: () => Promise<string>;
  /** Fixes the files without committing them. */
  dryRun?: boolean;
}

interface FixedPaths {
  /** The files the fix changed, which the commit takes. */
  paths: string[];
  /** Whether `ultracite check` passes after the fix. */
  checkPassed: boolean;
  /** The end of the check's output after the fix, when it still fails. */
  output: string | undefined;
}

export type ApplyLintFixesResult =
  | { status: "skipped"; headSha: string; reason: string }
  | {
      /** The sandbox could not fetch the head, install, or run the fix. */
      status: "failed";
      headSha: string;
      step: "fetch" | "fix" | "install";
      exitCode: number;
      /** The end of the command's output. */
      output: string;
    }
  | {
      /** `ultracite check` passes: another check failed. */
      status: "lint-passed";
      headSha: string;
    }
  | {
      /** The automatic fix does not make the check pass; a person has to. */
      status: "unfixed";
      headSha: string;
      reason: string;
      output: string | undefined;
    }
  | {
      /**
       * Something other than the fix changed the files, or the fix changed a
       * file it has no reason to; nothing is committed.
       */
      status: "refused";
      headSha: string;
      reason: string;
      paths: string[];
      refusedPaths: string[];
    }
  | ({ status: "would-commit"; headSha: string } & FixedPaths)
  | ({ status: "committed"; headSha: string; commitSha: string } & FixedPaths)
  | ({
      /** The branch moved while the job ran; its push is evaluated anew. */
      status: "head-moved";
      headSha: string;
    } & FixedPaths);

interface SandboxRequest {
  owner: string;
  repo: string;
  headSha: string;
  readToken: string | undefined;
  packageManager: LintPackageManager;
}

type SandboxResult =
  | Omit<Extract<ApplyLintFixesResult, { status: "failed" }>, "headSha">
  | { status: "lint-passed" }
  | {
      /** The install or the check changed files Git tracks. */
      status: "changed-before-fix";
      paths: string[];
    }
  | {
      status: "fixed";
      changes: GitFileChange[];
      /** The blobs of the files the fix wrote, unless it changed a refused one. */
      blobs: Map<string, Buffer>;
      checkPassed: boolean;
      output: string;
    };

const failure = (
  step: "fetch" | "fix" | "install",
  {
    exitCode,
    stdout,
    stderr,
  }: { exitCode: number; stdout: string; stderr: string }
) => ({
  exitCode,
  output: tail(`${stdout}${stderr}`),
  status: "failed" as const,
  step,
});

/**
 * Checks out the head, installs its dependencies, runs `ultracite check`,
 * and, when it fails and left the files Git tracks as they are,
 * `ultracite fix` and the check again, then reads back what the fix changed
 * in those files. The sandbox gets no
 * credential but the read token, and that only for the fetch, which does not
 * store it where the install or the lint tools could read it.
 */
const fixInSandbox = async (
  sandbox: Sandbox,
  { owner, repo, headSha, readToken, packageManager }: SandboxRequest
): Promise<SandboxResult> => {
  await runChecked(sandbox, {
    args: ["init", "--quiet", WORKTREE],
    cmd: "git",
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  const fetch = await sandbox.run({
    args: [
      ...readTokenOptions(readToken),
      "-C",
      WORKTREE,
      "fetch",
      "--quiet",
      "--depth=1",
      `https://github.com/${owner}/${repo}.git`,
      headSha,
    ],
    cmd: "git",
    // Fail rather than wait for a password.
    env: { GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (fetch.exitCode !== 0) {
    return failure("fetch", fetch);
  }
  await git(sandbox, WORKTREE, "checkout", "--quiet", "--detach", "FETCH_HEAD");

  const { install, exec } = PACKAGE_MANAGER_ARGS[packageManager];
  const run = (args: readonly string[], timeoutMs: number) =>
    sandbox.run({
      args,
      cmd: packageManager,
      cwd: WORKTREE,
      env: { CI: "true", NO_COLOR: "1" },
      timeoutMs,
    });

  const installation = await run(install, INSTALL_TIMEOUT_MS);
  if (installation.exitCode !== 0) {
    return failure("install", installation);
  }

  const before = await run([...exec, "ultracite", "check"], LINT_TIMEOUT_MS);
  if (before.exitCode === 0) {
    return { status: "lint-passed" };
  }

  // The commit takes whole files, so a change the install made, such as by
  // a lifecycle script, cannot be told apart from the fix's in a file both
  // change. The worktree has to be the head's when the fix starts.
  const changedBefore = await stageChanges(sandbox, WORKTREE, {
    trackedOnly: true,
  });
  if (changedBefore.length > 0) {
    return {
      paths: changedBefore.map(({ path }) => path),
      status: "changed-before-fix",
    };
  }

  const fix = await run([...exec, "ultracite", "fix"], LINT_TIMEOUT_MS);
  if (!FIX_RAN_EXIT_CODES.has(fix.exitCode)) {
    return failure("fix", fix);
  }

  const after = await run([...exec, "ultracite", "check"], LINT_TIMEOUT_MS);
  // A fix rewrites the files it fixes, so a file Git does not track, such
  // as a cache the install or a tool wrote, is none of its doing.
  const changes = await stageChanges(sandbox, WORKTREE, { trackedOnly: true });
  const blobs = changes.some(({ path }) => isLintFixRefusedPath(path))
    ? new Map<string, Buffer>()
    : await readBlobs(
        sandbox,
        WORKTREE,
        changes.flatMap(({ after: file }) =>
          file === undefined ? [] : [file.sha]
        )
      );

  return {
    blobs,
    changes,
    checkPassed: after.exitCode === 0,
    output: tail(`${after.stdout}${after.stderr}`),
    status: "fixed",
  };
};

interface Skip {
  reason: string;
}

const isSkip = (value: LintPackageManager | Skip): value is Skip =>
  typeof value === "object";

/**
 * Decides whether the head calls for the automatic fix: the repository lints
 * with ultracite through pnpm or npm, and a check on the head failed.
 */
const plan = async (
  { octokit, owner, repo }: ApplyLintFixesOptions,
  headSha: string
): Promise<LintPackageManager | Skip> => {
  const manifest = await readOptionalRepositoryFile(octokit, {
    owner,
    path: "package.json",
    ref: headSha,
    repo,
  });
  if (manifest === undefined) {
    return { reason: "the head has no package.json at its root" };
  }
  const setup = readLintSetup(manifest);
  if (setup.result === "skipped") {
    return { reason: setup.reason };
  }

  const checks = evaluateCommitChecks({
    ...(await getCommitChecks(octokit, { owner, ref: headSha, repo })),
    required: [],
  });
  if (checks.result === "pending") {
    return { reason: "the checks on the head are still running" };
  }
  if (checks.result !== "failed") {
    return { reason: "no check on the head failed" };
  }

  return setup.packageManager;
};

/** Whether the head is the bot's commit of the automatic fix. */
const isBotLintFix = async (
  { octokit, owner, repo, botLogin }: ApplyLintFixesOptions,
  headSha: string
) => {
  const { data: head } = await octokit.rest.repos.getCommit({
    owner,
    // Only the commit is needed, not its files.
    per_page: 1,
    ref: headSha,
    repo,
  });
  return (
    head.author?.login === botLogin &&
    head.commit.message.split("\n", 1)[0] === LINT_FIX_COMMIT_SUBJECT
  );
};

const contentOf =
  (blobs: ReadonlyMap<string, Buffer>) =>
  ({ after, path }: GitFileChange) => {
    if (after === undefined) {
      return null;
    }
    const content = blobs.get(after.sha);
    if (content === undefined) {
      throw new Error(`The sandbox did not return ${path}`);
    }
    return content;
  };

/**
 * Runs `ultracite fix` on a Renovate pull request whose checks failed, in a
 * repository that lints with ultracite, and commits what it fixed to the
 * pull request's branch. An update of a linter or a formatter can change
 * what the repository's check accepts, and the fix is mechanical, but a
 * maintainer who commits it by hand stops Renovate from updating the branch.
 *
 * The repository declares nothing: its root `package.json` tells that it
 * depends on ultracite and which package manager, pnpm or npm, installs and
 * runs it. Which check failed does not matter, since their names differ
 * between repositories; `ultracite check` in the sandbox tells whether lint
 * is the cause. The commands run the pull request's own code and the updated
 * tools, in a sandbox with no write credential. No model is asked.
 *
 * It commits on top of the head and only as a fast-forward, and refuses a
 * fix that changes a lock file, a `package.json`, or a file under
 * `.github/`. It leaves a head that is its own fix commit alone, so it never
 * runs the fix twice on one head; that head, like one the fix leaves as it
 * is, needs more than the automatic fix. Renovate may discard the commit when
 * it rewrites its branch; the evaluation of that push brings it back.
 */
export const applyLintFixes = async (
  options: ApplyLintFixesOptions
): Promise<ApplyLintFixesResult> => {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    sandbox,
    createReadToken,
    dryRun = false,
  } = options;
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

  const packageManager = await plan(options, headSha);
  if (isSkip(packageManager)) {
    return skip(packageManager.reason);
  }
  if (await isBotLintFix(options, headSha)) {
    return {
      headSha,
      output: undefined,
      reason: "a check failed on the bot's own fix",
      status: "unfixed",
    };
  }

  const readToken = pullRequest.base.repo.private
    ? await createReadToken()
    : undefined;
  const fixed = await sandbox((session) =>
    fixInSandbox(session, { headSha, owner, packageManager, readToken, repo })
  );

  if (fixed.status === "changed-before-fix") {
    return {
      headSha,
      paths: fixed.paths,
      reason:
        "the install or the check changed files Git tracks before the fix ran",
      refusedPaths: fixed.paths,
      status: "refused",
    };
  }
  if (fixed.status !== "fixed") {
    return { ...fixed, headSha };
  }

  const { blobs, changes, checkPassed } = fixed;
  const output = checkPassed ? undefined : fixed.output;
  const paths = changes.map(({ path }) => path);

  if (changes.length === 0) {
    return checkPassed
      ? { headSha, status: "lint-passed" }
      : {
          headSha,
          output,
          reason: "the automatic fix changed nothing",
          status: "unfixed",
        };
  }

  const refusedPaths = paths.filter(isLintFixRefusedPath);
  if (refusedPaths.length > 0) {
    return {
      headSha,
      paths,
      reason: "the fix changed files it has no reason to change",
      refusedPaths,
      status: "refused",
    };
  }

  if (dryRun) {
    return { checkPassed, headSha, output, paths, status: "would-commit" };
  }

  const commit = await addCommitToBranch(octokit, {
    branch: pullRequest.head.ref,
    files: Object.fromEntries(
      changes.map((change) => [change.path, contentOf(blobs)(change)])
    ),
    headSha,
    message: `${LINT_FIX_COMMIT_SUBJECT}\n\nRan \`ultracite fix\` with ${packageManager} on ${headSha}.`,
    modes: Object.fromEntries(
      changes.flatMap(({ after, path }) =>
        after === undefined ? [] : [[path, after.mode]]
      )
    ),
    owner,
    repo,
  });

  return commit.status === "moved"
    ? { checkPassed, headSha, output, paths, status: "head-moved" }
    : {
        checkPassed,
        commitSha: commit.sha,
        headSha,
        output,
        paths,
        status: "committed",
      };
};

/** The fields of a result to log, without file contents. */
export const summarizeLintFixResult = (
  result: ApplyLintFixesResult
): LogFields => ({
  checkPassed: "checkPassed" in result ? result.checkPassed : undefined,
  commit: result.status === "committed" ? result.commitSha : undefined,
  exitCode: result.status === "failed" ? result.exitCode : undefined,
  headSha: result.headSha,
  modelInvoked: false,
  output: "output" in result ? result.output : undefined,
  paths: "paths" in result ? result.paths : undefined,
  reason: "reason" in result ? result.reason : undefined,
  refusedPaths: result.status === "refused" ? result.refusedPaths : undefined,
  status: result.status,
  step: result.status === "failed" ? result.step : undefined,
});
