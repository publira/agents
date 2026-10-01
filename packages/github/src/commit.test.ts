import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.ts";
import { commitToBranch } from "./commit.ts";
import { fakeGitHub } from "./fake-github.ts";

const repository = "/repos/publira/agents";

const options = {
  baseSha: "base",
  branch: "maintenance-bot/cleanup",
  files: { "obsolete.txt": null, "pnpm-workspace.yaml": "packages: []\n" },
  message: "chore: clean up",
  owner: "publira",
  repo: "agents",
};

// The base commit has tree `base-tree`; the change makes tree `new-tree`.
const gitRoutes = (branchCommit?: { tree: string; parents: string[] }) => ({
  [`GET ${repository}/git/commits/base`]: { tree: { sha: "base-tree" } },
  [`GET ${repository}/git/commits/branch-head`]: {
    parents: branchCommit?.parents.map((sha) => ({ sha })),
    tree: { sha: branchCommit?.tree },
  },
  [`GET ${repository}/git/ref/heads/maintenance-bot/cleanup`]:
    branchCommit === undefined
      ? Response.json({ message: "Not Found" }, { status: 404 })
      : { object: { sha: "branch-head" } },
  [`PATCH ${repository}/git/refs/heads/maintenance-bot/cleanup`]: {},
  [`POST ${repository}/git/commits`]: { sha: "new-commit" },
  [`POST ${repository}/git/refs`]: {},
  [`POST ${repository}/git/trees`]: { sha: "new-tree" },
});

describe(commitToBranch, () => {
  it("commits the change on a new branch", async () => {
    const github = fakeGitHub(gitRoutes());

    await expect(
      commitToBranch(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, sha: "new-commit" });

    const body = (route: string) =>
      github.requests[github.routes.indexOf(route)]?.body;
    expect(body(`POST ${repository}/git/trees`)).toStrictEqual({
      base_tree: "base-tree",
      tree: [
        { mode: "100644", path: "obsolete.txt", sha: null, type: "blob" },
        {
          content: "packages: []\n",
          mode: "100644",
          path: "pnpm-workspace.yaml",
          type: "blob",
        },
      ],
    });
    expect(body(`POST ${repository}/git/commits`)).toStrictEqual({
      message: "chore: clean up",
      parents: ["base"],
      tree: "new-tree",
    });
    expect(body(`POST ${repository}/git/refs`)).toStrictEqual({
      ref: "refs/heads/maintenance-bot/cleanup",
      sha: "new-commit",
    });
  });

  it("leaves a branch that already holds the change", async () => {
    const github = fakeGitHub(
      gitRoutes({ parents: ["base"], tree: "new-tree" })
    );

    await expect(
      commitToBranch(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: false, sha: "branch-head" });
    expect(github.routes).not.toContain(`POST ${repository}/git/commits`);
    expect(
      github.requests.filter(({ method }) => method === "PATCH")
    ).toHaveLength(0);
  });

  it.each([
    ["another change", { parents: ["base"], tree: "other-tree" }],
    ["an older base", { parents: ["old-base"], tree: "new-tree" }],
    ["extra commits", { parents: ["base", "other"], tree: "new-tree" }],
  ])("replaces a branch with %s", async (_label, branchCommit) => {
    const github = fakeGitHub(gitRoutes(branchCommit));

    await expect(
      commitToBranch(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, sha: "new-commit" });
    expect(
      github.requests.find(({ method }) => method === "PATCH")?.body
    ).toStrictEqual({ force: true, sha: "new-commit" });
  });

  it("moves the branch when a concurrent run created it first", async () => {
    const github = fakeGitHub({
      ...gitRoutes(),
      [`POST ${repository}/git/refs`]: Response.json(
        { message: "Reference already exists" },
        { status: 422 }
      ),
    });

    await expect(
      commitToBranch(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, sha: "new-commit" });
    expect(github.routes.at(-1)).toBe(
      `PATCH ${repository}/git/refs/heads/maintenance-bot/cleanup`
    );
  });

  it("rejects a change that changes nothing", async () => {
    const github = fakeGitHub({
      ...gitRoutes(),
      [`POST ${repository}/git/trees`]: { sha: "base-tree" },
    });

    await expect(
      commitToBranch(createGitHubClient({ fetch: github.fetch }), options)
    ).rejects.toThrow("leaves publira/agents@base as it is");
    expect(
      github.requests.filter(
        ({ method, url }) =>
          method !== "GET" && !url.pathname.endsWith("/git/trees")
      )
    ).toHaveLength(0);
  });
});
