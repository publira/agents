import { isDeepStrictEqual } from "node:util";

import {
  commitToBranch,
  createRepositoryReadToken,
  ensurePullRequest,
  listAppRepositories,
  listCommitFiles,
  readOptionalRepositoryFile,
} from "@publira/github";
import type { GitHubApp, Octokit, TreeFile } from "@publira/github";
import {
  diffSkillsLocks,
  isAgentSkillsPath,
  SKILLS_LOCK_FILE,
} from "@publira/maintenance-policies";
import type { SkillChange } from "@publira/maintenance-policies";

import { parseStagedFiles } from "../git-output.ts";
import type { GitFile, GitFileChange } from "../git-output.ts";
import { loggableFailure, withFields } from "../log.ts";
import type { Log, LogFields } from "../log.ts";
import {
  git,
  readBlobs,
  readTokenOptions,
  stageChanges,
  tail,
} from "../sandbox-git.ts";
import type { Sandbox, SandboxRunner } from "../sandbox-runner.ts";

// renovate: datasource=npm depName=skills
export const SKILLS_VERSION = "1.7.1";

/** The branch the update pull request comes from. */
export const SKILLS_UPDATE_BRANCH = "maintenance-bot/update-agent-skills";

const TITLE = "chore(skills): update agent skills";

// Where the sandbox clones the repository.
const WORKTREE = "/tmp/repository";

/**
 * How long the sandbox may live, within the 300 seconds a Vercel Function
 * runs by default. A clone and an update of publira/publira took 30 seconds.
 */
export const SANDBOX_TIMEOUT_MS = 240_000;

const CLONE_TIMEOUT_MS = 60_000;
const UPDATE_TIMEOUT_MS = 120_000;

export interface UpdateAgentSkillsOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  sandbox: SandboxRunner;
  /**
   * Creates a token that can only read the repository, which the sandbox
   * clones a private repository with. A public one is cloned anonymously.
   */
  createReadToken: () => Promise<string>;
  /** Runs the update without pushing a branch or opening a pull request. */
  dryRun?: boolean;
}

interface SkillsUpdatePlan {
  /** The commit of the default branch the update ran on. */
  baseSha: string;
  skills: SkillChange[];
  /** The paths the update changed that the commit takes. */
  paths: string[];
  /** The paths the update changed that the commit leaves out. */
  ignoredPaths: string[];
}

export type UpdateAgentSkillsResult =
  | { status: "no-lock-file" }
  | {
      /** The sandbox could not clone the repository or update its skills. */
      status: "failed";
      step: "clone" | "update";
      exitCode: number;
      /** The end of the command's output. */
      output: string;
    }
  | { status: "unchanged"; baseSha: string; ignoredPaths: string[] }
  | ({ status: "planned" } & SkillsUpdatePlan)
  | ({
      status: "pull-request";
      /** `false` when the open pull request already held the update. */
      committed: boolean;
      pullRequest: { number: number; url: string; created: boolean };
    } & SkillsUpdatePlan);

interface SandboxUpdateRequest {
  owner: string;
  repo: string;
  branch: string;
  readToken: string | undefined;
}

type SandboxUpdateResult =
  | Extract<UpdateAgentSkillsResult, { status: "failed" }>
  | {
      status: "updated";
      baseSha: string;
      changes: GitFileChange[];
      /** Every file after the update, by path. */
      files: Map<string, GitFile>;
      /** The blobs of the files the update wrote under the skill paths. */
      blobs: Map<string, Buffer>;
    };

/**
 * Clones the branch, updates its skills, and reads back what changed. The
 * sandbox gets no credential but the read token, and that only for the
 * clone, which does not store it where the update could read it.
 */
