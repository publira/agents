import { createGitHubClient } from "@publira/github";
import type { GitHubApp } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type { Log } from "../log.ts";
import {
  approveEquivalentRenovateUpdate,
  approveEquivalentRenovateUpdatesEverywhere,
} from "./approve-equivalent-renovate-update.ts";

const BOT = "publira-maintenance[bot]";
const ACTIONS = 15_368;
const HEAD = "4658aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRECEDENT_HEAD = "9f1cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const turbo = {
  currentVersion: "2.11.5",
  datasource: "npm",
  depName: "turbo",
  manager: "npm",
  newVersion: "2.11.6",
  packageName: "turbo",
  updateType: "patch",
};

// A body as Renovate writes it with the organization's prHeader.
const renovateBody = (...updates: Readonly<Record<string, string>>[]) =>
  [
    ...updates.map(
      (update) =>
        `<!-- publira-renovate-update ${Buffer.from(JSON.stringify(update)).toString("base64")} -->`
    ),
    "",
    "This PR contains the following updates:",
    "",
    "| Package | Change |",
    "|---|---|",
    "| turbo | `2.11.5` → `2.11.6` |",
  ].join("\n");

const renovate = { login: "renovate[bot]", type: "Bot" };
const maintainer = { login: "ykzts", type: "User" };

const renovateCommit = (sha: string) => ({
  author: { login: "renovate[bot]" },
  commit: { verification: { verified: true } },
  committer: { login: "web-flow" },
  sha,
});

const humanApproval = {
  author_association: "MEMBER",
  commit_id: PRECEDENT_HEAD,
  id: 1,
  state: "APPROVED",
  submitted_at: "2026-10-04T05:45:44Z",
  user: maintainer,
};

type Json = boolean | number | string | null | readonly Json[] | JsonObject;

interface JsonObject {
  readonly [key: string]: Json | undefined;
}

interface Scenario {
  pullRequest?: JsonObject;
  /** The head each read of the pull request returns, the last one repeated. */
  heads?: readonly string[];
  /** The bot's own reviews of the pull request. */
  ownReviews?: readonly JsonObject[];
  commits?: readonly JsonObject[];
  checkRuns?: readonly JsonObject[];
  statuses?: readonly JsonObject[];
  /** The last editor of each pull request body, by `repo#number`. */
  editors?: Readonly<Record<string, JsonObject | null>>;
  /** The closed pull requests from the branch in publira/website. */
  precedents?: readonly JsonObject[];
  precedentReviews?: readonly JsonObject[];
}

const precedentPull = (fields: JsonObject = {}) => ({
  body: renovateBody(turbo),
  head: { sha: PRECEDENT_HEAD },
  html_url: "https://github.com/publira/website/pull/120",
  merged_at: "2026-10-04T05:47:28Z",
  number: 120,
  user: renovate,
  ...fields,
});

