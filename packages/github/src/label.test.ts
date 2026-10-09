import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.ts";
import { fakeGitHub } from "./fake-github.ts";
import type { Json } from "./fake-github.ts";
import { getRepositoryLabelState, removeIssueLabel } from "./label.ts";

const label = "/repos/publira/agents/labels/ai-assisted";
const issueLabel = "/repos/publira/agents/issues/51/labels/ai-assisted";

describe(getRepositoryLabelState, () => {
  it.each([
    ["active", { archived_at: null, name: "ai-assisted" }],
    ["active", { name: "ai-assisted" }],
    ["archived", { archived_at: "2026-10-09T00:00:00Z", name: "ai-assisted" }],
  ])("tells an %s label", async (state, response: Json) => {
    const github = fakeGitHub({ [`GET ${label}`]: response });

    await expect(
      getRepositoryLabelState(createGitHubClient({ fetch: github.fetch }), {
        name: "ai-assisted",
        owner: "publira",
        repo: "agents",
      })
    ).resolves.toBe(state);
  });

  it("tells a label the repository does not define", async () => {
    const github = fakeGitHub({});

    await expect(
      getRepositoryLabelState(createGitHubClient({ fetch: github.fetch }), {
        name: "ai-assisted",
        owner: "publira",
        repo: "agents",
      })
    ).resolves.toBe("missing");
  });
});

describe(removeIssueLabel, () => {
  const options = {
    issueNumber: 51,
    name: "ai-assisted",
    owner: "publira",
    repo: "agents",
  };

  it("takes the label off", async () => {
    const github = fakeGitHub({ [`DELETE ${issueLabel}`]: [] });

    await expect(
      removeIssueLabel(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toBeTruthy();
    expect(github.routes).toStrictEqual([`DELETE ${issueLabel}`]);
  });

  it("accepts a label that is already gone", async () => {
    const github = fakeGitHub({});

    await expect(
      removeIssueLabel(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toBeFalsy();
  });

  it("passes on any other failure", async () => {
    const github = fakeGitHub({
      [`DELETE ${issueLabel}`]: Response.json(
        { message: "Forbidden" },
        { status: 403 }
      ),
    });

    await expect(
      removeIssueLabel(createGitHubClient({ fetch: github.fetch }), options)
    ).rejects.toMatchObject({ status: 403 });
  });
});
