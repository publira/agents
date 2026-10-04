import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.ts";
import { fakeGitHub } from "./fake-github.ts";
import { getPullRequestBodyEditor } from "./pull-request-editor.ts";

const editorOf = (editor: { __typename: string; login: string } | null) =>
  fakeGitHub({
    "POST /graphql": { data: { repository: { pullRequest: { editor } } } },
  });

const location = { owner: "publira", pullNumber: 26, repo: "agents" };

describe(getPullRequestBodyEditor, () => {
  it("returns null for a body nobody edited", async () => {
    const github = editorOf(null);

    await expect(
      getPullRequestBodyEditor(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBeNull();
    expect(github.requests[0]?.body).toMatchObject({
      variables: { number: 26, owner: "publira", repo: "agents" },
    });
  });

  it("spells a bot's login as the REST API does", async () => {
    const github = editorOf({ __typename: "Bot", login: "renovate" });

    await expect(
      getPullRequestBodyEditor(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe("renovate[bot]");
  });

  it("returns a person's login", async () => {
    const github = editorOf({ __typename: "User", login: "ykzts" });

    await expect(
      getPullRequestBodyEditor(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe("ykzts");
  });
});
