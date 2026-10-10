import { addCommitToBranch, readOptionalRepositoryFile } from "@publira/github";
import type { Octokit } from "@publira/github";
import {
  isRenovate,
  matchesAnyPathPattern,
  readWorkflowEnv,
  REGENERATION_CONFIG_PATH,
} from "@publira/maintenance-policies";
import type { RegenerationConfig } from "@publira/maintenance-policies";

import type { GitFileChange } from "../git-output.ts";
import type { LogFields } from "../log.ts";
import { readRegenerationConfig } from "../regeneration-config.ts";
import {
  git,
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

// Where the sandbox checks the pull request out.
const WORKTREE = "/tmp/repository";

/**
 * How long the sandbox may live, within the 300 seconds a Vercel Function
 * runs by default, which the webhook handler and the hourly sweep run in.
 */
export const SANDBOX_TIMEOUT_MS = 240_000;

const FETCH_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 120_000;

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
  /** The generated paths the command changed, which the commit takes. */
  paths: string[];
  /** The other paths the command changed, which the commit leaves out. */
  ignoredPaths: string[];
}

export type RegenerateGeneratedOutputResult =
  | { status: "skipped"; headSha: string; reason: string }
  | {
      /** The sandbox could not fetch the head, install, or regenerate. */
      status: "failed";
      headSha: string;
      step: "command" | "fetch" | "setup";
      exitCode: number;
      /** The end of the command's output. */
      output: string;
    }
  | { status: "unchanged"; headSha: string; ignoredPaths: string[] }
  | ({ status: "would-commit"; headSha: string } & RegeneratedPaths)
  | ({
      status: "committed";
      headSha: string;
      commitSha: string;
    } & RegeneratedPaths)
  | ({
      /** The branch moved while the job ran; its push is evaluated anew. */
      status: "head-moved";
      headSha: string;
    } & RegeneratedPaths);

interface SandboxRequest {
  owner: string;
  repo: string;
  headSha: string;
  readToken: string | undefined;
  config: RegenerationConfig;
  env: Readonly<Record<string, string>>;
}

type SandboxResult =
  | Omit<
      Extract<RegenerateGeneratedOutputResult, { status: "failed" }>,
      "headSha"
    >
  | {
      status: "regenerated";
      changes: GitFileChange[];
      /** The blobs of the generated files the command wrote. */
      blobs: Map<string, Buffer>;
    };

