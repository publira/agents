import {
  addCommitToBranch,
  ensureIssueComment,
  findIssueComment,
  getCommitChecks,
  readOptionalRepositoryFile,
} from "@publira/github";
import type { EnsureIssueCommentResult, Octokit } from "@publira/github";
import {
  evaluateCommitChecks,
  evaluateLintFindingsFix,
  isLintFixRefusedPath,
  isRenovate,
  LINT_FINDINGS_FIX_COMMIT_SUBJECT,
  LINT_FIX_COMMIT_SUBJECT,
  readKilledLintTool,
  readLintSetup,
} from "@publira/maintenance-policies";
import type {
  LintFindingsFixVerdict,
  LintPackageManager,
} from "@publira/maintenance-policies";

import { AGENT_NAME } from "../agent-name.ts";
import { codeBlock } from "../code-block.ts";
import { parseAddedLines } from "../git-output.ts";
import type { GitFileChange } from "../git-output.ts";
import { LintFindingsRunError } from "../lint-findings-fixer.ts";
import type {
  LintFindingsFixer,
  LintFindingsModelRun,
} from "../lint-findings-fixer.ts";
import { loggableFailure } from "../log.ts";
import type { LogFields } from "../log.ts";
import {
  excerpt,
  git,
  readBlobs,
  readTokenOptions,
  runChecked,
  stageChanges,
  tail,
} from "../sandbox-git.ts";
import type {
  Sandbox,
  SandboxCommandResult,
  SandboxRunner,
} from "../sandbox-runner.ts";

// Where the sandbox checks the pull request out.
const WORKTREE = "/tmp/repository";

/**
 * The vCPUs of the sandbox, which bring 2 GB of memory each. oxlint, when
 * the configuration loads JS plugins, maps 6 GiB for each lint thread in one
 * request, and a machine with heuristic overcommit and no swap, as a Vercel
 * Sandbox is, refuses a request larger than its memory: with two vCPUs oxlint
 * aborts before it lints a file. Four is the fewest that leave it room.
 */
const SANDBOX_VCPUS = 4;

const FETCH_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
// One run of ultracite on publira/publira takes 51 to 64 seconds with four
// vCPUs.
const LINT_TIMEOUT_MS = 120_000;

// How long `ultracite fix` may take on the files the model changed only.
const MODEL_FILES_FIX_TIMEOUT_MS = 30_000;

// How much of the sandbox's life the model leaves the job, to fix and check
// its changes and read them back: the fix of the files it changed, the
// check, and the Git commands around them.
const CHECK_RESERVE_MS = MODEL_FILES_FIX_TIMEOUT_MS + LINT_TIMEOUT_MS + 15_000;

/**
 * How long the sandbox may live, within the 800 seconds the project allows
 * the Vercel Function that the webhook handler and the hourly sweep run in.
 * On publira/publira the fetch, the install, and the three runs of
 * ultracite before the model take up to 200 seconds; with the 90 the model
 * may work and the reserve after it, the model gets its whole time with
 * some to spare, and a repository whose lint takes longer still has a
 * sandbox that stops well within the function.
 */
const SANDBOX_TIMEOUT_MS = 480_000;

// How much of the check's output and of the automatic fix's diff the model
// reads, from their ends.
const MODEL_INPUT_LIMIT = 20_000;

// How each package manager installs the locked dependencies and runs a
// binary of them.
const PACKAGE_MANAGER_ARGS: Record<
  LintPackageManager,
  { install: string[]; exec: string[] }
> = {
  npm: { exec: ["exec", "--no", "--"], install: ["ci"] },
  pnpm: { exec: ["exec"], install: ["install", "--frozen-lockfile"] },
};

// The command that runs `ultracite check`, as the model and the comment name
// it.
const checkCommand = (packageManager: LintPackageManager) =>
  [
    packageManager,
    ...PACKAGE_MANAGER_ARGS[packageManager].exec,
    "ultracite",
    "check",
  ].join(" ");

// The exit codes of `ultracite fix` that tell it ran: 1 means findings
// remain that it does not fix, whether it fixed others or not. It is also
// the exit code when a tool ultracite ran was killed, which only the output
// tells.
const FIX_RAN_EXIT_CODES = new Set([0, 1]);

/** The commands the sandbox runs, which a failure names. */
type LintStep = "check" | "fetch" | "fix" | "install";

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
  /**
   * Fixes the findings the automatic fix leaves, in the same sandbox.
   * Without it, they are left to a maintainer.
   */
  fixer?: LintFindingsFixer;
  /** Fixes the files without committing them or commenting. */
  dryRun?: boolean;
}

