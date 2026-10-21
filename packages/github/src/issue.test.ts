import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createGitHubClient } from "./client.ts";
import { dynamic, fakeGitHub } from "./fake-github.ts";
import {
  ensureIssueComment,
  getParentIssue,
  issueLocationOf,
  minimizeOutdatedIssueComments,
} from "./issue.ts";

const comments = "/repos/publira/agents/issues/51/comments";
const bot = "chachamaru-bot[bot]";
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

    return store.flatMap((comment) =>
      new Date(comment.updated_at).getTime() >= after ? [{ ...comment }] : []
    );
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

  describe("with a marker", () => {
    const marker = "<!-- chachamaru-lint-findings head=abc -->";

    const marked = {
      ...options,
      body: `${marker}\nThe check still fails.`,
      marker,
      since: undefined,
    };

    it("leaves a comment with the marker, whatever its body", async () => {
      const { github } = commentStore([
        { body: `${marker}\nAn earlier run's output.` },
      ]);

      await expect(
        ensureIssueComment(createGitHubClient({ fetch: github.fetch }), marked)
      ).resolves.toStrictEqual({ created: false, id: 1 });
      expect(github.requests[0]?.url.searchParams.has("since")).toBeFalsy();
    });

    it("posts the comment when none has the marker", async () => {
      const { github } = commentStore([
        { body: "<!-- chachamaru-lint-findings head=def -->\nAnother head." },
      ]);

      await expect(
        ensureIssueComment(createGitHubClient({ fetch: github.fetch }), marked)
      ).resolves.toStrictEqual({ created: true, id: 100 });
    });
  });
});

interface CommentNode {
  id: string;
  fullDatabaseId: string | null;
  body: string;
  isMinimized: boolean;
  author: { __typename: string; login: string } | null;
}

const graphqlRequest = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()),
});

const findingsMarker = "<!-- chachamaru-lint-findings head=";

/**
 * The comments of pull request 51 as GitHub's GraphQL API lists them, oldest
 * first, `perPage` at a time, and minimizes them on request.
 */
const commentNodeStore = (initial: Partial<CommentNode>[], perPage = 100) => {
  const store: CommentNode[] = initial.map((comment, index) => ({
    author: { __typename: "Bot", login: "chachamaru-bot" },
    body: `${findingsMarker}head${index + 1} -->\nThe check still fails.`,
    fullDatabaseId: String(index + 1),
    id: `IC_${index + 1}`,
    isMinimized: false,
    ...comment,
  }));

  const graphql = dynamic(({ body: request }) => {
    const { query, variables } = graphqlRequest.parse(request);

    if (query.includes("minimizeComment")) {
      const comment = store.find(({ id }) => id === variables.id);

      if (comment === undefined) {
        return { data: null, errors: [{ message: "Could not resolve" }] };
      }

      comment.isMinimized = true;

      return { data: { minimizeComment: { clientMutationId: null } } };
    }

    const start = variables.after === null ? 0 : Number(variables.after);
    const end = start + perPage;

    return {
      data: {
        repository: {
          issueOrPullRequest: {
            comments: {
              nodes: store.slice(start, end).map((comment) => ({ ...comment })),
              pageInfo: {
                endCursor: String(end),
                hasNextPage: end < store.length,
              },
            },
          },
        },
      },
    };
  });

  return { github: fakeGitHub({ "POST /graphql": graphql }), store };
};

const minimized = (requests: { body: unknown }[]) =>
  requests.flatMap(({ body: request }) => {
    const { query, variables } = graphqlRequest.parse(request);

    return query.includes("minimizeComment") ? [variables.id] : [];
  });

describe(minimizeOutdatedIssueComments, () => {
  const location = {
    author: bot,
    issueNumber: 51,
    marker: findingsMarker,
    owner: "publira",
    repo: "agents",
  };

  it("minimizes the author's comments with the marker as outdated", async () => {
    const { github, store } = commentNodeStore([{}, {}]);

    await expect(
      minimizeOutdatedIssueComments(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe(2);
    expect(store.map(({ isMinimized }) => isMinimized)).toStrictEqual([
      true,
      true,
    ]);
    expect(github.requests.at(-1)?.body).toMatchObject({
      query: expect.stringContaining("classifier: OUTDATED"),
      variables: { id: "IC_2" },
    });
  });

  it("leaves the given comment and the ones after it", async () => {
    const { github } = commentNodeStore([{}, {}, {}, {}]);

    await expect(
      minimizeOutdatedIssueComments(
        createGitHubClient({ fetch: github.fetch }),
        { ...location, commentId: 3 }
      )
    ).resolves.toBe(2);
    expect(minimized(github.requests)).toStrictEqual(["IC_1", "IC_2"]);
  });

  it("compares comment IDs as numbers", async () => {
    const { github } = commentNodeStore([
      { fullDatabaseId: "9" },
      { fullDatabaseId: "12345678901234567890" },
      { fullDatabaseId: null },
    ]);

    await minimizeOutdatedIssueComments(
      createGitHubClient({ fetch: github.fetch }),
      { ...location, commentId: 10 }
    );

    expect(minimized(github.requests)).toStrictEqual(["IC_1"]);
  });

  it.each([
    ["another user", { author: { __typename: "User", login: "ykzts" } }],
    ["another bot", { author: { __typename: "Bot", login: "vercel" } }],
    ["a deleted account", { author: null }],
    ["the author, without the marker", { body: "Thanks for the update." }],
    ["the author, already minimized", { isMinimized: true }],
  ])("leaves a comment by %s", async (_label, overrides) => {
    const { github } = commentNodeStore([overrides]);

    await expect(
      minimizeOutdatedIssueComments(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe(0);
    expect(minimized(github.requests)).toStrictEqual([]);
  });

  it("reads every page of the comments", async () => {
    const { github } = commentNodeStore([{}, {}, {}], 2);

    await expect(
      minimizeOutdatedIssueComments(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe(3);
    expect(minimized(github.requests)).toStrictEqual(["IC_1", "IC_2", "IC_3"]);
  });

  it("changes nothing when run again", async () => {
    const { github } = commentNodeStore([{}, {}]);
    const octokit = createGitHubClient({ fetch: github.fetch });

    await minimizeOutdatedIssueComments(octokit, location);

    await expect(
      minimizeOutdatedIssueComments(octokit, location)
    ).resolves.toBe(0);
    expect(minimized(github.requests)).toStrictEqual(["IC_1", "IC_2"]);
  });
});
