import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createGitHubClient } from "./client.ts";
import { dynamic, fakeGitHub } from "./fake-github.ts";
import {
  ensureIssueComment,
  getParentIssue,
  issueLocationOf,
} from "./issue.ts";

const comments = "/repos/publira/agents/issues/51/comments";
const bot = "publira-maintenance[bot]";
const body = "Closing this Epic because all of its sub-issues are closed.";
const since = new Date("2026-10-05T03:00:00Z");

const options = {
  author: bot,
  body,
  issueNumber: 51,
  owner: "publira",
  repo: "agents",
  since,
};

interface Comment {
  body: string;
  created_at: string;
  id: number;
  updated_at: string;
  user: { login: string };
}

const createCommentBody = z.object({ body: z.string() });

/** The comments of publira/agents#51, kept as GitHub keeps them. */
const commentStore = (initial: Partial<Comment>[] = []) => {
  let nextId = 100;
  const store: Comment[] = initial.map((comment, index) => ({
    body,
    created_at: "2026-10-05T03:00:01Z",
    id: index + 1,
    updated_at: "2026-10-05T03:00:01Z",
    user: { login: bot },
    ...comment,
  }));
  const listComments = dynamic(({ url }) => {
    const after = new Date(url.searchParams.get("since") ?? 0).getTime();
    return store
      .filter((comment) => new Date(comment.updated_at).getTime() >= after)
      .map((comment) => ({ ...comment }));
  });
  const createComment = dynamic(({ body: request }) => {
    const comment = {
      body: createCommentBody.parse(request).body,
      created_at: "2026-10-05T03:00:02Z",
      id: nextId,
      updated_at: "2026-10-05T03:00:02Z",
      user: { login: bot },
    };
    nextId += 1;
    store.push(comment);
    return comment;
  });
  const deleteComment = (id: number) =>
    dynamic(() => {
      const index = store.findIndex((comment) => comment.id === id);
      if (index === -1) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      store.splice(index, 1);
      return new Response(null, { status: 204 });
    });
  const routes = Object.fromEntries([
    [`GET ${comments}`, listComments],
    [`POST ${comments}`, createComment],
    ...[100, 101].map((id) => [
      `DELETE /repos/publira/agents/issues/comments/${id}`,
      deleteComment(id),
    ]),
  ]);

  return { github: fakeGitHub(routes), store };
};

describe(issueLocationOf, () => {
  it("reads the repository from the issue's repository URL", () => {
    expect(
      issueLocationOf({
        number: 3408,
        repository_url: "https://api.github.com/repos/publira/publira",
      })
    ).toStrictEqual({ issueNumber: 3408, owner: "publira", repo: "publira" });
  });

  it("throws on another URL", () => {
    expect(() =>
      issueLocationOf({
        number: 1,
        repository_url: "https://github.com/publira",
      })
    ).toThrow("Expected a repository API URL");
  });
});

describe(getParentIssue, () => {
  it("returns where the parent lives", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents/issues/52/parent": {
        number: 3408,
        repository_url: "https://api.github.com/repos/publira/publira",
      },
    });

    await expect(
      getParentIssue(createGitHubClient({ fetch: github.fetch }), {
        issueNumber: 52,
        owner: "publira",
        repo: "agents",
      })
    ).resolves.toStrictEqual({
      issueNumber: 3408,
      owner: "publira",
      repo: "publira",
    });
  });

  it("returns undefined for an issue without a parent", async () => {
    const github = fakeGitHub({});

    await expect(
      getParentIssue(createGitHubClient({ fetch: github.fetch }), {
        issueNumber: 52,
        owner: "publira",
        repo: "agents",
      })
    ).resolves.toBeUndefined();
  });
});

describe(ensureIssueComment, () => {
  it("posts the comment", async () => {
    const { github, store } = commentStore();

    await expect(
      ensureIssueComment(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, id: 100 });
    expect(store.map(({ id }) => id)).toStrictEqual([100]);
    expect(github.requests[0]?.url.searchParams.get("since")).toBe(
      "2026-10-05T03:00:00.000Z"
    );
  });

  it("leaves a comment the author already posted", async () => {
    const { github } = commentStore([{ id: 5 }]);

    await expect(
      ensureIssueComment(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: false, id: 5 });
    expect(github.routes).toStrictEqual([`GET ${comments}`]);
  });

  it.each([
    ["another author", { user: { login: "ykzts" } }],
    ["another body", { body: "Closing." }],
    [
      "an earlier close",
      {
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-10-05T04:00:00Z",
      },
    ],
  ])("does not count a comment of %s", async (_, overrides) => {
    const { github } = commentStore([overrides]);

    await expect(
      ensureIssueComment(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({ created: true, id: 100 });
  });

  it("leaves one comment between concurrent runs", async () => {
    const { github, store } = commentStore();
    const octokit = createGitHubClient({ fetch: github.fetch });

    const results = await Promise.all([
      ensureIssueComment(octokit, options),
      ensureIssueComment(octokit, options),
    ]);

    expect(store.map(({ id }) => id)).toStrictEqual([100]);
    expect(results.map(({ created }) => created).toSorted()).toStrictEqual([
      false,
      true,
    ]);
    expect(results.map(({ id }) => id)).toStrictEqual([100, 100]);
  });
});