// Answers the GitHub API for publira/agents#31, a Renovate pull request, and
// publira/website#120, the same update merged after a maintainer approved it.
const fakeGitHub = ({
  pullRequest = {},
  heads = [HEAD],
  ownReviews = [],
  commits = [renovateCommit(HEAD)],
  checkRuns = [
    {
      app: { id: ACTIONS, slug: "github-actions" },
      conclusion: "success",
      name: "Test",
      status: "completed",
    },
  ],
  statuses = [{ context: "renovate/stability-days", state: "success" }],
  editors = {},
  precedents = [precedentPull()],
  precedentReviews = [humanApproval],
}: Scenario = {}) => {
  const writes: { route: string; body: unknown }[] = [];
  const routes: string[] = [];
  let reads = 0;

  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${decodeURIComponent(url.pathname)}`;
    const body =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    routes.push(route);

    if (method !== "GET" && route !== "POST /graphql") {
      writes.push({ body, route });
    }

    const respond = (): Json | undefined => {
      switch (route) {
        case "GET /repos/publira/agents/pulls/31": {
          const head = heads[Math.min(reads, heads.length - 1)];
          reads += 1;
          return {
            base: {
              ref: "main",
              repo: {
                full_name: "publira/agents",
                owner: { login: "publira", type: "Organization" },
              },
            },
            body: renovateBody(turbo),
            draft: false,
            head: {
              ref: "renovate/turbo-monorepo",
              repo: { full_name: "publira/agents" },
              sha: head,
            },
            locked: false,
            mergeable: true,
            number: 31,
            state: "open",
            user: renovate,
            ...pullRequest,
          };
        }
        case "GET /repos/publira/agents/pulls/31/reviews": {
          return ownReviews;
        }
        case "GET /repos/publira/agents/pulls/31/commits": {
          return commits;
        }
        case `GET /repos/publira/agents/commits/${HEAD}/check-runs`: {
          return { check_runs: checkRuns, total_count: checkRuns.length };
        }
        case `GET /repos/publira/agents/commits/${HEAD}/statuses`: {
          return statuses;
        }
        case "GET /repos/publira/agents/rules/branches/main": {
          return [
            {
              parameters: {
                required_status_checks: [
                  { context: "Test", integration_id: ACTIONS },
                ],
              },
              type: "required_status_checks",
            },
          ];
        }
        case "GET /orgs/publira/repos": {
          return [{ name: "agents" }, { name: "website" }];
        }
        case "GET /repos/publira/agents/pulls": {
          return [];
        }
        case "GET /repos/publira/website/pulls": {
          return url.searchParams.get("head") ===
            "publira:renovate/turbo-monorepo"
            ? precedents
            : [];
        }
        case "GET /repos/publira/website/pulls/120/reviews": {
          return precedentReviews;
        }
        case "POST /graphql": {
          const { number, repo } = body.variables;
          return {
            data: {
              repository: {
                pullRequest: { editor: editors[`${repo}#${number}`] ?? null },
              },
            },
          };
        }
        case "POST /repos/publira/agents/pulls/31/reviews": {
          return {
            commit_id: body.commit_id,
            id: 99,
            state: "PENDING",
            user: { login: BOT },
          };
        }
        case "POST /repos/publira/agents/pulls/31/reviews/99/events": {
          return { id: 99, state: "APPROVED" };
        }
        case "PUT /repos/publira/agents/pulls/31/reviews/99/dismissals": {
          return { id: 99, state: "DISMISSED" };
        }
        default: {
          return undefined;
        }
      }
    };

    const result = respond();
    const response =
      result === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json(result);
    // The pagination plugin reads the URL of the response.
    Object.defineProperty(response, "url", { value: url.href });
    return Promise.resolve(response);
  });

  return {
    octokit: createGitHubClient({ fetch: fetchImpl }),
    routes,
    writes,
  };
};

const run = (
  github: ReturnType<typeof fakeGitHub>,
  options: { dryRun?: boolean } = {}
) =>
  approveEquivalentRenovateUpdate({
    octokit: github.octokit,
    owner: "publira",
    pullNumber: 31,
    repo: "agents",
    reviewer: BOT,
    ...options,
  });

const failedCondition = (
  result: Awaited<ReturnType<typeof approveEquivalentRenovateUpdate>>
) =>
  result.status === "skipped"
    ? result.conditions.find(({ passed }) => !passed)
    : undefined;

