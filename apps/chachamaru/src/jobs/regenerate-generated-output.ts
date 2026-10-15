import {
  addCommitToBranch,
  listChangedFiles,
  readOptionalRepositoryFile,
} from "@publira/github";
import type { Octokit } from "@publira/github";
import {
  DEFAULT_REGENERATION_TARGET_NAME,
  isRenovate,
  matchesAnyPathPattern,
  parseRegenerationConfig,
  readWorkflowEnv,
  REGENERATION_CONFIG_PATH,
  regenerationSeconds,
  RENOVATE_LOGIN,
  triggeredRegenerationTargets,
} from "@publira/maintenance-policies";
import type {
  RegenerationConfig,
  RegenerationTarget,
} from "@publira/maintenance-policies";

import type { GitFileChange } from "../git-output.ts";
import type { LogFields } from "../log.ts";
import {
  git,
  GIT_TIMEOUT_MS,
  readBlobs,
  readTokenOptions,
  runChecked,
  stageChanges,
  tail,
} from "../sandbox-git.ts";
import type { Sandbox, SandboxRunner } from "../sandbox-runner.ts";

/** The subject of the bot's commit of regenerated output. */
export const REGENERATION_COMMIT_SUBJECT =
  "chore(gen): regenerate for the updated generator versions";

/**
 * The trailer of the bot's commit of regenerated output that names a target
 * it completed, once for each, so a later run regenerates only the rest.
 */
export const REGENERATED_TARGET_TRAILER = "Regenerated-target";

const REGENERATED_TARGET_LINE = new RegExp(
  `^${REGENERATED_TARGET_TRAILER}: (?<name>\\S+)$`,
  "gmu"
);

// Where the sandbox checks the pull request out.
const WORKTREE = "/tmp/repository";

const FETCH_TIMEOUT_MS = 60_000;

// How long the Git commands before the setup may run: the init, the fetch,
// and the checkout.
const CHECKOUT_MS = GIT_TIMEOUT_MS + FETCH_TIMEOUT_MS + GIT_TIMEOUT_MS;

// How long the Git commands after the command may run, to read back what it
// changed: staging the changes, listing them, and reading the blobs.
const READ_BACK_MS = 3 * GIT_TIMEOUT_MS;

/**
 * How long a target's sandbox may live: every command in it for as long as
 * it may run, the setup commands and the command for as long as the target
 * lets them. The declaration's maximum keeps it within the 800 seconds the
 * project allows the Vercel Function that the webhook handler and the
 * hourly sweep run in, and the targets run at the same time.
 */
const sandboxTimeoutMs = (target: RegenerationTarget) =>
  CHECKOUT_MS + regenerationSeconds(target) * 1000 + READ_BACK_MS;

// Where a setup command installs a generator; it is on the PATH of the
// setup commands and of the command.
const SHELL_PRELUDE =
  'mkdir -p "$HOME/.local/bin"\nexport PATH="$HOME/.local/bin:$PATH"\n';

export interface RegenerateGeneratedOutputOptions {
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
  /** Regenerates the output without committing it. */
  dryRun?: boolean;
}

interface RegeneratedPaths {
  /** The target's generated paths the command changed, which the commit takes. */
  paths: string[];
  /** The other paths the command changed, which the commit leaves out. */
  ignoredPaths: string[];
}

type FailedStep = "command" | "fetch" | "setup";

// Omits a key from each member of a union, keeping them apart.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** What became of one target the pull request triggers. */
export type RegenerationTargetResult = { target: string } & (
  | { status: "skipped"; reason: string }
  | {
      /** The sandbox could not fetch the head, install, or regenerate. */
      status: "failed";
      step: FailedStep;
      exitCode: number;
      /** The end of the command's output. */
      output: string;
    }
  | {
      /** The regeneration threw, such as when no sandbox could start. */
      status: "error";
      error: string;
    }
  | { status: "unchanged"; ignoredPaths: string[] }
  | ({ status: "would-commit" } & RegeneratedPaths)
  | ({ status: "committed"; commitSha: string } & RegeneratedPaths)
  | ({
      /** The branch moved while the job ran; its push is evaluated anew. */
      status: "head-moved";
    } & RegeneratedPaths)
);

export type RegenerateGeneratedOutputResult =
  | { status: "skipped"; headSha: string; reason: string }
  | {
      status: "evaluated";
      headSha: string;
      /** Every target the pull request triggers, in the declared order. */
      targets: RegenerationTargetResult[];
    };

interface SandboxRequest {
  owner: string;
  repo: string;
  headSha: string;
  readToken: string | undefined;
  target: RegenerationTarget;
  env: Readonly<Record<string, string>>;
}

