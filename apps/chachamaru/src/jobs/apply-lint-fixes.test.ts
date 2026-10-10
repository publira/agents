import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createGitHubClient } from "@publira/github";
import { LINT_FIX_COMMIT_SUBJECT } from "@publira/maintenance-policies";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Sandbox,
  SandboxCommand,
  SandboxRunner,
} from "../sandbox-runner.ts";
import { applyLintFixes, summarizeLintFixResult } from "./apply-lint-fixes.ts";
import type { ApplyLintFixesResult } from "./apply-lint-fixes.ts";

const BOT = "chachamaru-bot[bot]";
const BRANCH = "renovate/oxc";
const repository = "/repos/publira/comic-viewer";

// Where the job checks the pull request out in its sandbox.
const SANDBOX_WORKTREE = "/tmp/repository";

const manifest = (packageManager: string) =>
  `${JSON.stringify(
    {
      devDependencies: { ultracite: "7.12.4" },
      name: "comic-viewer",
      packageManager,
      private: true,
    },
    null,
    2
  )}\n`;

// Stands in for ultracite. `check` fails on a Markdown or JSON file Git
// tracks that has trailing whitespace, which `fix` removes, and on a
// `debugger` statement, which `fix` leaves; then `fix` exits with 1, as
// ultracite does when findings remain. Both write a cache Git does not
// track.
const ULTRACITE = `#!/bin/sh
echo cache > .lint-cache
files=$(git ls-files '*.md' '*.json')
case "$1" in
  check)
    status=0
    for file in $files; do
      if grep -q ' $' "$file"; then echo "$file: trailing whitespace"; status=1; fi
    done
    if git grep -q debugger; then echo "debugger statement"; status=1; fi
    exit $status;;
  fix)
    [ -n "\${FIX_EXIT_CODE:-}" ] && exit "$FIX_EXIT_CODE"
    for file in $files; do sed -i 's/ *$//' "$file"; done
    if git grep -q debugger; then exit 1; fi
    exit 0;;
esac
exit 2
`;

// Stand in for pnpm and npm: record the call, install into node_modules,
// and run a binary. pnpm's install can also rewrite a file, as a lifecycle
// script could.
const PNPM = `#!/bin/sh
echo "pnpm $*" >> "$HOME/calls"
case "$1" in
  install)
    mkdir -p node_modules
    [ -n "\${INSTALL_WRITES:-}" ] && echo "// installed" >> "$INSTALL_WRITES"
    exit "\${INSTALL_EXIT_CODE:-0}";;
  exec) shift; exec "$@";;
esac
exit 2
`;

const NPM = `#!/bin/sh
echo "npm $*" >> "$HOME/calls"
case "$1" in
  ci) mkdir -p node_modules; exit "\${INSTALL_EXIT_CODE:-0}";;
  exec) shift 3; exec "$@";;
esac
exit 2
`;

