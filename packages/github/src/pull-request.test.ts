import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.ts";
import { dynamic, fakeGitHub } from "./fake-github.ts";
import { ensurePullRequest } from "./pull-request.ts";

const pulls = "/repos/publira/agents/pulls";

const options = {
  base: "main",
  body: "Removes expired entries.",
  head: "chachamaru/cleanup",
  owner: "publira",
  repo: "agents",
  title: "chore: clean up",
};

const openPullRequest = {
  body: "Removes expired entries.",
  html_url: "https://github.com/publira/agents/pull/7",
  number: 7,
  title: "chore: clean up",
};

describe(ensurePullRequest, () => {
  it("opens a pull request", async () => {
    const github = fakeGitHub({
      [`GET ${pulls}`]: [],
      [`POST ${pulls}`]: openPullRequest,
    });

    await expect(
      ensurePullRequest(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({
      created: true,
      number: 7,
      url: "https://github.com/publira/agents/pull/7",
    });
    const list = github.requests[0]?.url.searchParams;
    expect(list?.get("head")).toBe("publira:chachamaru/cleanup");
    expect(list?.get("base")).toBe("main");
    expect(list?.get("state")).toBe("open");
    expect(github.requests[1]?.body).toStrictEqual({
      base: "main",
      body: "Removes expired entries.",
      head: "chachamaru/cleanup",
      title: "chore: clean up",
    });
  });

  it("leaves an open pull request that matches", async () => {
    const github = fakeGitHub({ [`GET ${pulls}`]: [openPullRequest] });

    await expect(
      ensurePullRequest(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toStrictEqual({
      created: false,
      number: 7,
      url: "https://github.com/publira/agents/pull/7",
    });
    expect(github.routes).toStrictEqual([`GET ${pulls}`]);
  });

  it("updates the title and body of an open pull request", async () => {
    const github = fakeGitHub({
      [`GET ${pulls}`]: [{ ...openPullRequest, body: "Removes one entry." }],
      [`PATCH ${pulls}/7`]: openPullRequest,
    });

    await ensurePullRequest(
      createGitHubClient({ fetch: github.fetch }),
      options
    );

    expect(github.requests.at(-1)?.body).toStrictEqual({
      body: "Removes expired entries.",
      title: "chore: clean up",
    });
  });

  it("returns the pull request a concurrent run opened first", async () => {
    let lists = 0;
    const github = fakeGitHub({
      [`GET ${pulls}`]: dynamic(() => {
        lists += 1;
        return lists === 1 ? [] : [openPullRequest];
      }),
      [`POST ${pulls}`]: Response.json(
        { message: "A pull request already exists" },
        { status: 422 }
      ),
    });

    await expect(
      ensurePullRequest(createGitHubClient({ fetch: github.fetch }), options)
    ).resolves.toMatchObject({ created: false, number: 7 });
  });

  it("rethrows a rejection that left no pull request open", async () => {
    const github = fakeGitHub({
      [`GET ${pulls}`]: [],
      [`POST ${pulls}`]: Response.json(
        { message: "No commits between main and chachamaru/cleanup" },
        { status: 422 }
      ),
    });

    await expect(
      ensurePullRequest(createGitHubClient({ fetch: github.fetch }), options)
    ).rejects.toThrow("No commits between");
  });
});