const failure = (
  step: "command" | "fetch" | "setup",
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
 * Checks out the head, installs the generators, runs the command, and reads
 * back what changed under the generated paths. The sandbox gets no
 * credential but the read token, and that only for the fetch, which does not
 * store it where the setup or the command could read it.
 */
const regenerateInSandbox = async (
  sandbox: Sandbox,
  { owner, repo, headSha, readToken, config, env }: SandboxRequest
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

  const shell = (script: string, timeoutMs: number) =>
    sandbox.run({
      args: ["-eo", "pipefail", "-c", `${SHELL_PRELUDE}${script}`],
      cmd: "bash",
      cwd: WORKTREE,
      env: { ...env, CI: "true", NO_COLOR: "1" },
      timeoutMs,
    });

  for (const command of config.setup) {
    // oxlint-disable-next-line no-await-in-loop -- each builds on the last
    const setup = await shell(command, SETUP_TIMEOUT_MS);
    if (setup.exitCode !== 0) {
      return failure("setup", setup);
    }
  }

  const regeneration = await shell(config.command, COMMAND_TIMEOUT_MS);
  if (regeneration.exitCode !== 0) {
    return failure("command", regeneration);
  }

  const changes = await stageChanges(sandbox, WORKTREE);
  const blobs = await readBlobs(
    sandbox,
    WORKTREE,
    changes.flatMap(({ after, path }) =>
      after !== undefined && matchesAnyPathPattern(config.paths, path)
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
  config: RegenerationConfig;
  /** The environment of the setup commands and the command. */
  env: Record<string, string>;
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
  const parsed = await readRegenerationConfig(octokit, {
    owner,
    ref: baseSha,
    repo,
  });
  if (parsed === undefined) {
    return { reason: `the base branch has no ${REGENERATION_CONFIG_PATH}` };
  }
  return parsed.result === "valid" ? parsed.config : { reason: parsed.reason };
};

/** Reads the head's workflow env that the declaration names, if any. */
const readEnv = async (
  { octokit, owner, repo }: RegenerateGeneratedOutputOptions,
  { workflowEnv }: RegenerationConfig,
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

/**
 * Decides whether the pull request calls for a regeneration: the base
 * branch declares one, the pull request changes a file it names, and the
 * head is not the bot's regeneration already.
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

  const head = comparison.commits.at(-1);
  if (
    head?.sha === headSha &&
    head.author?.login === botLogin &&
    head.commit.message.split("\n", 1)[0] === REGENERATION_COMMIT_SUBJECT
  ) {
    return { reason: "the head is the bot's regeneration already" };
  }

  const changed = (comparison.files ?? []).map(({ filename }) => filename);
  if (!changed.some((path) => matchesAnyPathPattern(config.triggers, path))) {
    return {
      reason: "the pull request changes no file that calls for a regeneration",
    };
  }

  const env = await readEnv(options, config, headSha);
  return isSkip(env) ? env : { config, env };
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

  const planned = await plan(options, {
    baseSha: pullRequest.base.sha,
    headSha,
  });
  if (isSkip(planned)) {
    return skip(planned.reason);
  }
  const { config, env } = planned;

  const readToken = pullRequest.base.repo.private
    ? await createReadToken()
    : undefined;
  const regenerated = await sandbox((session) =>
    regenerateInSandbox(session, {
      config,
      env,
      headSha,
      owner,
      readToken,
      repo,
    })
  );

  if (regenerated.status === "failed") {
    return { ...regenerated, headSha };
  }

  const { blobs, changes } = regenerated;
  const isGenerated = ({ path }: GitFileChange) =>
    matchesAnyPathPattern(config.paths, path);
  const committed = changes.filter(isGenerated);
  const ignoredPaths = changes
    .filter((change) => !isGenerated(change))
    .map(({ path }) => path);

  if (committed.length === 0) {
    return { headSha, ignoredPaths, status: "unchanged" };
  }

  const paths = committed.map(({ path }) => path);

  if (dryRun) {
    return { headSha, ignoredPaths, paths, status: "would-commit" };
  }

  const commit = await addCommitToBranch(octokit, {
    branch: pullRequest.head.ref,
    files: Object.fromEntries(
      committed.map((change) => [change.path, contentOf(blobs)(change)])
    ),
    headSha,
    message: `${REGENERATION_COMMIT_SUBJECT}\n\nRan \`${config.command}\` on ${headSha}.`,
    modes: Object.fromEntries(
      committed.flatMap(({ after, path }) =>
        after === undefined ? [] : [[path, after.mode]]
      )
    ),
    owner,
    repo,
  });

  return commit.status === "moved"
    ? { headSha, ignoredPaths, paths, status: "head-moved" }
    : {
        commitSha: commit.sha,
        headSha,
        ignoredPaths,
        paths,
        status: "committed",
      };
};

/** The fields of a result to log, without file contents. */
export const summarizeRegenerationResult = (
  result: RegenerateGeneratedOutputResult
): LogFields => ({
  commit: result.status === "committed" ? result.commitSha : undefined,
  exitCode: result.status === "failed" ? result.exitCode : undefined,
  headSha: result.headSha,
  ignoredPaths: "ignoredPaths" in result ? result.ignoredPaths : undefined,
  modelInvoked: false,
  output: result.status === "failed" ? result.output : undefined,
  paths: "paths" in result ? result.paths : undefined,
  reason: result.status === "skipped" ? result.reason : undefined,
  status: result.status,
  step: result.status === "failed" ? result.step : undefined,
});