const runGit = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const write = (root: string, file: string, content: string) => {
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

interface Fixture {
  /** The origin the sandbox fetches, standing in for GitHub. */
  origin: string;
  /** Renovate's commit, after which the updated formatter fails the check. */
  headSha: string;
  /** The root `package.json` at the head. */
  manifest: string;
}

/**
 * A repository whose README the updated formatter now rejects, and a
 * script that `fix` leaves as it is.
 */
const createFixture = (root: string): Fixture => {
  const origin = path.join(root, "origin");
  mkdirSync(origin);
  runGit(origin, "init", "--quiet", "--initial-branch=main");
  write(origin, ".gitignore", "node_modules/\n");
  write(origin, "package.json", manifest("pnpm@12.10.1"));
  write(origin, "README.md", "# Comic Viewer \n\nReads comics. \n");
  write(origin, "docs/usage.md", "Open a comic.\n");
  write(origin, "src/index.ts", "export const read = () => 1;\n");
  const headSha = commitAll(origin, "chore(deps): update oxc monorepo");
  return { headSha, manifest: manifest("pnpm@12.10.1"), origin };
};

const commitToFixture = (
  fixture: Fixture,
  files: Readonly<Record<string, string>>
) => {
  for (const [file, content] of Object.entries(files)) {
    write(fixture.origin, file, content);
  }
  fixture.headSha = commitAll(fixture.origin, "chore(deps): update oxc");
  fixture.manifest = readFileSync(
    path.join(fixture.origin, "package.json"),
    "utf-8"
  );
};

interface LocalSandboxOptions {
  root: string;
  origin: string;
  fetchExitCode?: number;
  /** Passed to every command, such as an exit code for a stand-in. */
  env?: Readonly<Record<string, string>>;
}

/**
 * A sandbox that runs the job's commands on this machine, in a directory of
 * its own, with a home of its own and the stand-ins for the package managers
 * and ultracite first on its PATH: the fetch reads the local origin.
 */
const localSandbox = ({
  root,
  origin,
  fetchExitCode = 0,
  env = {},
}: LocalSandboxOptions) => {
  const worktree = path.join(root, "sandbox", "repository");
  const home = path.join(root, "sandbox", "home");
  const bin = path.join(root, "sandbox", "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const [name, script] of Object.entries({
    npm: NPM,
    pnpm: PNPM,
    ultracite: ULTRACITE,
  })) {
    writeFileSync(path.join(bin, name), script);
    chmodSync(path.join(bin, name), 0o755);
  }
  const commands: SandboxCommand[] = [];
  const localize = (value: string) =>
    value.replaceAll(SANDBOX_WORKTREE, worktree);

  const sandbox: Sandbox = {
    run(command) {
      commands.push(command);
      const args = (command.args ?? []).map(localize);

      if (
        command.cmd === "git" &&
        args.includes("fetch") &&
        fetchExitCode !== 0
      ) {
        return Promise.resolve({
          exitCode: fetchExitCode,
          stderr: "fatal: repository not found",
          stdout: "",
        });
      }
      const result = spawnSync(
        command.cmd,
        args.map((arg) =>
          arg.startsWith("https://github.com/") ? `file://${origin}` : arg
        ),
        {
          cwd: command.cwd === undefined ? undefined : localize(command.cwd),
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: home,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            ...env,
            ...command.env,
          },
          maxBuffer: 64 * 1024 * 1024,
        }
      );
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

  return {
    /** The package manager calls, in order. */
    calls: () =>
      readFileSync(path.join(home, "calls"), "utf-8").trim().split("\n"),
    commands,
    runner,
    started: () => started,
    worktree,
  };
};

interface GitHubOptions {
  fixture: Fixture;
  private?: boolean;
  user?: { login: string; type: string };
  /** The root `package.json` at the head; `null` for none. */
  manifest?: string | null;
  checkRuns?: readonly { name: string; status: string; conclusion: string }[];
  /** The head commit's author and message. */
  headCommit?: { author: string; message: string };
  /** Whether the branch moved, so a fast-forward fails. */
  moved?: boolean;
}

const file = (content: string) =>
  Response.json({
    content: Buffer.from(content).toString("base64"),
    encoding: "base64",
    type: "file",
  });

const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });

const FAILED_LINT = [
  { conclusion: "failure", name: "Lint", status: "completed" },
];