type SandboxResult =
  | Omit<Extract<RegenerationTargetResult, { status: "failed" }>, "target">
  | {
      status: "regenerated";
      changes: GitFileChange[];
      /** The blobs of the generated files the command wrote. */
      blobs: Map<string, Buffer>;
    };

const failure = (
  step: FailedStep,
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
 * Checks out the head, installs a target's generators, runs its command, and
 * reads back what changed under its generated paths. The sandbox gets no
 * credential but the read token, and that only for the fetch, which does not
 * store it where the setup or the command could read it.
 */
const regenerateInSandbox = async (
  sandbox: Sandbox,
  { owner, repo, headSha, readToken, target, env }: SandboxRequest
): Promise<SandboxResult> => {
  await runChecked(sandbox, {
    args: ["init", "--quiet", WORKTREE],
    cmd: "git",
    timeoutMs: GIT_TIMEOUT_MS,
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

  const shell = (script: string, timeoutMs: number) =>
    sandbox.run({
      args: ["-eo", "pipefail", "-c", `${SHELL_PRELUDE}${script}`],
      cmd: "bash",
      cwd: WORKTREE,
      env: { ...env, CI: "true", NO_COLOR: "1" },
      timeoutMs,
    });

  for (const command of target.setup) {
    // oxlint-disable-next-line no-await-in-loop -- each builds on the last
    const setup = await shell(command, target.setupTimeout * 1000);
    if (setup.exitCode !== 0) {
      return failure("setup", setup);
    }
  }

  const regeneration = await shell(target.command, target.timeout * 1000);
  if (regeneration.exitCode !== 0) {
    return failure("command", regeneration);
  }

  const changes = await stageChanges(sandbox, WORKTREE);
  const blobs = await readBlobs(
    sandbox,
    WORKTREE,
    changes.flatMap(({ after, path }) =>
      after !== undefined && matchesAnyPathPattern(target.paths, path)
        ? [after.sha]
        : []
    )
  );

  return { blobs, changes, status: "regenerated" };
};

interface Skip {
  reason: string;
}

interface Plan {
  /** The targets the pull request triggers. */
  targets: RegenerationTarget[];
}

interface PullRequestRefs {
  baseSha: string;
  headSha: string;
}

/** Reads the declaration from the base branch, or why there is none. */
const readConfig = async (
  { octokit, owner, repo }: RegenerateGeneratedOutputOptions,
  baseSha: string
): Promise<RegenerationConfig | Skip> => {
  const source = await readOptionalRepositoryFile(octokit, {
    owner,
    path: REGENERATION_CONFIG_PATH,
    ref: baseSha,
    repo,
  });
  if (source === undefined) {
    return { reason: `the base branch has no ${REGENERATION_CONFIG_PATH}` };
  }
  const parsed = parseRegenerationConfig(source);
  return parsed.result === "valid" ? parsed.config : { reason: parsed.reason };
};

/** Reads the head's workflow env that a target names, if any. */
const readEnv = async (
  { octokit, owner, repo }: RegenerateGeneratedOutputOptions,
  { workflowEnv }: RegenerationTarget,
  headSha: string
): Promise<Record<string, string> | Skip> => {
  if (workflowEnv === undefined) {
    return {};
  }
  const workflow = await readOptionalRepositoryFile(octokit, {
    owner,
    path: workflowEnv,
    ref: headSha,
    repo,
  });
  if (workflow === undefined) {
    return { reason: `the head has no ${workflowEnv}` };
  }
  try {
    return readWorkflowEnv(workflow);
  } catch (error) {
    return {
      reason: `${workflowEnv}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const isSkip = <T extends Plan | RegenerationConfig | Record<string, string>>(
  value: T | Skip
): value is Skip => "reason" in value;

type ComparedCommit = Awaited<
  ReturnType<Octokit["rest"]["repos"]["compareCommitsWithBasehead"]>
>["data"]["commits"][number];

/**
 * The targets the bot's regeneration commits on top of the head completed.
 * A commit that names none, which the bot made before a declaration had
 * targets, completed the single regeneration a declaration without targets
 * is read as, and no target declared since. Any other commit on top, such as
 * Renovate's rewrite, leaves none completed.
 */
const completedTargets = (
  commits: readonly ComparedCommit[],
  { botLogin, headSha }: { botLogin: string; headSha: string }
): ReadonlySet<string> => {
  const completed = new Set<string>();
  if (commits.at(-1)?.sha !== headSha) {
    return completed;
  }
  for (const { author, commit } of commits.toReversed()) {
    if (
      author?.login !== botLogin ||
      commit.message.split("\n", 1)[0] !== REGENERATION_COMMIT_SUBJECT
    ) {
      break;
    }
    const names = [...commit.message.matchAll(REGENERATED_TARGET_LINE)].map(
      ({ groups }) => groups?.name ?? ""
    );
    for (const name of names.length === 0
      ? [DEFAULT_REGENERATION_TARGET_NAME]
      : names) {
      completed.add(name);
    }
  }
  return completed;
};

/**
 * Decides which targets the pull request calls for: the base branch
 * declares them, Renovate's commits change a file they name, as the
 * approval reads them, and the bot's regeneration commits on top of the
 * head have not completed them already.
 */
const plan = async (
  options: RegenerateGeneratedOutputOptions,
  { baseSha, headSha }: PullRequestRefs
): Promise<Plan | Skip> => {
  const { octokit, owner, repo, botLogin } = options;
  const config = await readConfig(options, baseSha);
  if (isSkip(config)) {
    return config;
  }

  const { data: comparison } =
    await octokit.rest.repos.compareCommitsWithBasehead({
      basehead: `${baseSha}...${headSha}`,
      owner,
      repo,
    });

  const completed = completedTargets(comparison.commits, {
    botLogin,
    headSha,
  });
  const renovateFiles = await Promise.all(
    comparison.commits
      // As the approval reads them: by the author's login.
      .filter(({ author }) => author?.login === RENOVATE_LOGIN)
      .map(({ sha }) => listChangedFiles(octokit, { owner, repo, sha }))
  );
  const triggered = triggeredRegenerationTargets(config, renovateFiles.flat());
  if (triggered.length === 0) {
    return {
      reason: "Renovate's commits change no file that calls for a regeneration",
    };
  }
  const targets = triggered.filter(({ name }) => !completed.has(name));
  return targets.length === 0
    ? { reason: "the head is the bot's regeneration already" }
    : { targets };
};

type Regenerated = {
  status: "regenerated";
  target: RegenerationTarget;
  /** The changes under the target's generated paths. */
  committed: GitFileChange[];
  blobs: Map<string, Buffer>;
} & RegeneratedPaths;

/** What a target's sandbox regenerated, before the commit. */
type TargetRun =
  | Exclude<
      RegenerationTargetResult,
      { status: "committed" | "head-moved" | "would-commit" }
    >
  | Regenerated;

interface TargetRequest {
  options: RegenerateGeneratedOutputOptions;
  headSha: string;
  readToken: string | undefined;
}

/**
 * Regenerates one target in a sandbox of its own and splits what changed
 * into its generated paths and the rest. It never throws, so one target's
 * failure leaves the others' output to commit.
 */
const regenerateTarget = async (
  { options, headSha, readToken }: TargetRequest,
  target: RegenerationTarget
): Promise<TargetRun> => {
  const { owner, repo, sandbox } = options;
  try {
    const env = await readEnv(options, target, headSha);
    if (isSkip(env)) {
      return { reason: env.reason, status: "skipped", target: target.name };
    }
    const regenerated = await sandbox(
      (session) =>
        regenerateInSandbox(session, {
          env,
          headSha,
          owner,
          readToken,
          repo,
          target,
        }),
      { timeoutMs: sandboxTimeoutMs(target) }
    );
    if (regenerated.status === "failed") {
      return { ...regenerated, target: target.name };
    }

    const isGenerated = ({ path }: GitFileChange) =>
      matchesAnyPathPattern(target.paths, path);
    const committed = regenerated.changes.filter(isGenerated);
    const ignoredPaths = regenerated.changes
      .filter((change) => !isGenerated(change))
      .map(({ path }) => path);
    return committed.length === 0
      ? { ignoredPaths, status: "unchanged", target: target.name }
      : {
          blobs: regenerated.blobs,
          committed,
          ignoredPaths,
          paths: committed.map(({ path }) => path),
          status: "regenerated",
          target,
        };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: "error",
      target: target.name,
    };
  }
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
 * Regenerates the output of a repository's code generators on a Renovate
 * pull request that changes one of the files the repository declares in
 * {@link REGENERATION_CONFIG_PATH}, such as a generator's pinned version,
 * and commits the generated paths that changed to the pull request's
 * branch. Renovate rewrites the versions but cannot run the generators, so
 * the repository's CI would reject such a pull request until someone did.
 *
 * Each target the pull request triggers runs at the same time, in a sandbox
 * of its own, and contributes only its own generated paths to one commit; a
 * target that fails leaves the others' output to commit.
 *
 * The declaration is read from the base branch, so a pull request cannot
 * widen what the bot commits. The command runs the pull request's own code,
 * in a sandbox with no write credential; the generators are the versions the
 * head's workflow pins, the ones CI verifies the output with. No model is
 * asked.
 *
 * It commits only when the generated files differ from the head's, on top
 * of the head and only as a fast-forward, and leaves a head that is its own
 * regeneration commit alone. Renovate may discard the commit when it
 * rewrites its branch; the evaluation of that push brings it back.
 */
export const regenerateGeneratedOutput = async (
  options: RegenerateGeneratedOutputOptions
): Promise<RegenerateGeneratedOutputResult> => {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
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

  const planned = await plan(options, {
    baseSha: pullRequest.base.sha,
    headSha,
  });
  if (isSkip(planned)) {
    return skip(planned.reason);
  }

  const readToken = pullRequest.base.repo.private
    ? await createReadToken()
    : undefined;
  const runs = await Promise.all(
    planned.targets.map((target) =>
      regenerateTarget({ headSha, options, readToken }, target)
    )
  );
  const regenerated = runs.filter(
    (run): run is Regenerated => run.status === "regenerated"
  );
  const evaluated = (
    outcome: (
      paths: RegeneratedPaths
    ) => DistributiveOmit<
      Extract<
        RegenerationTargetResult,
        { status: "committed" | "head-moved" | "would-commit" }
      >,
      "target"
    >
  ): RegenerateGeneratedOutputResult => ({
    headSha,
    status: "evaluated",
    targets: runs.map((run) =>
      run.status === "regenerated"
        ? {
            ...outcome({ ignoredPaths: run.ignoredPaths, paths: run.paths }),
            target: run.target.name,
          }
        : run
    ),
  });

  if (regenerated.length === 0 || dryRun) {
    return evaluated((paths) => ({ ...paths, status: "would-commit" }));
  }

  // The targets' generated paths do not overlap, so neither do their
  // changes.
  const committed = regenerated.flatMap(({ blobs, committed: changes }) =>
    changes.map((change) => ({ blobs, change }))
  );
  const commit = await addCommitToBranch(octokit, {
    branch: pullRequest.head.ref,
    files: Object.fromEntries(
      committed.map(({ blobs, change }) => [
        change.path,
        contentOf(blobs)(change),
      ])
    ),
    headSha,
    message: [
      REGENERATION_COMMIT_SUBJECT,
      `Ran on ${headSha}:`,
      regenerated
        .map(({ target }) => `- ${target.name}: \`${target.command}\``)
        .join("\n"),
      // Those it commits and those whose output is current.
      [
        ...regenerated.map(({ target }) => target.name),
        ...runs.flatMap((run) =>
          run.status === "unchanged" ? [run.target] : []
        ),
      ]
        .map((name) => `${REGENERATED_TARGET_TRAILER}: ${name}`)
        .join("\n"),
    ].join("\n\n"),
    modes: Object.fromEntries(
      committed.flatMap(({ change: { after, path } }) =>
        after === undefined ? [] : [[path, after.mode]]
      )
    ),
    owner,
    repo,
  });

  return evaluated((paths) =>
    commit.status === "moved"
      ? { ...paths, status: "head-moved" }
      : { ...paths, commitSha: commit.sha, status: "committed" }
  );
};

// The statuses after which the bot moved the head, or would in a dry run.
const HEAD_MOVING_STATUSES = new Set<RegenerationTargetResult["status"]>([
  "committed",
  "head-moved",
  "would-commit",
]);

/** Whether the bot moved the head, or would in a dry run. */
export const regenerationMovesHead = (
  result: RegenerateGeneratedOutputResult
): boolean =>
  result.status === "evaluated" &&
  result.targets.some(({ status }) => HEAD_MOVING_STATUSES.has(status));

/**
 * The fields of a result to log, without file contents: one line for each
 * target, or one for a pull request the job left alone.
 */
export const summarizeRegenerationResult = (
  result: RegenerateGeneratedOutputResult
): LogFields[] =>
  result.status === "skipped"
    ? [
        {
          headSha: result.headSha,
          modelInvoked: false,
          reason: result.reason,
          status: result.status,
        },
      ]
    : result.targets.map((target) => ({
        commit: target.status === "committed" ? target.commitSha : undefined,
        error: target.status === "error" ? target.error : undefined,
        exitCode: target.status === "failed" ? target.exitCode : undefined,
        headSha: result.headSha,
        ignoredPaths:
          "ignoredPaths" in target ? target.ignoredPaths : undefined,
        modelInvoked: false,
        output: target.status === "failed" ? target.output : undefined,
        paths: "paths" in target ? target.paths : undefined,
        reason: target.status === "skipped" ? target.reason : undefined,
        status: target.status,
        step: target.status === "failed" ? target.step : undefined,
        target: target.target,
      }));