/**
 * What became of the findings the automatic fix left, which a model was
 * asked to fix.
 */
export interface FindingsFix {
  /**
   * Whether the model was asked; it is not when the sandbox had no time
   * left for it.
   */
  invoked: boolean;
  /** The model that made the changes; none when its run failed. */
  model?: string;
  /**
   * Whether the model was stopped, by time or by its number of steps,
   * before it finished; none when its run failed.
   */
  stopped?: boolean;
  /**
   * Whether `ultracite check` passes after the model's changes; none when
   * its run failed, and the check did not run, or a tool was killed during
   * the check.
   */
  checkPassed?: boolean;
  /**
   * The files the model's changes, with the automatic fix's, change against
   * the head; none when its run failed.
   */
  paths: string[];
  /** Why the model's run failed. */
  error?: string;
  /** What the model did, whether its run finished or failed. */
  run?: LintFindingsModelRun;
  /**
   * Why the changes are not committed, when they are refused, or why the
   * model was not asked.
   */
  reason?: string;
  /** The files among `paths` that kept them from being committed. */
  refusedPaths?: string[];
  /** The added lines that turn a finding off, as `path:line`. */
  suppressions?: string[];
  /** The comment that tells the maintainers of a refusal. */
  comment?: EnsureIssueCommentResult;
}

interface FixedPaths {
  /** The files the commit takes. */
  paths: string[];
  /** Whether `ultracite check` passes on what the commit takes. */
  checkPassed: boolean;
  /** The end of the check's output after the fix, when it still fails. */
  output: string | undefined;
  /** What a model did with the findings the automatic fix left. */
  findings?: FindingsFix;
}

export type ApplyLintFixesResult =
  | { status: "skipped"; headSha: string; reason: string }
  | {
      /**
       * The sandbox could not fetch the head or install, or a tool was
       * killed during the check or the fix, so what it would have found is
       * unknown.
       */
      status: "failed";
      headSha: string;
      step: LintStep;
      exitCode: number;
      /** The start and the end of the command's output. */
      output: string;
      /** Which tool was killed, and by which signal, when one was. */
      reason?: string;
      /**
       * What the model did, when a tool was killed during the check after
       * its changes: the model, whether it was stopped, and its paths.
       */
      findings?: FindingsFix;
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
      findings?: FindingsFix;
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
  /** Fixes the findings the automatic fix leaves; none to leave them. */
  fixer: LintFindingsFixer | undefined;
}

/**
 * What the model changed, and what the check and the policy made of it, why
 * its run failed, or why it was not asked.
 */
type SandboxFindingsFix =
  | {
      status: "checked";
      model: string;
      stopped: boolean;
      run: LintFindingsModelRun;
      changes: GitFileChange[];
      /** The blobs of the files it changed, when the policy accepts them. */
      blobs: Map<string, Buffer>;
      checkPassed: boolean;
      verdict: LintFindingsFixVerdict;
    }
  | { status: "model-failed"; error: string; run?: LintFindingsModelRun }
  | { status: "not-asked"; reason: string };

/** A command the sandbox could not run to the end; see the result. */
type Failure = Omit<
  Extract<ApplyLintFixesResult, { status: "failed" }>,
  "headSha"
>;

type SandboxResult =
  | Failure
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
      /** What the model did, when the fix left findings it was given. */
      findings?: SandboxFindingsFix;
    };

const outputOf = ({ stdout, stderr }: SandboxCommandResult) =>
  `${stdout}${stderr}`;

// The output a failed command leaves keeps its start, where a tool's own
// message is, such as a panic, before the trace of the command that ran it.
const failure = (step: LintStep, result: SandboxCommandResult): Failure => ({
  exitCode: result.exitCode,
  output: excerpt(outputOf(result)),
  status: "failed",
  step,
});

/**
 * The failure of a check or a fix during which ultracite's output says a
 * tool was killed by a signal: ultracite exits with 1 then, as on findings,
 * and what the tool would have found is unknown.
 */
const killedToolFailure = (
  step: "check" | "fix",
  result: SandboxCommandResult
): Failure | undefined => {
  const killed = readKilledLintTool(outputOf(result));
  return killed === undefined
    ? undefined
    : {
        ...failure(step, result),
        reason: `${killed.tool} was killed by signal ${killed.signal}`,
      };
};