// Answers the GitHub API and records the writes.
const fakeGitHub = ({
  fixture,
  private: isPrivate = false,
  user = { login: "renovate[bot]", type: "Bot" },
  manifest: rootManifest = fixture.manifest,
  checkRuns = FAILED_LINT,
  headCommit = {
    author: "renovate[bot]",
    message: "chore(deps): update oxc monorepo",
  },
  moved = false,
}: GitHubOptions) => {
  const writes: { route: string; body: unknown }[] = [];
  const reads: string[] = [];

  const respond = (...[input, init]: Parameters<typeof fetch>) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${decodeURIComponent(url.pathname)}`;
    const ref = url.searchParams.get("ref");

    if (method === "GET") {
      reads.push(route);
    } else {
      writes.push({ body: JSON.parse(String(init?.body)), route });
    }

    switch (route) {
      case `GET ${repository}/pulls/31`: {
        return Promise.resolve(
          Response.json({
            base: {
              ref: "main",
              repo: { full_name: "publira/comic-viewer", private: isPrivate },
              sha: "base",
            },
            head: {
              ref: BRANCH,
              repo: { full_name: "publira/comic-viewer" },
              sha: fixture.headSha,
            },
            number: 31,
            state: "open",
            user,
          })
        );
      }
      case `GET ${repository}/contents/package.json`: {
        return Promise.resolve(
          rootManifest === null || ref !== fixture.headSha
            ? notFound()
            : file(rootManifest)
        );
      }
      case `GET ${repository}/commits/${fixture.headSha}/check-runs`: {
        return Promise.resolve(
          Response.json({
            check_runs: checkRuns.map((run) => ({ ...run, app: { id: 1 } })),
            total_count: checkRuns.length,
          })
        );
      }
      case `GET ${repository}/commits/${fixture.headSha}/statuses`: {
        return Promise.resolve(Response.json([]));
      }
      case `GET ${repository}/commits/${fixture.headSha}`: {
        return Promise.resolve(
          Response.json({
            author: { login: headCommit.author },
            commit: { message: headCommit.message },
            sha: fixture.headSha,
          })
        );
      }
      case `GET ${repository}/git/commits/${fixture.headSha}`: {
        return Promise.resolve(Response.json({ tree: { sha: "head-tree" } }));
      }
      case `POST ${repository}/git/trees`: {
        return Promise.resolve(Response.json({ sha: "new-tree" }));
      }
      case `POST ${repository}/git/commits`: {
        return Promise.resolve(Response.json({ sha: "new-commit" }));
      }
      case `PATCH ${repository}/git/refs/heads/${BRANCH}`: {
        return Promise.resolve(
          moved
            ? Response.json(
                { message: "Update is not a fast forward" },
                { status: 422 }
              )
            : Response.json({})
        );
      }
      default: {
        return Promise.resolve(notFound());
      }
    }
  };

  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const response = await respond(input, init);
    // The pagination reads the URL a page came from.
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  });

  return {
    octokit: createGitHubClient({ fetch: fetchImpl }),
    reads,
    writes,
  };
};

const location = {
  botLogin: BOT,
  // A public repository is fetched without a token.
  createReadToken: () => Promise.reject(new Error("No token for a public one")),
  owner: "publira",
  pullNumber: 31,
  repo: "comic-viewer",
};

const run = (
  github: ReturnType<typeof fakeGitHub>,
  sandbox: ReturnType<typeof localSandbox>,
  options: { dryRun?: boolean; createReadToken?: () => Promise<string> } = {}
) =>
  applyLintFixes({
    ...location,
    ...options,
    octokit: github.octokit,
    sandbox: sandbox.runner,
  });

describe(applyLintFixes, () => {
  let root: string;
  let fixture: Fixture;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "apply-lint-fixes-"));
    fixture = createFixture(root);
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("plans the commit in a dry run", async () => {
    const github = fakeGitHub({ fixture });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox, { dryRun: true })).resolves.toStrictEqual(
      {
        checkPassed: true,
        headSha: fixture.headSha,
        output: undefined,
        paths: ["README.md"],
        status: "would-commit",
      } satisfies ApplyLintFixesResult
    );
    expect(github.writes).toStrictEqual([]);
    expect(sandbox.calls()).toStrictEqual([
      "pnpm install --frozen-lockfile",
      "pnpm exec ultracite check",
      "pnpm exec ultracite fix",
      "pnpm exec ultracite check",
    ]);
  });

  it("commits the fixed files on top of the head", async () => {
    const github = fakeGitHub({ fixture });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox)).resolves.toStrictEqual({
      checkPassed: true,
      commitSha: "new-commit",
      headSha: fixture.headSha,
      output: undefined,
      paths: ["README.md"],
      status: "committed",
    } satisfies ApplyLintFixesResult);

    expect(github.writes).toStrictEqual([
      {
        body: {
          base_tree: "head-tree",
          tree: [
            {
              content: "# Comic Viewer\n\nReads comics.\n",
              mode: "100644",
              path: "README.md",
              type: "blob",
            },
          ],
        },
        route: `POST ${repository}/git/trees`,
      },
      {
        body: {
          message: `${LINT_FIX_COMMIT_SUBJECT}\n\nRan \`ultracite fix\` with pnpm on ${fixture.headSha}.`,
          parents: [fixture.headSha],
          tree: "new-tree",
        },
        route: `POST ${repository}/git/commits`,
      },
      {
        body: { force: false, sha: "new-commit" },
        route: `PATCH ${repository}/git/refs/heads/${BRANCH}`,
      },
    ]);
  });

  it("installs and runs ultracite with npm when the repository names it", async () => {
    commitToFixture(fixture, { "package.json": manifest("npm@12.2.0") });
    const github = fakeGitHub({ fixture });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox, { dryRun: true })).resolves.toMatchObject(
      { paths: ["README.md"], status: "would-commit" }
    );
    expect(sandbox.calls()).toStrictEqual([
      "npm ci",
      "npm exec --no -- ultracite check",
      "npm exec --no -- ultracite fix",
      "npm exec --no -- ultracite check",
    ]);
  });

  it("commits what it fixed when findings remain, with the check's output", async () => {
    commitToFixture(fixture, {
      "src/index.ts": "export const read = () => {\n  debugger;\n};\n",
    });
    const github = fakeGitHub({ fixture });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox, { dryRun: true })).resolves.toStrictEqual(
      {
        checkPassed: false,
        headSha: fixture.headSha,
        output: "debugger statement\n",
        paths: ["README.md"],
        status: "would-commit",
      } satisfies ApplyLintFixesResult
    );
  });

  it("hands over a head whose findings the fix leaves", async () => {
    commitToFixture(fixture, {
      "README.md": "# Comic Viewer\n",
      "src/index.ts": "export const read = () => {\n  debugger;\n};\n",
    });
    const github = fakeGitHub({ fixture });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox)).resolves.toStrictEqual({
      headSha: fixture.headSha,
      output: "debugger statement\n",
      reason: "the automatic fix changed nothing",
      status: "unfixed",
    } satisfies ApplyLintFixesResult);
    expect(github.writes).toStrictEqual([]);
  });

  it("hands over a head that is its own fix without starting a sandbox", async () => {
    const github = fakeGitHub({
      fixture,
      headCommit: {
        author: BOT,
        message: `${LINT_FIX_COMMIT_SUBJECT}\n\nRan.`,
      },
    });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox)).resolves.toStrictEqual({
      headSha: fixture.headSha,
      output: undefined,
      reason: "a check failed on the bot's own fix",
      status: "unfixed",
    } satisfies ApplyLintFixesResult);
    expect(sandbox.started()).toBe(0);
  });

  it("writes nothing when the lint check passes", async () => {
    commitToFixture(fixture, { "README.md": "# Comic Viewer\n" });
    const github = fakeGitHub({ fixture });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox)).resolves.toStrictEqual({
      headSha: fixture.headSha,
      status: "lint-passed",
    });
    expect(sandbox.calls()).toStrictEqual([
      "pnpm install --frozen-lockfile",
      "pnpm exec ultracite check",
    ]);
    expect(github.writes).toStrictEqual([]);
  });

  it("refuses a fix that changes the package.json", async () => {
    commitToFixture(fixture, {
      "package.json": fixture.manifest.replace("{\n", "{ \n"),
    });
    const github = fakeGitHub({ fixture });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox)).resolves.toStrictEqual({
      headSha: fixture.headSha,
      paths: ["README.md", "package.json"],
      reason: "the fix changed files it has no reason to change",
      refusedPaths: ["package.json"],
      status: "refused",
    } satisfies ApplyLintFixesResult);
    expect(github.writes).toStrictEqual([]);
  });

  it("refuses to commit when the install changed files Git tracks", async () => {
    const github = fakeGitHub({ fixture });
    const sandbox = localSandbox({
      env: { INSTALL_WRITES: "src/index.ts" },
      origin: fixture.origin,
      root,
    });

    await expect(run(github, sandbox)).resolves.toStrictEqual({
      headSha: fixture.headSha,
      paths: ["src/index.ts"],
      reason:
        "the install or the check changed files Git tracks before the fix ran",
      refusedPaths: ["src/index.ts"],
      status: "refused",
    } satisfies ApplyLintFixesResult);
    // The fix did not run.
    expect(sandbox.calls()).toStrictEqual([
      "pnpm install --frozen-lockfile",
      "pnpm exec ultracite check",
    ]);
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves a branch that moved to its push", async () => {
    const github = fakeGitHub({ fixture, moved: true });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox)).resolves.toMatchObject({
      paths: ["README.md"],
      status: "head-moved",
    });
  });

  it.each([
    [
      "Renovate did not open the pull request",
      { user: { login: "ykzts", type: "User" } },
    ],
    ["the head has no package.json at its root", { manifest: null }],
    [
      "the root package.json does not depend on ultracite",
      { manifest: '{ "packageManager": "pnpm@12.10.1" }' },
    ],
    [
      "packageManager names yarn@4.9.0, neither pnpm nor npm",
      { manifest: manifest("yarn@4.9.0") },
    ],
    [
      "no check on the head failed",
      {
        checkRuns: [
          { conclusion: "success", name: "Lint", status: "completed" },
        ],
      },
    ],
    [
      "the checks on the head are still running",
      {
        checkRuns: [{ conclusion: "", name: "Lint", status: "in_progress" }],
      },
    ],
  ])("skips when %s", async (reason, options) => {
    const github = fakeGitHub({ fixture, ...options });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox)).resolves.toStrictEqual({
      headSha: fixture.headSha,
      reason,
      status: "skipped",
    });
    expect(sandbox.started()).toBe(0);
  });

  it("starts on any failed check, whatever its name", async () => {
    const github = fakeGitHub({
      checkRuns: [
        { conclusion: "success", name: "Lint", status: "completed" },
        { conclusion: "failure", name: "Check", status: "completed" },
        { conclusion: "", name: "Test", status: "in_progress" },
      ],
      fixture,
    });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await expect(run(github, sandbox, { dryRun: true })).resolves.toMatchObject(
      { status: "would-commit" }
    );
  });

  it.each([
    ["install", { INSTALL_EXIT_CODE: "1" }, 1],
    ["fix", { FIX_EXIT_CODE: "137" }, 137],
  ])(
    "leaves the pull request alone when the %s fails",
    async (step, env, exitCode) => {
      const github = fakeGitHub({ fixture });
      const sandbox = localSandbox({ env, origin: fixture.origin, root });

      await expect(run(github, sandbox)).resolves.toMatchObject({
        exitCode,
        headSha: fixture.headSha,
        status: "failed",
        step,
      });
      expect(github.writes).toStrictEqual([]);
    }
  );

  it("leaves the pull request alone when the fetch fails", async () => {
    const github = fakeGitHub({ fixture });
    const sandbox = localSandbox({
      fetchExitCode: 128,
      origin: fixture.origin,
      root,
    });

    await expect(run(github, sandbox)).resolves.toMatchObject({
      exitCode: 128,
      output: "fatal: repository not found",
      status: "failed",
      step: "fetch",
    });
  });

  it("fetches a private repository with a read token it does not store", async () => {
    const github = fakeGitHub({ fixture, private: true });
    const sandbox = localSandbox({ origin: fixture.origin, root });

    await run(github, sandbox, {
      createReadToken: () => Promise.resolve("read-token"),
      dryRun: true,
    });

    const fetch = sandbox.commands.find(({ args }) => args?.includes("fetch"));
    expect(fetch?.args?.slice(0, 2)).toStrictEqual([
      "-c",
      `http.extraHeader=Authorization: Basic ${Buffer.from("x-access-token:read-token").toString("base64")}`,
    ]);
    expect(
      readFileSync(path.join(sandbox.worktree, ".git/config"), "utf-8")
    ).not.toContain("extraHeader");
    // Nothing but the fetch saw the token.
    expect(
      sandbox.commands.filter((command) =>
        JSON.stringify(command).includes(
          Buffer.from("x-access-token:read-token").toString("base64")
        )
      )
    ).toStrictEqual([fetch]);
  });
});

describe(summarizeLintFixResult, () => {
  it("logs a refusal without the file contents", () => {
    expect(
      summarizeLintFixResult({
        headSha: "head",
        paths: ["README.md", "pnpm-lock.yaml"],
        reason: "the fix changed files it has no reason to change",
        refusedPaths: ["pnpm-lock.yaml"],
        status: "refused",
      })
    ).toStrictEqual({
      checkPassed: undefined,
      commit: undefined,
      exitCode: undefined,
      headSha: "head",
      modelInvoked: false,
      output: undefined,
      paths: ["README.md", "pnpm-lock.yaml"],
      reason: "the fix changed files it has no reason to change",
      refusedPaths: ["pnpm-lock.yaml"],
      status: "refused",
      step: undefined,
    });
  });
});
