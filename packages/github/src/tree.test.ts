import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.ts";
import { fakeGitHub } from "./fake-github.ts";
import { listCommitFiles } from "./tree.ts";

const repository = "/repos/publira/publira";
const location = { owner: "publira", repo: "publira", sha: "head" };

describe(listCommitFiles, () => {
  it("lists the files of a commit with their modes", async () => {
    const github = fakeGitHub({
      [`GET ${repository}/git/commits/head`]: { tree: { sha: "root" } },
      [`GET ${repository}/git/trees/root`]: {
        sha: "root",
        tree: [
          { mode: "040000", path: ".agents", sha: "agents", type: "tree" },
          {
            mode: "100644",
            path: ".agents/skills/ultracite/SKILL.md",
            sha: "skill",
            type: "blob",
          },
          {
            mode: "120000",
            path: ".claude/skills/ultracite",
            sha: "link",
            type: "blob",
          },
          { mode: "160000", path: "vendor/lib", sha: "lib", type: "commit" },
        ],
        truncated: false,
      },
    });

    await expect(
      listCommitFiles(createGitHubClient({ fetch: github.fetch }), location)
    ).resolves.toStrictEqual([
      {
        mode: "100644",
        path: ".agents/skills/ultracite/SKILL.md",
        sha: "skill",
      },
      { mode: "120000", path: ".claude/skills/ultracite", sha: "link" },
    ]);
    expect(github.requests.at(-1)?.url.searchParams.get("recursive")).toBe(
      "true"
    );
  });

  it("refuses a tree GitHub cut short", async () => {
    const github = fakeGitHub({
      [`GET ${repository}/git/commits/head`]: { tree: { sha: "root" } },
      [`GET ${repository}/git/trees/root`]: {
        sha: "root",
        tree: [],
        truncated: true,
      },
    });

    await expect(
      listCommitFiles(createGitHubClient({ fetch: github.fetch }), location)
    ).rejects.toThrow("too large to list");
  });
});