// The files Git neither tracks nor ignores.
const listUntracked = async (sandbox: Sandbox) => {
  const output = await git(
    sandbox,
    WORKTREE,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  );
  return new Set(output.split("\0").filter((path) => path !== ""));
};

// The files Git tracks that differ from the index, except deleted ones.
const listChangedFromIndex = async (sandbox: Sandbox) => {
  const output = await git(
    sandbox,
    WORKTREE,
    "diff",
    "--name-only",
    "--diff-filter=d",
    "-z"
  );
  return output.split("\0").filter((path) => path !== "");
};

interface FindingsRequest {
  fixer: LintFindingsFixer;
  /** The check's command, as the model is told it. */
  command: string;
  check: () => Promise<SandboxCommandResult>;
  /** Runs `ultracite fix` on the given files only. */
  fixFiles: (paths: readonly string[]) => Promise<SandboxCommandResult>;
  /** The check's output after the automatic fix. */
  output: string;
}

/**
 * Has the model fix the findings the automatic fix left, on the files as
 * that fix left them and staged them, then checks and reads back the
 * result. The model works in this sandbox through its tools; the job, not
 * the model, runs the check afterwards and reads the diff. A tool killed
 * during that check fails the job: the changes cannot be checked. When the
 * steps before took so long that the model's time is already up, it is not
 * asked.
 */
const fixFindingsInSandbox = async (
  sandbox: Sandbox,
  { fixer, command, check, fixFiles, output }: FindingsRequest
): Promise<SandboxFindingsFix | Failure> => {
  const deadline = sandbox.stopsAt - CHECK_RESERVE_MS;
  if (deadline <= Date.now()) {
    return {
      reason: "the sandbox had no time left for the model",
      status: "not-asked",
    };
  }

  // Fixing and checking need no network, and the model's calls run in the
  // app runtime, not in the sandbox.
  await sandbox.denyNetwork();
  const untracked = await listUntracked(sandbox);
  const diff = await git(
    sandbox,
    WORKTREE,
    "diff",
    "--cached",
    "--no-color",
    "HEAD"
  );

  let fix: Awaited<ReturnType<LintFindingsFixer>>;
  try {
    fix = await fixer({
      command,
      deadline,
      diff: tail(diff, MODEL_INPUT_LIMIT),
      output: tail(output, MODEL_INPUT_LIMIT),
      sandbox,
      worktree: WORKTREE,
    });
  } catch (error) {
    // The automatic fix still stands, and the head counts as tried.
    return {
      error: loggableFailure.safeParse(error).data?.error ?? "unknown error",
      ...(error instanceof LintFindingsRunError && { run: error.run }),
      status: "model-failed",
    };
  }
  const { model, stopped, run } = fix;

  // A file Git does not track is not committed, so the check must not see
  // one that the model wrote.
  const written = [...(await listUntracked(sandbox))].filter(
    (path) => !untracked.has(path)
  );
  if (written.length > 0) {
    await git(
      sandbox,
      WORKTREE,
      "--literal-pathspecs",
      "clean",
      "-d",
      "--force",
      "--quiet",
      "--",
      ...written
    );
  }

  // The formatter, not the model, formats what the model changed: the
  // automatic fix runs again on the files it changed against the index,
  // which holds the automatic fix's own changes.
  const edited = await listChangedFromIndex(sandbox);
  const fixedEdits = edited.length > 0 ? await fixFiles(edited) : undefined;
  const after = await check();
  const changes = await stageChanges(sandbox, WORKTREE, { trackedOnly: true });
  const killed =
    (fixedEdits && killedToolFailure("fix", fixedEdits)) ??
    killedToolFailure("check", after);
  if (killed !== undefined) {
    // The model ran, and the log says so, with what it changed.
    return {
      ...killed,
      findings: {
        invoked: true,
        model,
        paths: changes.map(({ path }) => path),
        run,
        stopped,
      },
    };
  }
  const checkPassed = after.exitCode === 0;
  const verdict = evaluateLintFindingsFix({
    addedLines: parseAddedLines(
      await git(
        sandbox,
        WORKTREE,
        "-c",
        "core.quotePath=false",
        "diff",
        "--cached",
        "--no-color",
        "--no-renames",
        "--unified=0",
        "HEAD"
      )
    ),
    checkPassed,
    paths: changes.map(({ path }) => path),
  });

  return {
    blobs:
      verdict.result === "accepted"
        ? await readBlobs(
            sandbox,
            WORKTREE,
            changes.flatMap(({ after: file }) =>
              file === undefined ? [] : [file.sha]
            )
          )
        : new Map(),
    changes,
    checkPassed,
    model,
    run,
    status: "checked",
    stopped,
    verdict,
  };
};