describe(approveEquivalentRenovateUpdate, () => {
  it("approves the head of an update a maintainer approved elsewhere", async () => {
    const github = fakeGitHub();

    const result = await run(github);

    expect(result).toMatchObject({
      headSha: HEAD,
      precedent: {
        approvedBy: "ykzts",
        number: 120,
        owner: "publira",
        repo: "website",
      },
      review: { created: true, id: 99 },
      status: "approved",
    });
    expect(github.writes.map(({ route }) => route)).toStrictEqual([
      "POST /repos/publira/agents/pulls/31/reviews",
      "POST /repos/publira/agents/pulls/31/reviews/99/events",
    ]);
    expect(github.writes[0]?.body).toMatchObject({ commit_id: HEAD });
    expect(github.writes[1]?.body).toMatchObject({ event: "APPROVE" });
  });

  it("names the precedent and the updates in the review", async () => {
    const github = fakeGitHub();

    await run(github);

    expect(github.writes[1]?.body).toMatchObject({
      body: expect.stringMatching(
        /publira\/website#120.*`npm:npm:turbo:2\.11\.5->2\.11\.6:patch`.*ykzts approved the head it was merged at/su
      ),
    });
  });

  it.each([
    ["from-version", { currentVersion: "2.11.4" }],
    ["target version", { newVersion: "2.11.7" }],
    ["manager", { manager: "bun" }],
    ["datasource", { datasource: "github-releases" }],
    ["update type", { updateType: "minor" }],
  ])("does not approve a near match with another %s", async (_, change) => {
    const github = fakeGitHub({
      precedents: [
        precedentPull({ body: renovateBody({ ...turbo, ...change }) }),
      ],
    });

    const result = await run(github);

    expect(failedCondition(result)?.condition).toBe("precedent");
    expect(github.writes).toStrictEqual([]);
  });

  it("does not take a bot's approval as a precedent", async () => {
    const github = fakeGitHub({
      precedentReviews: [
        { ...humanApproval, user: { login: BOT, type: "Bot" } },
      ],
    });

    const result = await run(github);

    expect(failedCondition(result)).toMatchObject({
      condition: "precedent",
      detail:
        "publira/website#120 made the same updates, but no maintainer approved the head it was merged at",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("does not take an approved pull request that was not merged", async () => {
    const github = fakeGitHub({
      precedents: [precedentPull({ merged_at: null })],
    });

    const result = await run(github);

    expect(failedCondition(result)?.condition).toBe("precedent");
    expect(github.writes).toStrictEqual([]);
  });

  it("does not take an approval of an earlier head of the precedent", async () => {
    const github = fakeGitHub({
      precedentReviews: [{ ...humanApproval, commit_id: "earlier" }],
    });

    expect(failedCondition(await run(github))?.condition).toBe("precedent");
  });

  it("does not take a precedent whose description someone edited", async () => {
    const github = fakeGitHub({
      editors: { "website#120": { __typename: "User", login: "someone" } },
    });

    expect(failedCondition(await run(github))).toMatchObject({
      condition: "precedent",
      detail: expect.stringContaining("someone edited its description"),
    });
  });

  it("does not approve when the head moves after the checks were read", async () => {
    const github = fakeGitHub({ heads: [HEAD, "c0ffee0000"] });

    const result = await run(github);

    expect(failedCondition(result)).toStrictEqual({
      condition: "head",
      detail: "the head moved to c0ffee0 meanwhile",
      passed: false,
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("dismisses the approval when the head moves during the submission", async () => {
    const github = fakeGitHub({ heads: [HEAD, HEAD, "c0ffee0000"] });

    const result = await run(github);

    expect(result).toMatchObject({
      newHeadSha: "c0ffee0000",
      review: { id: 99 },
      status: "withdrawn",
    });
    expect(github.writes.at(-1)?.route).toBe(
      "PUT /repos/publira/agents/pulls/31/reviews/99/dismissals"
    );
  });

  it("explains a dry run without writing", async () => {
    const github = fakeGitHub();

    const result = await run(github, { dryRun: true });

    expect(result.status).toBe("would-approve");
    expect(
      result.status === "would-approve"
        ? result.conditions.map(({ condition, passed }) => [condition, passed])
        : []
    ).toStrictEqual([
      ["author", true],
      ["reviewable", true],
      ["metadata", true],
      ["description", true],
      ["commits", true],
      ["checks", true],
      ["precedent", true],
      ["head", true],
    ]);
    expect(github.writes).toStrictEqual([]);
  });

  it("stops at once when it already approved the head", async () => {
    const github = fakeGitHub({
      ownReviews: [
        { commit_id: HEAD, id: 7, state: "APPROVED", user: { login: BOT } },
      ],
    });

    await expect(run(github)).resolves.toStrictEqual({
      headSha: HEAD,
      reviewId: 7,
      status: "already-reviewed",
    });
    expect(github.routes).toStrictEqual([
      "GET /repos/publira/agents/pulls/31",
      "GET /repos/publira/agents/pulls/31/reviews",
    ]);
  });

  it("does not approve again a head someone dismissed its approval of", async () => {
    const github = fakeGitHub({
      ownReviews: [
        { commit_id: HEAD, id: 7, state: "DISMISSED", user: { login: BOT } },
      ],
    });

    const result = await run(github);

    expect(result.status).toBe("already-reviewed");
    expect(github.writes).toStrictEqual([]);
  });

  it.each([
    [
      "a pull request someone else opened",
      { pullRequest: { user: maintainer } },
      "author",
    ],
    ["a draft", { pullRequest: { draft: true } }, "reviewable"],
    [
      "a conflicted pull request",
      { pullRequest: { mergeable: false } },
      "reviewable",
    ],
    [
      "a body without the metadata",
      { pullRequest: { body: "This PR contains the following updates:" } },
      "metadata",
    ],
    [
      "a description someone edited",
      { editors: { "agents#31": { __typename: "User", login: "someone" } } },
      "description",
    ],
    [
      "a commit someone pushed",
      {
        commits: [
          renovateCommit("a"),
          { ...renovateCommit(HEAD), author: maintainer },
        ],
      },
      "commits",
    ],
    [
      "a check still running",
      {
        checkRuns: [
          {
            app: { id: ACTIONS },
            conclusion: null,
            name: "Test",
            status: "in_progress",
          },
        ],
      },
      "checks",
    ],
    [
      "a missing required check",
      { checkRuns: [], statuses: [{ context: "vercel", state: "success" }] },
      "checks",
    ],
  ] as const)("does not approve %s", async (_, scenario, condition) => {
    const github = fakeGitHub(scenario);

    expect(failedCondition(await run(github))?.condition).toBe(condition);
    expect(github.writes).toStrictEqual([]);
  });

  it("accepts a description Renovate rewrote", async () => {
    const github = fakeGitHub({
      editors: { "agents#31": { __typename: "Bot", login: "renovate" } },
    });

    const result = await run(github);

    expect(result.status).toBe("approved");
  });
});

describe(approveEquivalentRenovateUpdatesEverywhere, () => {
  it("evaluates the open Renovate pull requests from the branch", async () => {
    const requests: string[] = [];
    const octokit = createGitHubClient({
      fetch: (input) => {
        const url = new URL(String(input));
        requests.push(`${url.pathname}${url.search}`);
        const response = Response.json(
          url.pathname === "/installation/repositories"
            ? {
                repositories: [
                  {
                    archived: false,
                    default_branch: "main",
                    name: "agents",
                    owner: { login: "publira" },
                  },
                ],
                total_count: 1,
              }
            : [
                { number: 31, user: renovate },
                { number: 32, user: maintainer },
              ]
        );
        Object.defineProperty(response, "url", { value: url.href });
        return Promise.resolve(response);
      },
    });
    const app: GitHubApp = {
      getBotLogin: () => Promise.resolve(BOT),
      getInstallationOctokit: () => Promise.resolve(octokit),
      getRepositoryOctokit: () => Promise.reject(new Error("unused")),
      octokit: createGitHubClient({
        fetch: (input) => {
          const url = new URL(String(input));
          const response = Response.json(
            url.pathname === "/app/installations"
              ? [{ id: 1, suspended_at: null }]
              : { message: "Not Found" },
            { status: url.pathname === "/app/installations" ? 200 : 404 }
          );
          Object.defineProperty(response, "url", { value: url.href });
          return Promise.resolve(response);
        },
      }),
    };
    const job = vi.fn<typeof approveEquivalentRenovateUpdate>(() =>
      Promise.resolve({
        conditions: [],
        headSha: HEAD,
        status: "skipped" as const,
      })
    );
    const log = vi.fn<Log>();

    await approveEquivalentRenovateUpdatesEverywhere({
      app,
      headRef: "renovate/turbo-monorepo",
      job,
      log,
    });

    expect(job).toHaveBeenCalledOnce();
    expect(job.mock.calls[0]?.[0]).toMatchObject({
      owner: "publira",
      pullNumber: 31,
      repo: "agents",
      reviewer: BOT,
    });
    expect(requests).toContain(
      "/repos/publira/agents/pulls?head=publira%3Arenovate%2Fturbo-monorepo&per_page=100&state=open"
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      "Renovate update evaluated",
      expect.objectContaining({ pullRequest: 31, status: "skipped" })
    );
  });
});
