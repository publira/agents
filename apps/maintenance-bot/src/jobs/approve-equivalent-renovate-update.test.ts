import { createGitHubClient } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import {
  approveEquivalentRenovateUpdate,
  createPrecedentScanCache,
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
  /** What the second and later reads of them return, as after a concurrent run. */
  ownReviewsLater?: readonly JsonObject[];
  /** Whether the review was dismissed already, so dismissing it fails. */
  alreadyDismissed?: boolean;
  commits?: readonly JsonObject[];
  checkRuns?: readonly JsonObject[];
  statuses?: readonly JsonObject[];
  /** The last editor of each pull request body, by `repo#number`. */
  editors?: Readonly<Record<string, JsonObject | null>>;
  /** The closed pull requests from the branch in publira/website. */
  precedents?: readonly JsonObject[];
  precedentReviews?: readonly JsonObject[];
  /** Each reviewer's permission on publira/website; `read` for the rest. */
  permissions?: Readonly<Record<string, string>>;
  /** The status GitHub refuses to tell the permissions with, if it does. */
  permissionRefusal?: number;
}

const PERMISSION_ROUTE =
  /^GET \/repos\/publira\/website\/collaborators\/(?<login>[^/]+)\/permission$/u;

const permissionResponse = (permission: string, refusal?: number) =>
  refusal === undefined
    ? Response.json({ permission, role_name: permission, user: null })
    : Response.json(
        { message: "Resource not accessible by integration" },
        { status: refusal }
      );

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
  ownReviewsLater = ownReviews,
  alreadyDismissed = false,
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
  permissions = { ykzts: "admin" },
  permissionRefusal,
}: Scenario = {}) => {
  const writes: { route: string; body: unknown }[] = [];
  const routes: string[] = [];
  let reads = 0;
  let reviewReads = 0;

  const respondWithPermission = (route: string) => {
    const login = PERMISSION_ROUTE.exec(route)?.groups?.login;
    return login === undefined
      ? undefined
      : permissionResponse(permissions[login] ?? "read", permissionRefusal);
  };

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

    const respond = (): Json | Response | undefined => {
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
          reviewReads += 1;
          return reviewReads === 1 ? ownReviews : ownReviewsLater;
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
          return alreadyDismissed
            ? Response.json(
                { message: "Can not dismiss a dismissed review" },
                { status: 422 }
              )
            : { id: 99, state: "DISMISSED" };
        }
        default: {
          return undefined;
        }
      }
    };

    const result =
      respondWithPermission(route) ??
      respond() ??
      Response.json({ message: "Not Found" }, { status: 404 });
    const response =
      result instanceof Response ? result : Response.json(result);
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
  options: Partial<Parameters<typeof approveEquivalentRenovateUpdate>[0]> = {}
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

  it("takes the approval of someone who can write to the precedent's repository", async () => {
    // A member whose membership is private, as the App reads the review.
    const github = fakeGitHub({
      permissions: { ykzts: "write" },
      precedentReviews: [
        { ...humanApproval, author_association: "CONTRIBUTOR" },
      ],
    });

    const result = await run(github);

    expect(result).toMatchObject({
      precedent: { approvedBy: "ykzts" },
      status: "approved",
    });
    expect(github.routes).toContain(
      "GET /repos/publira/website/collaborators/ykzts/permission"
    );
  });

  it("does not take the approval of someone who cannot write to the precedent's repository", async () => {
    const github = fakeGitHub({
      permissions: { ykzts: "read" },
      precedentReviews: [{ ...humanApproval, author_association: "MEMBER" }],
    });

    const result = await run(github);

    expect(failedCondition(result)).toMatchObject({
      condition: "precedent",
      detail:
        "publira/website#120 made the same updates, but no maintainer approved the head it was merged at",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("takes a later approver who can write when an earlier one cannot", async () => {
    const github = fakeGitHub({
      permissions: { ykzts: "admin" },
      precedentReviews: [
        { ...humanApproval, user: { login: "someone", type: "User" } },
        humanApproval,
      ],
    });

    const result = await run(github, { dryRun: true });

    expect(result).toMatchObject({ precedent: { approvedBy: "ykzts" } });
  });

  it("says so when it cannot read an approver's permission", async () => {
    const github = fakeGitHub({ permissionRefusal: 403 });

    expect(failedCondition(await run(github))).toMatchObject({
      condition: "precedent",
      detail:
        "publira/website#120 made the same updates, but the bot cannot read whether ykzts, who approved the head it was merged at, can write to publira/website",
    });
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

  it("dismisses the approval a concurrent run submitted when the head moves", async () => {
    const github = fakeGitHub({
      heads: [HEAD, HEAD, "c0ffee0000"],
      ownReviewsLater: [
        { commit_id: HEAD, id: 99, state: "APPROVED", user: { login: BOT } },
      ],
    });

    const result = await run(github);

    expect(result).toMatchObject({ review: { id: 99 }, status: "withdrawn" });
    expect(github.writes.map(({ route }) => route)).toStrictEqual([
      "PUT /repos/publira/agents/pulls/31/reviews/99/dismissals",
    ]);
  });

  it("accepts an approval someone dismissed first", async () => {
    const github = fakeGitHub({
      alreadyDismissed: true,
      heads: [HEAD, HEAD, "c0ffee0000"],
    });

    const result = await run(github);

    expect(result.status).toBe("withdrawn");
  });

  it("scans for precedents, and reads each permission, once per run", async () => {
    const github = fakeGitHub();
    const precedentScanCache = createPrecedentScanCache();

    await run(github, { dryRun: true, precedentScanCache });
    await run(github, { dryRun: true, precedentScanCache });

    expect(
      github.routes.filter(
        (route) =>
          route === "GET /orgs/publira/repos" ||
          route === "GET /repos/publira/website/pulls" ||
          route.endsWith("/permission")
      )
    ).toStrictEqual([
      "GET /orgs/publira/repos",
      "GET /repos/publira/website/pulls",
      "GET /repos/publira/website/collaborators/ykzts/permission",
    ]);
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