/**
 * Checks out the head, installs its dependencies, runs `ultracite check`,
 * and, when it fails and left the files Git tracks as they are,
 * `ultracite fix` and the check again, then reads back what the fix changed
 * in those files. When the check still fails, the fixer gets the findings,
 * in the same sandbox, cut off from the network. A check or a fix during
 * which a tool was killed fails the job instead, whatever its exit code:
 * what the tool would have found is unknown. The sandbox gets no
 * credential but the read token, and that only for the fetch, which does not
 * store it where the install or the lint tools could read it.
 */
const fixInSandbox = async (
  sandbox: Sandbox,
  { owner, repo, headSha, readToken, packageManager, fixer }: SandboxRequest
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
  const checkArgs = [...exec, "ultracite", "check"];
  const check = () => run(checkArgs, LINT_TIMEOUT_MS);

  const installation = await run(install, INSTALL_TIMEOUT_MS);
  if (installation.exitCode !== 0) {
    return failure("install", installation);
  }

  const before = await check();
  const killedBefore = killedToolFailure("check", before);
  if (killedBefore !== undefined) {
    return killedBefore;
  }
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
  const killedFix = killedToolFailure("fix", fix);
  if (killedFix !== undefined) {
    return killedFix;
  }
  if (!FIX_RAN_EXIT_CODES.has(fix.exitCode)) {
    return failure("fix", fix);
  }

  const after = await check();
  const killedAfter = killedToolFailure("check", after);
  if (killedAfter !== undefined) {
    return killedAfter;
  }
  // A fix rewrites the files it fixes, so a file Git does not track, such
  // as a cache the install or a tool wrote, is none of its doing.
  const changes = await stageChanges(sandbox, WORKTREE, { trackedOnly: true });
  const refused = changes.some(({ path }) => isLintFixRefusedPath(path));
  const blobs = refused
    ? new Map<string, Buffer>()
    : await readBlobs(
        sandbox,
        WORKTREE,
        changes.flatMap(({ after: file }) =>
          file === undefined ? [] : [file.sha]
        )
      );
  const fixed = {
    blobs,
    changes,
    checkPassed: after.exitCode === 0,
    output: tail(outputOf(after)),
    status: "fixed" as const,
  };

  if (fixed.checkPassed || refused || fixer === undefined) {
    return fixed;
  }
  const findings = await fixFindingsInSandbox(sandbox, {
    check,
    command: checkCommand(packageManager),
    fixFiles: (paths) =>
      run([...exec, "ultracite", "fix", ...paths], MODEL_FILES_FIX_TIMEOUT_MS),
    fixer,
    output: outputOf(after),
  });
  return findings.status === "failed" ? findings : { ...fixed, findings };
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

// The subjects of the bot's commits of lint fixes, automatic or a model's.
const LINT_FIX_SUBJECTS = new Set([
  LINT_FIX_COMMIT_SUBJECT,
  LINT_FINDINGS_FIX_COMMIT_SUBJECT,
]);

/** Whether the head is the bot's commit of lint fixes. */
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
    LINT_FIX_SUBJECTS.has(head.commit.message.split("\n", 1)[0] ?? "")
  );
};

// The hidden mark of the comment that tells the maintainers the model could
// not fix the findings on a head, which also records that it tried.
const findingsMarker = (headSha: string) =>
  `<!-- chachamaru-lint-findings head=${headSha} -->`;

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

const commitOf = (
  changes: readonly GitFileChange[],
  blobs: Map<string, Buffer>
) => ({
  files: Object.fromEntries(
    changes.map((change) => [change.path, contentOf(blobs)(change)])
  ),
  modes: Object.fromEntries(
    changes.flatMap(({ after, path }) =>
      after === undefined ? [] : [[path, after.mode]]
    )
  ),
});

/** What a model's fix comes to, without the files. */
const summarizeFindings = (fix: SandboxFindingsFix): FindingsFix => {
  if (fix.status === "not-asked") {
    return { invoked: false, paths: [], reason: fix.reason };
  }
  if (fix.status === "model-failed") {
    return {
      error: fix.error,
      invoked: true,
      paths: [],
      reason: "the model's run failed",
      ...(fix.run !== undefined && { run: fix.run }),
    };
  }
  const { model, stopped, run, changes, checkPassed, verdict } = fix;
  return {
    checkPassed,
    invoked: true,
    model,
    paths: changes.map(({ path }) => path),
    run,
    stopped,
    ...(verdict.result === "refused" && {
      reason: verdict.reason,
      refusedPaths: verdict.refusedPaths,
      suppressions: verdict.suppressions.map(
        ({ path, lineNumber }) => `${path}:${lineNumber}`
      ),
    }),
  };
};

