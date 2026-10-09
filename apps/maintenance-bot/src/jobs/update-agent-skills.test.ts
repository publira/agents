import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createGitHubClient } from "@publira/github";
import type { GitHubApp } from "@publira/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Log } from "../log.ts";
import type {
  Sandbox,
  SandboxCommand,
  SandboxRunner,
} from "../sandbox-runner.ts";
import {
  SKILLS_UPDATE_BRANCH,
  SKILLS_VERSION,
  updateAgentSkills,
  updateAgentSkillsEverywhere,
} from "./update-agent-skills.ts";
import type { UpdateAgentSkillsResult } from "./update-agent-skills.ts";

// Where the job clones the repository in its sandbox.
const SANDBOX_WORKTREE = "/tmp/repository";

const lockFile = (hashes: Record<string, string>) =>
  `${JSON.stringify(
    {
      skills: Object.fromEntries(
        Object.entries(hashes).map(([name, computedHash]) => [
          name,
          {
            computedHash,
            skillPath: `skills/${name}/SKILL.md`,
            source: `publira/${name}`,
            sourceType: "github",
          },
        ])
      ),
      version: 1,
    },
    null,
    2
  )}\n`;

// Bytes that are not UTF-8, as in a font a skill ships.
const FONT = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a]);

const runGit = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const write = (root: string, file: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};

const commitAll = (root: string, message: string) => {
  runGit(root, "add", "--all");
  runGit(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    `--message=${message}`
  );
  return runGit(root, "rev-parse", "HEAD");
};

/**
 * What the skills CLI does to the fixture: it updates one skill and its lock
 * entry, adds a skill with an executable script and a link to it, and removes
 * the font. It also writes a file outside the skill paths.
 */
const applyUpdate = (root: string) => {
  write(root, ".agents/skills/ultracite/SKILL.md", "# Ultracite\n\nv2\n");
  write(root, ".agents/skills/canvas/render.sh", "#!/bin/sh\n");
  chmodSync(path.join(root, ".agents/skills/canvas/render.sh"), 0o755);
  symlinkSync(
    "../../.agents/skills/canvas",
    path.join(root, ".claude/skills/canvas")
  );
  rmSync(path.join(root, ".agents/skills/fonts"), { recursive: true });
  write(root, "skills-lock.json", lockFile({ canvas: "c1", ultracite: "u2" }));
  write(root, "skills/canvas/SKILL.md", "# Canvas\n");
};

interface Fixture {
  /** The origin the sandbox clones, standing in for GitHub. */
  origin: string;
  baseSha: string;
}

/** A repository with vendored skills, one of them linked into `.claude`. */
const createFixture = (root: string): Fixture => {
  const origin = path.join(root, "origin");
  mkdirSync(origin);
  runGit(origin, "init", "--quiet", "--initial-branch=main");
  write(origin, "README.md", "# Publira\n");
  write(origin, ".agents/skills/ultracite/SKILL.md", "# Ultracite\n\nv1\n");
  write(origin, ".agents/skills/fonts/Serif.ttf", FONT);
  mkdirSync(path.join(origin, ".claude/skills"), { recursive: true });
  symlinkSync(
    "../../.agents/skills/ultracite",
    path.join(origin, ".claude/skills/ultracite")
  );
  write(origin, "skills-lock.json", lockFile({ ultracite: "u1" }));
  return { baseSha: commitAll(origin, "Initial commit"), origin };
};

/** The tree GitHub would list for the update committed on `baseSha`. */
const updatedTree = (root: string, origin: string) => {
  const clone = path.join(root, "updated");
  runGit(root, "clone", "--quiet", origin, clone);
  applyUpdate(clone);
  rmSync(path.join(clone, "skills"), { recursive: true });
  commitAll(clone, "Update");
  return runGit(clone, "ls-tree", "-r", "--full-tree", "HEAD")
    .split("\n")
    .map((line) => {
      const [meta = "", file] = line.split("\t");
      const [mode, type, sha] = meta.split(" ");
      return { mode, path: file, sha, type };
    });
};

interface LocalSandboxOptions {
  root: string;
  origin: string;
  /** Replaces the skills CLI. */
  update?: (worktree: string) => { exitCode: number; stderr?: string };
  cloneExitCode?: number;
}

/**
 * A sandbox that runs the job's commands on this machine, in a directory of
 * its own: the clone reads the local origin, and the skills CLI is replaced.
 */