const updateInSandbox = async (
  sandbox: Sandbox,
  { owner, repo, branch, readToken }: SandboxUpdateRequest
): Promise<SandboxUpdateResult> => {
  const clone = await sandbox.run({
    args: [
      ...readTokenOptions(readToken),
      "clone",
      "--depth=1",
      "--single-branch",
      `--branch=${branch}`,
      `https://github.com/${owner}/${repo}.git`,
      WORKTREE,
    ],
    cmd: "git",
    // Fail rather than wait for a password.
    env: { GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: CLONE_TIMEOUT_MS,
  });

  if (clone.exitCode !== 0) {
    return {
      exitCode: clone.exitCode,
      output: tail(clone.stderr),
      status: "failed",
      step: "clone",
    };
  }

  const head = await git(sandbox, WORKTREE, "rev-parse", "HEAD");
  const baseSha = head.trim();
  const update = await sandbox.run({
    args: ["-y", `skills@${SKILLS_VERSION}`, "update", "-p", "-y"],
    cmd: "npx",
    cwd: WORKTREE,
    env: { CI: "true", NO_COLOR: "1" },
    timeoutMs: UPDATE_TIMEOUT_MS,
  });

  if (update.exitCode !== 0) {
    return {
      exitCode: update.exitCode,
      output: tail(`${update.stdout}${update.stderr}`),
      status: "failed",
      step: "update",
    };
  }

  const changes = await stageChanges(sandbox, WORKTREE);
  const files = parseStagedFiles(
    await git(sandbox, WORKTREE, "ls-files", "--stage", "-z")
  );
  const wanted = [
    ...new Set(
      changes
        .filter(({ path }) => isAgentSkillsPath(path))
        .flatMap(({ before, after, path }) => [
          ...(after === undefined ? [] : [after.sha]),
          // The lock file's old version tells which skills changed.
          ...(path === SKILLS_LOCK_FILE && before !== undefined
            ? [before.sha]
            : []),
        ])
    ),
  ];
  const blobs = await readBlobs(sandbox, WORKTREE, wanted);

  return { baseSha, blobs, changes, files, status: "updated" };
};

const commitMessage = (skills: readonly SkillChange[]) =>
  [
    TITLE,
    "",
    ...(skills.length === 0
      ? ["Refresh the vendored agent skills."]
      : skills.map(
          ({ change, name, source }) => `- ${name} (${source}): ${change}`
        )),
  ].join("\n");

const pullRequestBody = (
  skills: readonly SkillChange[],
  paths: readonly string[]
) =>
  [
    "## Summary",
    "",
    `\`npx skills@${SKILLS_VERSION} update -p -y\` updated the agent skills vendored in this repository from their sources:`,
    "",
    ...(skills.length === 0
      ? [
          `- ${paths.length} files changed, and no entry of \`${SKILLS_LOCK_FILE}\` did.`,
        ]
      : [
          "| Skill | Source | Change |",
          "| --- | --- | --- |",
          ...skills.map(
            ({ change, name, source }) =>
              `| \`${name}\` | \`${source}\` | ${change} |`
          ),
        ]),
    "",
    "## Review",
    "",
    "A skill is instructions that coding agents follow in this repository. Read the changes to them before merging, as you would a change to `AGENTS.md`: an update can change what an agent does, which commands it runs, and which sources it trusts.",
    "",
    `The maintenance bot ran the update in an isolated sandbox and committed only its changes under \`.agents/skills/\`, \`.claude/skills/\`, and \`${SKILLS_LOCK_FILE}\`. It neither approves nor merges this pull request, and it updates the branch when the skills change upstream again.`,
  ].join("\n");

const decode = (blob: Buffer | undefined) => blob?.toString("utf-8");

const skillFilesOf = (entries: Iterable<readonly [string, GitFile]>) =>
  new Map([...entries].filter(([path]) => isAgentSkillsPath(path)));

/**
 * Whether a commit holds the same files under the skill paths as the update
 * does, whatever else differs, such as the base it started from.
 */
const holdsUpdate = (
  commitFiles: readonly TreeFile[],
  updated: ReadonlyMap<string, GitFile>
) =>
  isDeepStrictEqual(
    skillFilesOf(
      commitFiles.map(({ path, mode, sha }) => [path, { mode, sha }] as const)
    ),
    skillFilesOf(updated)
  );

/**
 * Runs `npx skills update` on the default branch of a repository that has a
 * `skills-lock.json`, in a sandbox, since the update runs code and writes
 * files that come from the skills' sources. It commits the changes under the
 * skill paths to {@link SKILLS_UPDATE_BRANCH} and opens a pull request,
 * which a maintainer reviews: the bot does not approve it.
 *
 * Running it again changes nothing while the open pull request holds the
 * same skill files, even once the default branch moved on.
 */
export const updateAgentSkills = async ({
  octokit,
  owner,
  repo,
  sandbox,
  createReadToken,
  dryRun = false,
}: UpdateAgentSkillsOptions): Promise<UpdateAgentSkillsResult> => {
  const { data: repository } = await octokit.rest.repos.get({ owner, repo });
  const branch = repository.default_branch;
  const lockFile = await readOptionalRepositoryFile(octokit, {
    owner,
    path: SKILLS_LOCK_FILE,
    ref: branch,
    repo,
  });

  if (lockFile === undefined) {
    return { status: "no-lock-file" };
  }

  const readToken = repository.private ? await createReadToken() : undefined;
  const update = await sandbox((session) =>
    updateInSandbox(session, { branch, owner, readToken, repo })
  );

  if (update.status === "failed") {
    return update;
  }

  const { baseSha, blobs, changes, files: updatedFiles } = update;
  const committed = changes.filter(({ path }) => isAgentSkillsPath(path));
  const ignoredPaths = changes
    .filter(({ path }) => !isAgentSkillsPath(path))
    .map(({ path }) => path);

  if (committed.length === 0) {
    return { baseSha, ignoredPaths, status: "unchanged" };
  }

  const lockChange = committed.find(({ path }) => path === SKILLS_LOCK_FILE);
  const skills =
    lockChange === undefined
      ? []
      : diffSkillsLocks(
          decode(
            lockChange.before === undefined
              ? undefined
              : blobs.get(lockChange.before.sha)
          ),
          decode(
            lockChange.after === undefined
              ? undefined
              : blobs.get(lockChange.after.sha)
          )
        );
  const paths = committed.map(({ path }) => path);
  const plan = { baseSha, ignoredPaths, paths, skills };

  if (dryRun) {
    return { ...plan, status: "planned" };
  }

  const ensureUpdatePullRequest = () =>
    ensurePullRequest(octokit, {
      base: branch,
      body: pullRequestBody(skills, paths),
      head: SKILLS_UPDATE_BRANCH,
      owner,
      repo,
      title: TITLE,
    });
  const {
    data: [open],
  } = await octokit.rest.pulls.list({
    base: branch,
    head: `${owner}:${SKILLS_UPDATE_BRANCH}`,
    owner,
    per_page: 1,
    repo,
    state: "open",
  });

  if (
    open !== undefined &&
    holdsUpdate(
      await listCommitFiles(octokit, { owner, repo, sha: open.head.sha }),
      updatedFiles
    )
  ) {
    return {
      ...plan,
      committed: false,
      pullRequest: await ensureUpdatePullRequest(),
      status: "pull-request",
    };
  }

  const contentOf = ({ after, path }: GitFileChange) => {
    if (after === undefined) {
      return null;
    }
    const content = blobs.get(after.sha);
    if (content === undefined) {
      throw new Error(`The sandbox did not return ${path}`);
    }
    return content;
  };

  await commitToBranch(octokit, {
    baseSha,
    branch: SKILLS_UPDATE_BRANCH,
    files: Object.fromEntries(
      committed.map((change) => [change.path, contentOf(change)])
    ),
    message: commitMessage(skills),
    modes: Object.fromEntries(
      committed.flatMap(({ after, path }) =>
        after === undefined ? [] : [[path, after.mode]]
      )
    ),
    owner,
    repo,
  });

  return {
    ...plan,
    committed: true,
    pullRequest: await ensureUpdatePullRequest(),
    status: "pull-request",
  };
};

/** The fields of a result to log, without file contents. */
export const summarizeSkillsUpdateResult = (
  result: UpdateAgentSkillsResult
): LogFields => ({
  baseSha: "baseSha" in result ? result.baseSha : undefined,
  committed: result.status === "pull-request" ? result.committed : undefined,
  exitCode: result.status === "failed" ? result.exitCode : undefined,
  ignoredPaths: "ignoredPaths" in result ? result.ignoredPaths : undefined,
  output: result.status === "failed" ? result.output : undefined,
  paths: "paths" in result ? result.paths : undefined,
  pullRequest:
    result.status === "pull-request" ? result.pullRequest.number : undefined,
  pullRequestCreated:
    result.status === "pull-request" ? result.pullRequest.created : undefined,
  skills:
    "skills" in result
      ? result.skills.map(({ change, name }) => `${name} (${change})`)
      : undefined,
  status: result.status,
  step: result.status === "failed" ? result.step : undefined,
});

export interface UpdateAgentSkillsEverywhereOptions {
  app: GitHubApp;
  sandbox: SandboxRunner;
  log: Log;
  /** Runs each update without pushing a branch or opening a pull request. */
  dryRun?: boolean;
  /** Replaced in tests. */
  job?: typeof updateAgentSkills;
}

/**
 * Runs {@link updateAgentSkills} on every unarchived repository the App is
 * installed on. A repository that fails is logged, and the others still run.
 */
export const updateAgentSkillsEverywhere = async ({
  app,
  sandbox,
  log,
  dryRun = false,
  job = updateAgentSkills,
}: UpdateAgentSkillsEverywhereOptions): Promise<void> => {
  const repositories = await listAppRepositories(app);

  await Promise.all(
    repositories
      .filter(({ archived }) => !archived)
      .map(async ({ installationId, owner, repo }) => {
        const repositoryLog = withFields(log, {
          dryRun,
          installation: installationId,
          job: "update-agent-skills",
          modelInvoked: false,
          owner,
          repo,
        });
        try {
          const result = await job({
            createReadToken: () =>
              createRepositoryReadToken(app, { installationId, repo }),
            dryRun,
            octokit: await app.getInstallationOctokit(installationId),
            owner,
            repo,
            sandbox,
          });
          if (result.status === "failed") {
            repositoryLog(
              "warn",
              "Agent skills update failed in the sandbox; the repository is left as it is",
              summarizeSkillsUpdateResult(result)
            );
          } else {
            repositoryLog(
              "info",
              "Agent skills checked",
              summarizeSkillsUpdateResult(result)
            );
          }
        } catch (error) {
          repositoryLog(
            "error",
            "Agent skills update failed",
            loggableFailure.safeParse(error).data
          );
        }
      })
  );
};