const findingsComment = (
  headSha: string,
  { invoked, reason, refusedPaths = [], suppressions = [] }: FindingsFix,
  { command, output }: { command: string; output: string }
) =>
  [
    findingsMarker(headSha),
    invoked
      ? `The automatic lint fixes leave findings on ${headSha} that a model could not fix for Chachamaru: ${reason ?? "its changes were refused"}. A maintainer needs to fix them; Chachamaru does not try this commit again.`
      : `The automatic lint fixes leave findings on ${headSha}, and Chachamaru had no time left to ask a model to fix them. A maintainer needs to fix them; Chachamaru does not try this commit again.`,
    ...(refusedPaths.length === 0
      ? []
      : [
          "",
          "The files it may not change:",
          "",
          ...refusedPaths.map((path) => `- ${path}`),
        ]),
    ...(suppressions.length === 0
      ? []
      : [
          "",
          "The lines that turn findings off:",
          "",
          ...suppressions.map((line) => `- ${line}`),
        ]),
    "",
    `The end of \`${command}\` after the automatic fixes:`,
    "",
    codeBlock(output),
  ].join("\n");

/** Where and how the job writes what came out of the sandbox. */
interface Settlement {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  botLogin: string;
  branch: string;
  headSha: string;
  packageManager: LintPackageManager;
  dryRun: boolean;
}

/** Commits the model's changes, with the automatic fix's, to the branch. */
const commitFindingsFix = async (
  { octokit, owner, repo, branch, headSha, packageManager, dryRun }: Settlement,
  fix: Extract<SandboxFindingsFix, { status: "checked" }>
): Promise<ApplyLintFixesResult> => {
  const findings = summarizeFindings(fix);
  const fixedByModel = {
    checkPassed: true,
    findings,
    headSha,
    output: undefined,
    paths: findings.paths,
  };
  if (dryRun) {
    return { ...fixedByModel, status: "would-commit" };
  }
  const commit = await addCommitToBranch(octokit, {
    ...commitOf(fix.changes, fix.blobs),
    branch,
    headSha,
    message: [
      LINT_FINDINGS_FIX_COMMIT_SUBJECT,
      "",
      `Ran \`ultracite fix\` with ${packageManager} on ${headSha}, and a model fixed the findings it left; \`ultracite check\` passed on the result in the sandbox.`,
      "",
      `Assisted-by: ${AGENT_NAME}:${fix.model}`,
    ].join("\n"),
    owner,
    repo,
  });
  return commit.status === "moved"
    ? { ...fixedByModel, status: "head-moved" }
    : { ...fixedByModel, commitSha: commit.sha, status: "committed" };
};

/**
 * Commits the automatic fix alone, as without a model, and, when the
 * findings were the model's to fix, tells the maintainers on the pull
 * request why its changes were not committed, or why it was not asked,
 * once for the head, unless the head moved on.
 */