const localSandbox = ({
  root,
  origin,
  update = (worktree) => {
    applyUpdate(worktree);
    return { exitCode: 0 };
  },
  cloneExitCode = 0,
}: LocalSandboxOptions) => {
  const worktree = path.join(root, "sandbox", "repository");
  const commands: SandboxCommand[] = [];
  const localize = (value: string) =>
    value.replaceAll(SANDBOX_WORKTREE, worktree);

  const sandbox: Sandbox = {
    run(command) {
      commands.push(command);
      const args = (command.args ?? []).map(localize);

      if (command.cmd === "npx") {
        return Promise.resolve({
          stderr: "",
          stdout: "",
          ...update(worktree),
        });
      }
      if (command.cmd === "git" && args.includes("clone")) {
        if (cloneExitCode !== 0) {
          return Promise.resolve({
            exitCode: cloneExitCode,
            stderr: "fatal: repository not found",
            stdout: "",
          });
        }
        mkdirSync(path.dirname(worktree), { recursive: true });
        const cloneArgs = args.map((arg) =>
          arg.startsWith("https://github.com/") ? `file://${origin}` : arg
        );
        const result = spawnSync("git", cloneArgs, { encoding: "utf-8" });
        return Promise.resolve({
          exitCode: result.status ?? 1,
          stderr: result.stderr,
          stdout: result.stdout,
        });
      }

      const result = spawnSync(command.cmd, args, {
        cwd: command.cwd === undefined ? undefined : localize(command.cwd),
        encoding: "utf-8",
        env: { ...process.env, ...command.env },
        maxBuffer: 64 * 1024 * 1024,
      });
      return Promise.resolve({
        exitCode: result.status ?? 1,
        stderr: result.stderr,
        stdout: result.stdout,
      });
    },
  };
  let started = 0;
  const runner: SandboxRunner = (task) => {
    started += 1;
    return task(sandbox);
  };

  return { commands, runner, started: () => started, worktree };
};

const repository = "/repos/publira/publira";

interface GitHubOptions {
  private?: boolean;
  /** The lock file on the default branch; `null` for none. */
  lock?: string | null;
  /** The tree of the open update pull request's head. */
  openPullRequestTree?: ReturnType<typeof updatedTree>;
}

