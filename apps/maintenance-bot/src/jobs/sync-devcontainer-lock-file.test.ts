import { createHash } from "node:crypto";

import { createGitHubClient } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import {
  summarizeLockFileSyncResult,
  syncDevContainerLockFile,
} from "./sync-devcontainer-lock-file.ts";

const DIND = "ghcr.io/devcontainers/features/docker-in-docker";
const GH_CLI = "ghcr.io/devcontainers/features/github-cli";
const OLD_DIGEST =
  "sha256:ad3d6d36d95ee7f880f61f98862257f3e70253d3faef09f86af42fb87ee60429";
const GH_CLI_DIGEST =
  "sha256:bd7ab48a832228f633239277552c30b353867fef2e5b037e064b4e64f0b843f2";
const CONFIG = ".devcontainer/devcontainer.json";
const LOCK_FILE = ".devcontainer/devcontainer-lock.json";

const config = (...features: readonly string[]) => `{
  "features": {
${features.map((feature) => `    "${feature}": {},`).join("\n")}
    // A comment, as devcontainer.json allows.
  },
  "image": "mcr.microsoft.com/devcontainers/base:debian"
}
`;

const entry = (reference: string, version: string, digest: string) => {
  const name = reference.slice(0, reference.lastIndexOf(":"));
  return `    "${reference}": {
      "version": "${version}",
      "resolved": "${name}@${digest}",
      "integrity": "${digest}"
    }`;
};

const lockFile = (...entries: readonly string[]) =>
  `{\n  "features": {\n${entries.join(",\n")}\n  }\n}\n`;

const manifest = JSON.stringify({
  annotations: {
    "dev.containers.metadata": JSON.stringify({
      id: "docker-in-docker",
      version: "4.1.3",
    }),
  },
  schemaVersion: 2,
});
const NEW_DIGEST = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;

const staleLockFile = lockFile(
  entry(`${DIND}:4.1.2`, "4.1.2", OLD_DIGEST),
  entry(`${GH_CLI}:1.1.3`, "1.1.3", GH_CLI_DIGEST)
);
const syncedLockFile = lockFile(
  entry(`${DIND}:4.1.3`, "4.1.3", NEW_DIGEST),
  entry(`${GH_CLI}:1.1.3`, "1.1.3", GH_CLI_DIGEST)
);

type Json =
  | boolean
  | number
  | string
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

interface Scenario {
  pullRequest?: Readonly<Record<string, Json>>;
  changed?: readonly string[];
  /** The files at the merge base and the head, by path. */
  base?: Readonly<Record<string, string>>;
  head?: Readonly<Record<string, string>>;
  /** Whether the branch moved, so a fast-forward fails. */
  moved?: boolean;
}

const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });

const CONTENTS_ROUTE = /^GET \/repos\/publira\/agents\/contents\/(?<path>.+)$/u;

// Answers the GitHub API for publira/agents#40, a Renovate pull request that
// bumps docker-in-docker from 4.1.2 to 4.1.3.
const fakeGitHub = ({
  pullRequest = {},
  changed = [CONFIG],
  base = { [CONFIG]: config(`${DIND}:4.1.2`, `${GH_CLI}:1.1.3`) },
  head = {
    [CONFIG]: config(`${DIND}:4.1.3`, `${GH_CLI}:1.1.3`),
    [LOCK_FILE]: staleLockFile,
  },
  moved = false,
}: Scenario = {}) => {
  const writes: { route: string; body: Json | undefined }[] = [];
  const routes = new Map(
    Object.entries({
      "GET /repos/publira/agents/compare/base...head": {
        files: changed.map((filename) => ({ filename })),
        merge_base_commit: { sha: "merge-base" },
      },
      "GET /repos/publira/agents/git/commits/head": {
        tree: { sha: "head-tree" },
      },
      "GET /repos/publira/agents/pulls/40": {
        base: { repo: { full_name: "publira/agents" }, sha: "base" },
        head: {
          ref: "renovate/docker-in-docker-4.x",
          repo: { full_name: "publira/agents" },
          sha: "head",
        },
        number: 40,
        state: "open",
        user: { login: "renovate[bot]", type: "Bot" },
        ...pullRequest,
      },
      "PATCH /repos/publira/agents/git/refs/heads/renovate/docker-in-docker-4.x":
        moved
          ? Response.json(
              { message: "Update is not a fast forward" },
              { status: 422 }
            )
          : {},
      "POST /repos/publira/agents/git/commits": { sha: "lock-commit" },
      "POST /repos/publira/agents/git/trees": { sha: "new-tree" },
    } satisfies Readonly<Record<string, Json | Response>>)
  );

  // A file at the merge base or the head, as the contents API answers it.
  const respondWithFile = (url: URL, path: string) => {
    const files = url.searchParams.get("ref") === "merge-base" ? base : head;
    const file = files[path];
    return file === undefined
      ? notFound()
      : Response.json({
          content: Buffer.from(file).toString("base64"),
          encoding: "base64",
          type: "file",
        });
  };

  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${decodeURIComponent(url.pathname)}`;

    if (method !== "GET") {
      writes.push({
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        route,
      });
    }

    const path = CONTENTS_ROUTE.exec(route)?.groups?.path;
    const result = routes.get(route);
    let response: Response;
    if (path !== undefined) {
      response = respondWithFile(url, path);
    } else if (result === undefined) {
      response = notFound();
    } else {
      response = result instanceof Response ? result : Response.json(result);
    }
    Object.defineProperty(response, "url", { value: url.href });
    return Promise.resolve(response);
  });

  return { octokit: createGitHubClient({ fetch: fetchImpl }), writes };
};

// ghcr.io, without the token exchange, which the registry client's own tests
// cover.
const registry = (failure?: number) => ({
  fetch: vi.fn<typeof fetch>((input) =>
    Promise.resolve(
      failure === undefined &&
        String(input) ===
          `https://ghcr.io/v2/devcontainers/features/docker-in-docker/manifests/4.1.3`
        ? new Response(manifest, {
            headers: { "docker-content-digest": NEW_DIGEST },
          })
        : new Response("", { status: failure ?? 404 })
    )
  ),
  retries: 0,
});