const commitAutomaticFix = async (
  settlement: Settlement,
  fixed: Extract<SandboxResult, { status: "fixed" }>
): Promise<ApplyLintFixesResult> => {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    botLogin,
    branch,
    headSha,
    packageManager,
    dryRun,
  } = settlement;
  const { blobs, changes, checkPassed } = fixed;
  const output = checkPassed ? undefined : fixed.output;
  const paths = changes.map(({ path }) => path);
  const findings =
    fixed.findings === undefined
      ? undefined
      : summarizeFindings(fixed.findings);

  const reportFindings = () => (findings === undefined ? {} : { findings });
  const tellMaintainers = async () =>
    findings === undefined || dryRun
      ? reportFindings()
      : {
          findings: {
            ...findings,
            comment: await ensureIssueComment(octokit, {
              author: botLogin,
              body: findingsComment(headSha, findings, {
                command: checkCommand(packageManager),
                output: fixed.output,
              }),
              issueNumber: pullNumber,
              marker: findingsMarker(headSha),
              owner,
              repo,
            }),
          },
        };

  if (changes.length === 0) {
    return checkPassed
      ? { headSha, status: "lint-passed" }
      : {
          ...(await tellMaintainers()),
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

  const fixedPaths = { checkPassed, headSha, output, paths };
  if (dryRun) {
    return { ...fixedPaths, ...reportFindings(), status: "would-commit" };
  }

  const commit = await addCommitToBranch(octokit, {
    ...commitOf(changes, blobs),
    branch,
    headSha,
    message: `${LINT_FIX_COMMIT_SUBJECT}\n\nRan \`ultracite fix\` with ${packageManager} on ${headSha}.`,
    owner,
    repo,
  });

  return commit.status === "moved"
    ? { ...fixedPaths, ...reportFindings(), status: "head-moved" }
    : {
        ...fixedPaths,
        ...(await tellMaintainers()),
        commitSha: commit.sha,
        status: "committed",
      };
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
 * tools, in a sandbox with no write credential.
 *
 * When findings remain after the automatic fix, the fixer has a model fix
 * them in the same sandbox, cut off from the network. The job then runs the
 * check and reads the diff itself, and commits the model's changes, with the
 * automatic fix's, only when the check passes and they change no lock file,
 * `package.json`, file under `.github/`, or lint configuration, and add no
 * comment that turns a finding off. Otherwise it commits the automatic fix
 * alone, as without a model, and comments on the pull request once for the
 * head. The model gets one attempt per head, and the comment records it.
 * When the steps before the model took so long that its time is up before
 * it starts, it is not asked, and the comment says so instead.
 *
 * It commits on top of the head and only as a fast-forward, and refuses an
 * automatic fix that changes a lock file, a `package.json`, or a file under
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
    botLogin,
    sandbox,
    createReadToken,
    fixer,
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

  // The comment on a head records that the model tried it.
  const tried =
    fixer !== undefined &&
    (await findIssueComment(octokit, {
      author: botLogin,
      body: "",
      issueNumber: pullNumber,
      marker: findingsMarker(headSha),
      owner,
      repo,
    })) !== undefined;

  const readToken = pullRequest.base.repo.private
    ? await createReadToken()
    : undefined;
  const fixed = await sandbox(
    (session) =>
      fixInSandbox(session, {
        fixer: tried ? undefined : fixer,
        headSha,
        owner,
        packageManager,
        readToken,
        repo,
      }),
    { timeoutMs: SANDBOX_TIMEOUT_MS, vcpus: SANDBOX_VCPUS }
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

  const settlement = {
    botLogin,
    branch: pullRequest.head.ref,
    dryRun,
    headSha,
    octokit,
    owner,
    packageManager,
    pullNumber,
    repo,
  };
  // The model's changes, with the automatic fix's, make the check pass.
  return fixed.findings?.status === "checked" &&
    fixed.findings.verdict.result === "accepted"
    ? commitFindingsFix(settlement, fixed.findings)
    : commitAutomaticFix(settlement, fixed);
};

const modelRunFields = (run: LintFindingsModelRun | undefined): LogFields => ({
  modelFailedCalls: run?.failedCalls,
  modelReply: run?.reply,
  modelSteps: run?.steps,
  modelStopReason: run?.stopReason,
  modelToolCalls: run?.toolCalls,
});

const findingsFields = (findings: FindingsFix | undefined): LogFields => ({
  comment: findings?.comment?.id,
  commentCreated: findings?.comment?.created,
  model: findings?.model,
  modelCheckPassed: findings?.checkPassed,
  modelError: findings?.error,
  modelInvoked: findings?.invoked ?? false,
  modelPaths: findings?.paths,
  modelReason: findings?.reason,
  modelRefusedPaths: findings?.refusedPaths,
  modelStopped: findings?.stopped,
  ...modelRunFields(findings?.run),
  suppressions: findings?.suppressions,
});

/** The fields of a result to log, without file contents. */
export const summarizeLintFixResult = (
  result: ApplyLintFixesResult
): LogFields => ({
  ...findingsFields("findings" in result ? result.findings : undefined),
  checkPassed: "checkPassed" in result ? result.checkPassed : undefined,
  commit: result.status === "committed" ? result.commitSha : undefined,
  exitCode: result.status === "failed" ? result.exitCode : undefined,
  headSha: result.headSha,
  output: "output" in result ? result.output : undefined,
  paths: "paths" in result ? result.paths : undefined,
  reason: "reason" in result ? result.reason : undefined,
  refusedPaths: result.status === "refused" ? result.refusedPaths : undefined,
  status: result.status,
  step: result.status === "failed" ? result.step : undefined,
});
