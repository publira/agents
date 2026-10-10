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
  /** Every review of the pull request, as GitHub's GraphQL API lists them. */
  reviewNodes?: readonly JsonObject[];
  /** Whether GitHub refuses to minimize a review. */
  minimizeRefused?: boolean;
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
  /** The files the pull request changes. */
  pullFiles?: readonly string[];
  /** The files each commit changes, by SHA. */
  commitFiles?: Readonly<Record<string, readonly string[]>>;
  /** The base branch's `.github/maintenance-bot/regenerate.yml`. */
  regenerationConfig?: string;
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
  reviewNodes = [],
  minimizeRefused = false,
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
  pullFiles = ["package.json"],
  commitFiles = {},
  regenerationConfig,
}: Scenario = {}) => {
  const writes: { route: string; body: unknown }[] = [];
  const routes: string[] = [];
  const minimized: string[] = [];
  let reads = 0;
  let reviewReads = 0;

  const respondWithPermission = (route: string) => {
    const login = PERMISSION_ROUTE.exec(route)?.groups?.login;
    return login === undefined
      ? undefined
      : permissionResponse(permissions[login] ?? "read", permissionRefusal);
  };

  // The files of the pull request and of its head, which the commit check
  // reads for the bot's commits.
  const respondWithFiles = (route: string, url: URL) => {
    if (
      route ===
      "GET /repos/publira/agents/contents/.github/maintenance-bot/regenerate.yml"
    ) {
      return regenerationConfig === undefined ||
        url.searchParams.get("ref") !== "base"
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : {
            content: Buffer.from(regenerationConfig).toString("base64"),
            encoding: "base64",
            type: "file",
          };
    }
    if (route === "GET /repos/publira/agents/pulls/31/files") {
      return pullFiles.map((filename) => ({ filename }));
    }
    if (route === `GET /repos/publira/agents/commits/${HEAD}`) {
      // In pages of `per_page` files, as GitHub lists them.
      const perPage = Number(url.searchParams.get("per_page") ?? 300);
      const page = Number(url.searchParams.get("page") ?? 1);
      return {
        files: (commitFiles[HEAD] ?? [])
          .slice((page - 1) * perPage, page * perPage)
          .map((filename) => ({ filename })),
        sha: HEAD,
      };
    }
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
              sha: "base",
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
          if (body.query.includes("minimizeComment")) {
            if (minimizeRefused) {
              return {
                data: null,
                errors: [{ message: "Resource not accessible by integration" }],
              };
            }
            minimized.push(body.variables.id);
            return { data: { minimizeComment: { clientMutationId: null } } };
          }
          if (body.query.includes("reviews(")) {
            return {
              data: {
                repository: {
                  pullRequest: {
                    reviews: {
                      nodes: reviewNodes,
                      pageInfo: { endCursor: null, hasNextPage: false },
                    },
                  },
                },
              },
            };
          }
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
      respondWithFiles(route, url) ??
      respond() ??
      Response.json({ message: "Not Found" }, { status: 404 });
    const response =
      result instanceof Response ? result : Response.json(result);
    // The pagination plugin reads the URL of the response.
    Object.defineProperty(response, "url", { value: url.href });
    return Promise.resolve(response);
  });

  return {
    /** The node IDs of the reviews minimized, in order. */
    minimized,
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

// A review as GitHub's GraphQL API lists it, by the bot unless `author` says.
const reviewNode = (
  id: string,
  commit: string,
  fields: JsonObject = {}
): JsonObject => ({
  author: { __typename: "Bot", login: "publira-maintenance" },
  commit: { oid: commit },
  id,
  isMinimized: false,
  state: "APPROVED",
  ...fields,
});

const failedCondition = (
  result: Awaited<ReturnType<typeof approveEquivalentRenovateUpdate>>
) =>
  result.status === "skipped"
    ? result.conditions.find(({ passed }) => !passed)
    : undefined;

describe(approveEquivalentRenovateUpdate, () => {
  it("approves an update the bot synced the Dev Container lock file of", async () => {
    const lockFileCommit = {
      author: { login: BOT },
      commit: { verification: { verified: true } },
      committer: { login: BOT },
      sha: HEAD,
    };
    const github = fakeGitHub({
      commitFiles: { [HEAD]: [".devcontainer/devcontainer-lock.json"] },
      commits: [renovateCommit("renovate"), lockFileCommit],
      pullFiles: [
        ".devcontainer/devcontainer-lock.json",
        ".devcontainer/devcontainer.json",
      ],
    });

    const result = await run(github);

    expect(result).toMatchObject({ status: "approved" });
    expect(
      result.status === "approved"
        ? result.conditions.find(({ condition }) => condition === "commits")
        : undefined
    ).toStrictEqual({
      condition: "commits",
      detail:
        "Renovate made 1 commit(s), and the maintenance bot 1 syncing the Dev Container lock files, all signed by GitHub",
      passed: true,
    });
  });

  it("reads every page of the files of the bot's commit", async () => {
    const lockFiles = Array.from(
      { length: 100 },
      (_, index) => `.devcontainer/feature-${index}/devcontainer-lock.json`
    );
    const github = fakeGitHub({
      commitFiles: { [HEAD]: [...lockFiles, "README.md"] },
      commits: [
        renovateCommit("renovate"),
        {
          author: { login: BOT },
          commit: { verification: { verified: true } },
          committer: { login: BOT },
          sha: HEAD,
        },
      ],
      pullFiles: [
        ...lockFiles,
        ...lockFiles.map((path) =>
          path.replace("devcontainer-lock.json", "devcontainer.json")
        ),
        "README.md",
      ],
    });

    expect(failedCondition(await run(github))).toMatchObject({
      condition: "commits",
      passed: false,
    });
    expect(
      github.routes.filter(
        (route) => route === `GET /repos/publira/agents/commits/${HEAD}`
      )
    ).toHaveLength(2);
  });

  it("refuses the bot's commit of more than the lock file", async () => {
    const github = fakeGitHub({
      commitFiles: {
        [HEAD]: [".devcontainer/devcontainer-lock.json", "README.md"],
      },
      commits: [
        renovateCommit("renovate"),
        {
          author: { login: BOT },
          commit: { verification: { verified: true } },
          committer: { login: BOT },
          sha: HEAD,
        },
      ],
      pullFiles: [
        ".devcontainer/devcontainer-lock.json",
        ".devcontainer/devcontainer.json",
        "README.md",
      ],
    });

    expect(failedCondition(await run(github))).toStrictEqual({
      condition: "commits",
      detail: `commit ${HEAD.slice(0, 7)} changes more than either the Dev Container lock files beside the configurations the pull request changes or the generated output the repository declares`,
      passed: false,
    });
  });

  describe("with the bot's commit of regenerated output", () => {
    const regenerationCommit = {
      author: { login: BOT },
      commit: { verification: { verified: true } },
      committer: { login: BOT },
      sha: HEAD,
    };
    const scenario = {
      commitFiles: { [HEAD]: ["server/internal/proto/gen/api.pb.go"] },
      commits: [renovateCommit("renovate"), regenerationCommit],
      pullFiles: ["buf.gen.yaml", "server/internal/proto/gen/api.pb.go"],
    };

    it("accepts it within the paths the base branch declares", async () => {
      const result = await run(
        fakeGitHub({
          ...scenario,
          regenerationConfig:
            "triggers: [buf.gen.yaml]\ncommand: task gen\npaths: [server/internal/proto/gen/**]\n",
        })
      );

      expect(result).toMatchObject({ status: "approved" });
      expect(
        result.status === "approved"
          ? result.conditions.find(({ condition }) => condition === "commits")
          : undefined
      ).toStrictEqual({
        condition: "commits",
        detail:
          "Renovate made 1 commit(s), and the maintenance bot 1 regenerating the generated output, all signed by GitHub",
        passed: true,
      });
    });

    it.each([
      ["no declaration", undefined],
      [
        "other paths declared",
        "triggers: [buf.gen.yaml]\ncommand: task gen\npaths: [server/internal/db/gen/**]\n",
      ],
      ["an invalid declaration", "command: task gen\n"],
    ])("refuses it with %s", async (_, regenerationConfig) => {
      expect(
        failedCondition(
          await run(fakeGitHub({ ...scenario, regenerationConfig }))
        )
      ).toMatchObject({ condition: "commits", passed: false });
    });
  });

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
      outdatedReviews: { minimized: 0 },
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

  it("minimizes its earlier reviews of other heads once it approved the head", async () => {
    const github = fakeGitHub({
      reviewNodes: [
        reviewNode("PRR_dismissed", "8775efa", { state: "DISMISSED" }),
        reviewNode("PRR_maintainer", "8775efa", {
          author: { __typename: "User", login: "ykzts" },
        }),
        reviewNode("PRR_hidden", "0c9d676", { isMinimized: true }),
        reviewNode("PRR_head", HEAD),
      ],
    });

    const result = await run(github);

    expect(result).toMatchObject({
      outdatedReviews: { minimized: 1 },
      status: "approved",
    });
    expect(github.minimized).toStrictEqual(["PRR_dismissed"]);
  });

  it("keeps the approval when minimizing the earlier reviews fails", async () => {
    const github = fakeGitHub({
      minimizeRefused: true,
      reviewNodes: [reviewNode("PRR_dismissed", "8775efa")],
    });

    const result = await run(github);

    expect(result).toMatchObject({
      outdatedReviews: {
        error: expect.stringContaining("Resource not accessible"),
      },
      review: { created: true, id: 99 },
      status: "approved",
    });
  });

  it("names the precedent and the updates in the review", async () => {
    const github = fakeGitHub();

    await run(github);

    expect(github.writes[1]?.body).toMatchObject({
      body: expect.stringMatching(
        /publira\/website#120.*`npm:npm:turbo:2\.11\.5->2\.11\.6:patch`.*ykzts approved the head it was merged at/su
      ),
    });
    expect(github.writes[1]?.body).not.toMatchObject({
      body: expect.stringContaining("another manager"),
    });
  });

  it("approves the same update made through another manager, and names both", async () => {
    const github = fakeGitHub({
      precedents: [
        precedentPull({ body: renovateBody({ ...turbo, manager: "bun" }) }),
      ],
    });

    const result = await run(github);

    expect(result).toMatchObject({ status: "approved" });
    expect(github.writes[1]?.body).toMatchObject({
      body: expect.stringMatching(
        /`npm:npm:turbo:2\.11\.5->2\.11\.6:patch`\n\npublira\/website#120 made it through another manager:\n\n- `bun:npm:turbo:2\.11\.5->2\.11\.6:patch`/u
      ),
    });
  });

  it.each([
    ["from-version", { currentVersion: "2.11.4" }],
    ["target version", { newVersion: "2.11.7" }],
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
    expect(github.minimized).toStrictEqual([]);
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

  it("leaves the earlier reviews to the run that submitted the approval", async () => {
    const github = fakeGitHub({
      ownReviewsLater: [
        { commit_id: HEAD, id: 99, state: "APPROVED", user: { login: BOT } },
      ],
      reviewNodes: [reviewNode("PRR_dismissed", "8775efa")],
    });

    const result = await run(github);

    expect(result).toMatchObject({
      review: { created: false, id: 99 },
      status: "approved",
    });
    expect(result).not.toHaveProperty("outdatedReviews");
    expect(github.minimized).toStrictEqual([]);
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
    const github = fakeGitHub({
      reviewNodes: [reviewNode("PRR_dismissed", "8775efa")],
    });

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
    expect(github.minimized).toStrictEqual([]);
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
