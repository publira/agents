import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.ts";
import { dynamic, fakeGitHub } from "./fake-github.ts";

// No waiting between attempts in tests.
const requestPolicy = { retryDelay: 0 };

/** Fails `failures` times as `failure` answers, then succeeds. */
const flaky = (failures: number, failure: () => Response) => {
  let attempts = 0;
  return dynamic(() => {
    attempts += 1;
    return attempts <= failures ? failure() : { name: "agents" };
  });
};

const serverError = () =>
  Response.json({ message: "Bad Gateway" }, { status: 502 });

describe("the request policy", () => {
  it("tries a read again after a server error", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": flaky(2, serverError),
    });
    const octokit = createGitHubClient({ fetch: github.fetch, requestPolicy });

    await expect(
      octokit.rest.repos.get({ owner: "publira", repo: "agents" })
    ).resolves.toMatchObject({ data: { name: "agents" } });
    expect(github.routes).toHaveLength(3);
  });

  it("gives up after the last retry", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": flaky(3, serverError),
    });
    const octokit = createGitHubClient({ fetch: github.fetch, requestPolicy });

    await expect(
      octokit.rest.repos.get({ owner: "publira", repo: "agents" })
    ).rejects.toMatchObject({ status: 502 });
    expect(github.routes).toHaveLength(3);
  });

  it("tries a read again after the rate limit when GitHub says soon", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": flaky(1, () =>
        Response.json(
          { message: "Too Many Requests" },
          { headers: { "retry-after": "0" }, status: 429 }
        )
      ),
    });
    const octokit = createGitHubClient({ fetch: github.fetch, requestPolicy });

    await expect(
      octokit.rest.repos.get({ owner: "publira", repo: "agents" })
    ).resolves.toMatchObject({ data: { name: "agents" } });
  });

  it("tries a read again after a 403 rate limit when GitHub says soon", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": flaky(1, () =>
        Response.json(
          { message: "You have exceeded a secondary rate limit" },
          { headers: { "retry-after": "0" }, status: 403 }
        )
      ),
    });
    const octokit = createGitHubClient({ fetch: github.fetch, requestPolicy });

    await expect(
      octokit.rest.repos.get({ owner: "publira", repo: "agents" })
    ).resolves.toMatchObject({ data: { name: "agents" } });
  });

  it("waits for the primary rate limit when it resets soon", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": flaky(1, () =>
        Response.json(
          { message: "API rate limit exceeded" },
          {
            headers: {
              "x-ratelimit-remaining": "0",
              // Already reset.
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) - 1),
            },
            status: 403,
          }
        )
      ),
    });
    const octokit = createGitHubClient({ fetch: github.fetch, requestPolicy });

    await expect(
      octokit.rest.repos.get({ owner: "publira", repo: "agents" })
    ).resolves.toMatchObject({ data: { name: "agents" } });
    expect(github.routes).toHaveLength(2);
  });

  it.each([
    ["a 403 without rate limit headers", 403, {}],
    ["a 429 without a wait", 429, {}],
    [
      "a primary rate limit that resets later",
      403,
      {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    ],
  ])("does not try %s again", async (_name, status, headers) => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": flaky(1, () =>
        Response.json({ message: "Forbidden" }, { headers, status })
      ),
    });
    const octokit = createGitHubClient({ fetch: github.fetch, requestPolicy });

    await expect(
      octokit.rest.repos.get({ owner: "publira", repo: "agents" })
    ).rejects.toMatchObject({ status });
    expect(github.routes).toHaveLength(1);
  });

  it("does not wait out a long rate limit", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": flaky(1, () =>
        Response.json(
          { message: "Too Many Requests" },
          { headers: { "retry-after": "3600" }, status: 429 }
        )
      ),
    });
    const octokit = createGitHubClient({ fetch: github.fetch, requestPolicy });

    await expect(
      octokit.rest.repos.get({ owner: "publira", repo: "agents" })
    ).rejects.toMatchObject({ status: 429 });
    expect(github.routes).toHaveLength(1);
  });

  it("does not try a failed write again", async () => {
    const github = fakeGitHub({
      "POST /repos/publira/agents/pulls/31/reviews": flaky(1, serverError),
    });
    const octokit = createGitHubClient({ fetch: github.fetch, requestPolicy });

    await expect(
      octokit.rest.pulls.createReview({
        event: "APPROVE",
        owner: "publira",
        pull_number: 31,
        repo: "agents",
      })
    ).rejects.toMatchObject({ status: 502 });
    expect(github.routes).toHaveLength(1);
  });

  it("does not try a client error again", async () => {
    const github = fakeGitHub({});
    const octokit = createGitHubClient({ fetch: github.fetch, requestPolicy });

    await expect(
      octokit.rest.repos.get({ owner: "publira", repo: "agents" })
    ).rejects.toMatchObject({ status: 404 });
    expect(github.routes).toHaveLength(1);
  });

  it("times out an attempt that takes too long, and tries it again", async () => {
    let attempts = 0;
    const octokit = createGitHubClient({
      fetch: async (_input, init) => {
        attempts += 1;
        // The second attempt answers; the first waits until it is aborted.
        if (attempts > 1) {
          return Response.json({ name: "agents" });
        }
        if (init?.signal) {
          await once(init.signal, "abort");
        }
        throw init?.signal?.reason;
      },
      requestPolicy: { ...requestPolicy, timeout: 10 },
    });

    await expect(
      octokit.rest.repos.get({ owner: "publira", repo: "agents" })
    ).resolves.toMatchObject({ data: { name: "agents" } });
    expect(attempts).toBe(2);
  });
});