const run = (
  github: ReturnType<typeof fakeGitHub>,
  options: Partial<Parameters<typeof syncDevContainerLockFile>[0]> = {}
) =>
  syncDevContainerLockFile({
    octokit: github.octokit,
    owner: "publira",
    pullNumber: 40,
    registry: registry(),
    repo: "agents",
    ...options,
  });

describe(syncDevContainerLockFile, () => {
  it("commits the lock file with the bumped Feature's entry replaced", async () => {
    const github = fakeGitHub();

    await expect(run(github)).resolves.toStrictEqual({
      commitSha: "lock-commit",
      headSha: "head",
      lockFiles: [LOCK_FILE],
      message:
        "chore(devcontainer): sync the lock file with docker-in-docker 4.1.3",
      status: "committed",
    });
    expect(github.writes).toStrictEqual([
      {
        body: {
          base_tree: "head-tree",
          tree: [
            {
              content: syncedLockFile,
              mode: "100644",
              path: LOCK_FILE,
              type: "blob",
            },
          ],
        },
        route: "POST /repos/publira/agents/git/trees",
      },
      {
        body: {
          message:
            "chore(devcontainer): sync the lock file with docker-in-docker 4.1.3",
          parents: ["head"],
          tree: "new-tree",
        },
        route: "POST /repos/publira/agents/git/commits",
      },
      {
        body: { force: false, sha: "lock-commit" },
        route:
          "PATCH /repos/publira/agents/git/refs/heads/renovate/docker-in-docker-4.x",
      },
    ]);
  });

  it("only tells what it would commit in a dry run", async () => {
    const github = fakeGitHub();

    await expect(run(github, { dryRun: true })).resolves.toStrictEqual({
      files: { [LOCK_FILE]: syncedLockFile },
      headSha: "head",
      lockFiles: [LOCK_FILE],
      message:
        "chore(devcontainer): sync the lock file with docker-in-docker 4.1.3",
      status: "would-commit",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("adds nothing when the lock file is in step", async () => {
    const github = fakeGitHub({
      changed: [CONFIG, LOCK_FILE],
      head: {
        [CONFIG]: config(`${DIND}:4.1.3`, `${GH_CLI}:1.1.3`),
        [LOCK_FILE]: syncedLockFile,
      },
    });

    await expect(run(github)).resolves.toStrictEqual({
      headSha: "head",
      lockFiles: [LOCK_FILE],
      status: "in-sync",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves a branch that moved meanwhile", async () => {
    await expect(run(fakeGitHub({ moved: true }))).resolves.toStrictEqual({
      headSha: "head",
      lockFiles: [LOCK_FILE],
      status: "head-moved",
    });
  });

  it("leaves a pull request that adds a Feature", async () => {
    const github = fakeGitHub({
      head: {
        [CONFIG]: config(
          `${DIND}:4.1.2`,
          `${GH_CLI}:1.1.3`,
          `${DIND.replace("docker-in-docker", "node")}:1`
        ),
        [LOCK_FILE]: staleLockFile,
      },
    });

    await expect(run(github)).resolves.toStrictEqual({
      headSha: "head",
      reason: `${CONFIG}: the pull request added ghcr.io/devcontainers/features/node`,
      status: "skipped",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves the pull request when the registry cannot be read", async () => {
    const github = fakeGitHub();

    await expect(
      run(github, { registry: registry(503) })
    ).resolves.toStrictEqual({
      headSha: "head",
      reason:
        "the registry could not be read: ghcr.io answered 503 for ghcr.io/devcontainers/features/docker-in-docker:4.1.3",
      status: "skipped",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves a configuration without a lock file", async () => {
    const github = fakeGitHub({
      head: { [CONFIG]: config(`${DIND}:4.1.3`, `${GH_CLI}:1.1.3`) },
    });

    await expect(run(github)).resolves.toMatchObject({
      reason:
        "the pull request bumps no Feature of a configuration with a lock file",
      status: "skipped",
    });
  });

  it("leaves a pull request that changes no Dev Container configuration", async () => {
    await expect(
      run(fakeGitHub({ changed: ["package.json"] }))
    ).resolves.toMatchObject({
      reason: "the pull request changes no Dev Container configuration",
      status: "skipped",
    });
  });

  it("leaves a pull request someone else opened", async () => {
    await expect(
      run(
        fakeGitHub({ pullRequest: { user: { login: "ykzts", type: "User" } } })
      )
    ).resolves.toMatchObject({
      reason: "Renovate did not open the pull request",
      status: "skipped",
    });
  });
});

describe(summarizeLockFileSyncResult, () => {
  it("logs the commit without the files' contents", () => {
    expect(
      summarizeLockFileSyncResult({
        files: { [LOCK_FILE]: syncedLockFile },
        headSha: "head",
        lockFiles: [LOCK_FILE],
        message: "chore(devcontainer): sync the lock file",
        status: "would-commit",
      })
    ).toStrictEqual({
      commit: undefined,
      headSha: "head",
      lockFiles: [LOCK_FILE],
      modelInvoked: false,
      reason: undefined,
      status: "would-commit",
    });
  });
});
