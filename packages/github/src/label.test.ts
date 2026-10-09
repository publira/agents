import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.ts";
import { fakeGitHub } from "./fake-github.ts";
import { hasRepositoryLabel, removeIssueLabel } from "./label.ts";

const label = "/repos/publira/agents/labels/ai-assisted";
const issueLabel = "/repos/publira/agents/issues/51/labels/ai-assisted";

describe(hasRepositoryLabel, () => {
  it("finds a label the repository defines", async () => {
    const github = fakeGitHub({ [`GET ${label}`]: { name: "ai-assisted" } });

    await expect(
      hasRepositoryLabel(createGitHubClient({ fetch: github.fetch }), {
        name: "ai-assisted",
        owner: "publira",
        repo: "agents",
      })
    ).resolves.toBeTruthy();
  });

  it("tells a label the repository does not define", async () => {
    const github = fakeGitHub({});

    await expect(
      hasRepositoryLabel(createGitHubClient({ fetch: github.fetch }), {
        name: "ai-assisted",
        owner: "publira",
        repo: "agents",
      })
    ).resolves.toBeFalsy();
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