// Answers the GitHub API and records the writes.
const fakeGitHub = ({
  private: isPrivate = false,
  lock = lockFile({ ultracite: "u1" }),
  openPullRequestTree,
}: GitHubOptions = {}) => {
  const writes: { route: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${decodeURIComponent(url.pathname)}`;

    if (method !== "GET") {
      writes.push({ body: JSON.parse(String(init?.body)), route });
    }

    if (route === `GET ${repository}`) {
      return Promise.resolve(
        Response.json({ default_branch: "main", private: isPrivate })
      );
    }
    if (route === `GET ${repository}/contents/skills-lock.json`) {
      return Promise.resolve(
        lock === null || url.searchParams.get("ref") !== "main"
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json({
              content: Buffer.from(lock).toString("base64"),
              encoding: "base64",
              type: "file",
            })
      );
    }
    if (route === `GET ${repository}/pulls`) {
      return Promise.resolve(
        Response.json(
          openPullRequestTree === undefined
            ? []
            : [
                {
                  body: "",
                  head: { sha: "pull-head" },
                  html_url: "https://github.com/publira/publira/pull/4000",
                  number: 4000,
                  title: "chore(skills): update agent skills",
                },
              ]
        )
      );
    }
    if (route === `GET ${repository}/git/commits/pull-head`) {
      return Promise.resolve(Response.json({ tree: { sha: "pull-tree" } }));
    }
    if (route === `GET ${repository}/git/trees/pull-tree`) {
      return Promise.resolve(
        Response.json({ tree: openPullRequestTree, truncated: false })
      );
    }
    if (route.startsWith(`GET ${repository}/git/commits/`)) {
      return Promise.resolve(Response.json({ tree: { sha: "base-tree" } }));
    }
    if (route === `GET ${repository}/git/ref/heads/${SKILLS_UPDATE_BRANCH}`) {
      return Promise.resolve(
        openPullRequestTree === undefined
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json({ object: { sha: "pull-head" } })
      );
    }

    const responses = new Map<string, unknown>([
      [`POST ${repository}/git/blobs`, { sha: "font-blob" }],
      [`POST ${repository}/git/trees`, { sha: "new-tree" }],
      [`POST ${repository}/git/commits`, { sha: "new-commit" }],
      [`POST ${repository}/git/refs`, {}],
      [`PATCH ${repository}/git/refs/heads/${SKILLS_UPDATE_BRANCH}`, {}],
      [
        `POST ${repository}/pulls`,
        {
          html_url: "https://github.com/publira/publira/pull/4001",
          number: 4001,
        },
      ],
      [`PATCH ${repository}/pulls/4000`, {}],
    ]);
    const response = responses.get(route);
    return Promise.resolve(
      response === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json(response)
    );
  });

  return {
    octokit: createGitHubClient({ fetch: fetchImpl }),
    writes,
  };
};

const location = {
  // A public repository is cloned without a token.
  createReadToken: () => Promise.reject(new Error("No token for a public one")),
  owner: "publira",
  repo: "publira",
};

describe(updateAgentSkills, () => {
  let root: string;
  let fixture: Fixture;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "update-agent-skills-"));
    fixture = createFixture(root);
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("leaves a repository without skills-lock.json alone", async () => {
    const github = fakeGitHub({ lock: null });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(
      updateAgentSkills({
        ...location,
        octokit: github.octokit,
        sandbox: sandbox.runner,
      })
    ).resolves.toStrictEqual({ status: "no-lock-file" });
    expect(sandbox.started()).toBe(0);
  });

  it("plans the update in a dry run", async () => {
    const github = fakeGitHub();
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(
      updateAgentSkills({
        ...location,
        dryRun: true,
        octokit: github.octokit,
        sandbox: sandbox.runner,
      })
    ).resolves.toStrictEqual({
      baseSha: fixture.baseSha,
      ignoredPaths: ["skills/canvas/SKILL.md"],
      paths: [
        ".agents/skills/canvas/render.sh",
        ".agents/skills/fonts/Serif.ttf",
        ".agents/skills/ultracite/SKILL.md",
        ".claude/skills/canvas",
        "skills-lock.json",
      ],
      skills: [
        { change: "added", name: "canvas", source: "publira/canvas" },
        { change: "updated", name: "ultracite", source: "publira/ultracite" },
      ],
      status: "planned",
    } satisfies UpdateAgentSkillsResult);
    expect(github.writes).toStrictEqual([]);
    expect(sandbox.commands.find(({ cmd }) => cmd === "npx")).toStrictEqual({
      args: ["-y", `skills@${SKILLS_VERSION}`, "update", "-p", "-y"],
      cmd: "npx",
      cwd: SANDBOX_WORKTREE,
      env: { CI: "true", NO_COLOR: "1" },
      timeoutMs: 120_000,
    });
  });

  it("commits the skill files with their modes and opens a pull request", async () => {
    const github = fakeGitHub();
    const sandbox = localSandbox({ origin: fixture.origin, root });

    const result = await updateAgentSkills({
      ...location,
      octokit: github.octokit,
      sandbox: sandbox.runner,
    });

    expect(result).toMatchObject({
      committed: true,
      pullRequest: {
        created: true,
        number: 4001,
        url: "https://github.com/publira/publira/pull/4001",
      },
      status: "pull-request",
    });
    expect(github.writes.map(({ route }) => route)).toStrictEqual([
      `POST ${repository}/git/trees`,
      `POST ${repository}/git/commits`,
      `POST ${repository}/git/refs`,
      `POST ${repository}/pulls`,
    ]);

    const body = (route: string) =>
      github.writes.find((entry) => entry.route === route)?.body;
    // Every file the update wrote is text, so all of them go inline.
    expect(body(`POST ${repository}/git/trees`)).toStrictEqual({
      base_tree: "base-tree",
      tree: [
        {
          content: "#!/bin/sh\n",
          mode: "100755",
          path: ".agents/skills/canvas/render.sh",
          type: "blob",
        },
        {
          mode: "100644",
          path: ".agents/skills/fonts/Serif.ttf",
          sha: null,
          type: "blob",
        },
        {
          content: "# Ultracite\n\nv2\n",
          mode: "100644",
          path: ".agents/skills/ultracite/SKILL.md",
          type: "blob",
        },
        {
          content: "../../.agents/skills/canvas",
          mode: "120000",
          path: ".claude/skills/canvas",
          type: "blob",
        },
        {
          content: lockFile({ canvas: "c1", ultracite: "u2" }),
          mode: "100644",
          path: "skills-lock.json",
          type: "blob",
        },
      ],
    });
    expect(body(`POST ${repository}/git/commits`)).toStrictEqual({
      message:
        "chore(skills): update agent skills\n\n- canvas (publira/canvas): added\n- ultracite (publira/ultracite): updated",
      parents: [fixture.baseSha],
      tree: "new-tree",
    });
    expect(body(`POST ${repository}/pulls`)).toMatchObject({
      base: "main",
      body: expect.stringContaining(
        "| `canvas` | `publira/canvas` | added |\n| `ultracite` | `publira/ultracite` | updated |"
      ),
      head: SKILLS_UPDATE_BRANCH,
      title: "chore(skills): update agent skills",
    });
  });

  it("uploads a binary file the update writes", async () => {
    const github = fakeGitHub();
    const sandbox = localSandbox({
      origin: fixture.origin,
      root,
      update: (worktree) => {
        write(worktree, ".agents/skills/fonts/Serif.ttf", Buffer.from([0xff]));
        return { exitCode: 0 };
      },
    });

    await updateAgentSkills({
      ...location,
      octokit: github.octokit,
      sandbox: sandbox.runner,
    });

    const body = (route: string) =>
      github.writes.find((entry) => entry.route === route)?.body;
    expect(body(`POST ${repository}/git/blobs`)).toStrictEqual({
      content: Buffer.from([0xff]).toString("base64"),
      encoding: "base64",
    });
    expect(body(`POST ${repository}/git/trees`)).toStrictEqual({
      base_tree: "base-tree",
      tree: [
        {
          mode: "100644",
          path: ".agents/skills/fonts/Serif.ttf",
          sha: "font-blob",
          type: "blob",
        },
      ],
    });
  });

  it("leaves an open pull request that holds the same skill files", async () => {
    const github = fakeGitHub({
      openPullRequestTree: updatedTree(root, fixture.origin),
    });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(
      updateAgentSkills({
        ...location,
        octokit: github.octokit,
        sandbox: sandbox.runner,
      })
    ).resolves.toMatchObject({
      committed: false,
      pullRequest: { created: false, number: 4000 },
      status: "pull-request",
    });
    // Only the pull request's body is restored.
    expect(github.writes.map(({ route }) => route)).toStrictEqual([
      `PATCH ${repository}/pulls/4000`,
    ]);
  });

  it("moves the branch when the skills changed again upstream", async () => {
    const tree = updatedTree(root, fixture.origin).map((entry) =>
      entry.path === "skills-lock.json"
        ? { ...entry, sha: "0".repeat(40) }
        : entry
    );
    const github = fakeGitHub({ openPullRequestTree: tree });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(
      updateAgentSkills({
        ...location,
        octokit: github.octokit,
        sandbox: sandbox.runner,
      })
    ).resolves.toMatchObject({ committed: true, status: "pull-request" });
    expect(github.writes.map(({ route }) => route)).toContain(
      `PATCH ${repository}/git/refs/heads/${SKILLS_UPDATE_BRANCH}`
    );
  });

  it("writes nothing when only paths outside the skills changed", async () => {
    const github = fakeGitHub();
    const sandbox = localSandbox({
      origin: fixture.origin,
      root,
      update: (worktree) => {
        write(worktree, "skills/canvas/SKILL.md", "# Canvas\n");
        return { exitCode: 0 };
      },
    });

    await expect(
      updateAgentSkills({
        ...location,
        octokit: github.octokit,
        sandbox: sandbox.runner,
      })
    ).resolves.toStrictEqual({
      baseSha: fixture.baseSha,
      ignoredPaths: ["skills/canvas/SKILL.md"],
      status: "unchanged",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves the repository alone when the clone fails", async () => {
    const github = fakeGitHub();
    const sandbox = localSandbox({
      cloneExitCode: 128,
      origin: fixture.origin,
      root,
    });

    await expect(
      updateAgentSkills({
        ...location,
        octokit: github.octokit,
        sandbox: sandbox.runner,
      })
    ).resolves.toStrictEqual({
      exitCode: 128,
      output: "fatal: repository not found",
      status: "failed",
      step: "clone",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves the repository alone when the update fails", async () => {
    const github = fakeGitHub();
    const sandbox = localSandbox({
      origin: fixture.origin,
      root,
      update: () => ({ exitCode: 1, stderr: "Failed to fetch skill" }),
    });

    await expect(
      updateAgentSkills({
        ...location,
        octokit: github.octokit,
        sandbox: sandbox.runner,
      })
    ).resolves.toStrictEqual({
      exitCode: 1,
      output: "Failed to fetch skill",
      status: "failed",
      step: "update",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("clones a private repository with a read token it does not store", async () => {
    const github = fakeGitHub({ private: true });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await updateAgentSkills({
      ...location,
      createReadToken: () => Promise.resolve("ghs_read"),
      dryRun: true,
      octokit: github.octokit,
      sandbox: sandbox.runner,
    });

    const header = `Authorization: Basic ${Buffer.from("x-access-token:ghs_read").toString("base64")}`;
    expect(sandbox.commands[0]?.args).toStrictEqual([
      "-c",
      `http.extraHeader=${header}`,
      "clone",
      "--depth=1",
      "--single-branch",
      "--branch=main",
      "https://github.com/publira/publira.git",
      SANDBOX_WORKTREE,
    ]);
    // The update, which runs after the clone, cannot read the token back.
    expect(
      readFileSync(path.join(sandbox.worktree, ".git/config"), "utf-8")
    ).not.toMatch(/ghs_read|extraheader|Authorization/iu);
  });

  it("clones a public repository anonymously", async () => {
    const github = fakeGitHub();
    const sandbox = localSandbox({ origin: fixture.origin, root });
    const createReadToken = vi.fn<() => Promise<string>>(() =>
      Promise.resolve("ghs_read")
    );

    await updateAgentSkills({
      ...location,
      createReadToken,
      dryRun: true,
      octokit: github.octokit,
      sandbox: sandbox.runner,
    });

    expect(createReadToken).not.toHaveBeenCalled();
    expect(sandbox.commands[0]?.args?.[0]).toBe("clone");
  });

  it("starts no sandbox when the read token cannot be created", async () => {
    const github = fakeGitHub({ private: true });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(
      updateAgentSkills({
        ...location,
        createReadToken: () => Promise.reject(new Error("Bad credentials")),
        octokit: github.octokit,
        sandbox: sandbox.runner,
      })
    ).rejects.toThrow("Bad credentials");
    expect(sandbox.started()).toBe(0);
  });
});

describe(updateAgentSkillsEverywhere, () => {
  const installationRepositories = [
    { archived: false, default_branch: "main", name: "publira" },
    { archived: true, default_branch: "main", name: "old-site" },
    { archived: false, default_branch: "main", name: "website" },
    { archived: false, default_branch: "main", name: "agents" },
  ].map((data) => ({ ...data, owner: { login: "publira" } }));

  const appFetch = vi.fn<typeof fetch>((input) => {
    const url = new URL(String(input));
    const response = Response.json(
      url.pathname === "/app/installations"
        ? [{ id: 7, suspended_at: null }]
        : {
            repositories: installationRepositories,
            total_count: installationRepositories.length,
          }
    );
    // The pagination plugin reads the URL of a fetched response.
    Object.defineProperty(response, "url", { value: url.href });
    return Promise.resolve(response);
  });
  const octokit = createGitHubClient({ fetch: appFetch });
  const app: GitHubApp = {
    getBotLogin: () => Promise.reject(new Error("unused")),
    getInstallationOctokit: () => Promise.resolve(octokit),
    getRepositoryOctokit: () => Promise.reject(new Error("unused")),
    octokit,
  };

  it("runs on each unarchived repository and logs each outcome", async () => {
    const log = vi.fn<Log>();
    const job = vi.fn<typeof updateAgentSkills>(({ repo }) => {
      if (repo === "website") {
        return Promise.resolve({ status: "no-lock-file" });
      }
      if (repo === "agents") {
        return Promise.reject(new Error("GitHub is down"));
      }
      return Promise.resolve({
        exitCode: 1,
        output: "Failed to fetch skill",
        status: "failed",
        step: "update",
      });
    });

    await updateAgentSkillsEverywhere({
      app,
      dryRun: true,
      job,
      log,
      sandbox: (task) =>
        task({ run: () => Promise.reject(new Error("unused")) }),
    });

    expect(
      job.mock.calls.map(([{ repo, dryRun }]) => ({ dryRun, repo }))
    ).toStrictEqual([
      { dryRun: true, repo: "publira" },
      { dryRun: true, repo: "website" },
      { dryRun: true, repo: "agents" },
    ]);
    const common = {
      dryRun: true,
      installation: 7,
      job: "update-agent-skills",
      modelInvoked: false,
      owner: "publira",
    };
    expect(log.mock.calls).toStrictEqual(
      expect.arrayContaining([
        [
          "warn",
          "Agent skills update failed in the sandbox; the repository is left as it is",
          expect.objectContaining({
            ...common,
            exitCode: 1,
            output: "Failed to fetch skill",
            repo: "publira",
            status: "failed",
            step: "update",
          }),
        ],
        [
          "info",
          "Agent skills checked",
          expect.objectContaining({
            ...common,
            repo: "website",
            status: "no-lock-file",
          }),
        ],
        [
          "error",
          "Agent skills update failed",
          expect.objectContaining({
            ...common,
            error: "GitHub is down",
            repo: "agents",
          }),
        ],
      ])
    );
    expect(log).toHaveBeenCalledTimes(3);
  });
});
