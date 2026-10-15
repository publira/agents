import { describe, expect, it, vi } from "vitest";

import { getBranchHeadSha } from "./branch.ts";
import { createGitHubClient } from "./client.ts";

const location = {
  branch: "chachamaru/cleanup",
  owner: "publira",
  repo: "agents",
};

const respondWith = (response: Response) =>
  vi.fn<typeof fetch>(() => Promise.resolve(response));

describe(getBranchHeadSha, () => {
  it("returns the commit the branch points to", async () => {
    const fetchImpl = respondWith(Response.json({ commit: { sha: "head" } }));

    await expect(
      getBranchHeadSha(createGitHubClient({ fetch: fetchImpl }), location)
    ).resolves.toBe("head");
    // A slash in the branch name is escaped.
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/publira/agents/branches/chachamaru%2Fcleanup"
    );
  });

  it("returns undefined for a branch that does not exist", async () => {
    // What an empty repository answers for its default branch too.
    const fetchImpl = respondWith(
      Response.json({ message: "Branch not found" }, { status: 404 })
    );

    await expect(
      getBranchHeadSha(createGitHubClient({ fetch: fetchImpl }), location)
    ).resolves.toBeUndefined();
  });

  it("passes on other failures", async () => {
    const fetchImpl = respondWith(
      Response.json({ message: "Forbidden" }, { status: 403 })
    );

    await expect(
      getBranchHeadSha(createGitHubClient({ fetch: fetchImpl }), location)
    ).rejects.toMatchObject({ status: 403 });
  });
});
