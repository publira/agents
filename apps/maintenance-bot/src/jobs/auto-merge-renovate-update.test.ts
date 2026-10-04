import { createGitHubClient } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import type { approveEquivalentRenovateUpdate } from "./approve-equivalent-renovate-update.ts";
import { autoMergeRenovateUpdate } from "./auto-merge-renovate-update.ts";

const BOT = "publira-maintenance[bot]";
const HEAD = "4658aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EARLIER_HEAD = "c0ffee0000000000000000000000000000000000";
const APPROVED_AT = "2026-10-04T06:00:00Z";
const PR_ID = "PR_kwDOU27Aos8AAAABGh_KFA";

type Json = boolean | number | string | null | readonly Json[] | JsonObject;

interface JsonObject {
  readonly [key: string]: Json | undefined;
}

const botActor = { __typename: "Bot", login: "publira-maintenance" };

const ownApproval = (fields: JsonObject = {}) => ({
  commit_id: HEAD,
  id: 7,
  state: "APPROVED",
  submitted_at: APPROVED_AT,
  user: { login: BOT },
  ...fields,
});

const pullRequestRule = (fields: JsonObject = {}) => ({
  parameters: {
    allowed_merge_methods: ["squash"],
    dismiss_stale_reviews_on_push: true,
    required_approving_review_count: 1,
    ...fields,
  },
  type: "pull_request",
});

interface Scenario {
  pullRequest?: JsonObject;
  repository?: JsonObject;
  reviews?: readonly JsonObject[];
  files?: readonly JsonObject[];
  rules?: readonly JsonObject[];
  /** What enabling auto-merge answers: GraphQL errors, or `null` to succeed. */
  enableErrors?: readonly string[] | null;
  /** What merging through the REST API answers. */
  mergeResponse?: Response;
}

// Answers the GitHub API for publira/agents#31, a Renovate pull request the
// bot approved at its head.
const fakeGitHub = ({
  pullRequest = {},
  repository = {},
  reviews = [ownApproval()],
  files = [{ filename: "package.json" }, { filename: "pnpm-lock.yaml" }],
  rules = [pullRequestRule()],
  enableErrors = null,
  mergeResponse = Response.json({ merged: true }),
}: Scenario = {}) => {
  const mutations: { name: string; variables: unknown }[] = [];
  const writes: { route: string; body: unknown }[] = [];
  const routes: string[] = [];

  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${decodeURIComponent(url.pathname)}`;
    const body =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    routes.push(route);

    const respond = (): Json | Response | undefined => {
      if (route === "POST /graphql") {
        const mutation = /^\s*mutation[^{]*\{\s*(?<name>\w+)/u.exec(body.query)
          ?.groups?.name;

        if (mutation === undefined) {
          return {
            data: {
              repository: {
                autoMergeAllowed: true,
                mergeCommitAllowed: false,
                pullRequest: {
                  autoMergeRequest: null,
                  baseRefName: "main",
                  headRefOid: HEAD,
                  id: PR_ID,
                  mergeQueueEntry: null,
                  mergeStateStatus: "CLEAN",
                  state: "OPEN",
                  ...pullRequest,
                },
                rebaseMergeAllowed: false,
                squashMergeAllowed: true,
                ...repository,
              },
            },
          };
        }
        mutations.push({ name: mutation, variables: body.variables });
        if (mutation === "enablePullRequestAutoMerge" && enableErrors) {
          return {
            data: null,
            errors: enableErrors.map((message) => ({ message })),
          };
        }
        return { data: { [mutation]: { clientMutationId: null } } };
      }
      if (method !== "GET") {
        writes.push({ body, route });
      }
      switch (route) {
        case "GET /repos/publira/agents/pulls/31/reviews": {
          return reviews;
        }
        case "GET /repos/publira/agents/pulls/31/files": {
          return files;
        }
        case "GET /repos/publira/agents/rules/branches/main": {
          return rules;
        }
        case "PUT /repos/publira/agents/pulls/31/merge": {
          return mergeResponse;
        }
        default: {
          return undefined;
        }
      }
    };

    const result =
      respond() ?? Response.json({ message: "Not Found" }, { status: 404 });
    const response =
      result instanceof Response ? result : Response.json(result);
    // The pagination plugin reads the URL of the response.
    Object.defineProperty(response, "url", { value: url.href });
    return Promise.resolve(response);
  });

  return {
    /** The GraphQL mutations, by name, in order. */
    mutations,
    octokit: createGitHubClient({ fetch: fetchImpl }),
    routes,
    writes,
  };
};

const approvable = vi.fn<typeof approveEquivalentRenovateUpdate>(() =>
  Promise.resolve({
    body: "",
    conditions: [],
    headSha: HEAD,
    precedent: {
      approvedBy: "ykzts",
      mergedAt: new Date("2026-10-04T05:47:28Z"),
      number: 120,
      owner: "publira",
      repo: "website",
      url: "https://github.com/publira/website/pull/120",
    },
    status: "would-approve",
  })
);

const run = (
  github: ReturnType<typeof fakeGitHub>,
  options: Partial<Parameters<typeof autoMergeRenovateUpdate>[0]> = {}
) =>
  autoMergeRenovateUpdate({
    approve: approvable,
    enabled: true,
    octokit: github.octokit,
    owner: "publira",
    pullNumber: 31,
    repo: "agents",
    reviewer: BOT,
    ...options,
  });

const ownAutoMerge = (enabledAt: string) => ({
  autoMergeRequest: { enabledAt, enabledBy: botActor },
});

describe(autoMergeRenovateUpdate, () => {
  it("enables auto-merge for the head it decided on", async () => {
    const github = fakeGitHub({ pullRequest: { mergeStateStatus: "BLOCKED" } });

    const result = await run(github);

    expect(result).toStrictEqual({
      headSha: HEAD,
      mergeMethod: "SQUASH",
      status: "enabled",
      withdrew: undefined,
    });
    expect(github.mutations).toStrictEqual([
      {
        name: "enablePullRequestAutoMerge",
        variables: {
          expectedHeadOid: HEAD,
          mergeMethod: "SQUASH",
          pullRequestId: PR_ID,
        },
      },
    ]);
  });

  it("evaluates the approval policy again, as a dry run", async () => {
    const github = fakeGitHub();

    await run(github);

    expect(approvable).toHaveBeenLastCalledWith(
      expect.objectContaining({ dryRun: true, pullNumber: 31 })
    );
  });

  it("does nothing while it is off and the bot enabled nothing", async () => {
    const github = fakeGitHub();

    await expect(run(github, { enabled: false })).resolves.toStrictEqual({
      headSha: HEAD,
      status: "disabled",
    });
    expect(github.routes).toStrictEqual(["POST /graphql"]);
  });

  it("takes back its auto-merge once it is off", async () => {
    const github = fakeGitHub({
      pullRequest: ownAutoMerge("2026-10-04T06:00:01Z"),
    });

    const result = await run(github, { enabled: false });

    expect(result).toMatchObject({
      reason: "auto-merge is disabled",
      status: "withdrawn",
    });
    expect(github.mutations.map(({ name }) => name)).toStrictEqual([
      "disablePullRequestAutoMerge",
    ]);
  });

  it("keeps its auto-merge for the head it decided on", async () => {
    const github = fakeGitHub({
      pullRequest: ownAutoMerge("2026-10-04T06:00:01Z"),
    });

    await expect(run(github)).resolves.toStrictEqual({
      headSha: HEAD,
      status: "pending",
    });
    expect(github.mutations).toStrictEqual([]);
  });

  it("takes back its auto-merge once the approval policy no longer holds", async () => {
    const github = fakeGitHub({
      pullRequest: ownAutoMerge("2026-10-04T06:00:01Z"),
    });

    const result = await run(github, {
      approve: () =>
        Promise.resolve({
          conditions: [
            {
              condition: "description",
              detail:
                "someone edited the description last; Renovate rewrites it on its next run",
              passed: false,
            },
          ],
          headSha: HEAD,
          status: "skipped",
        }),
    });

    expect(result).toMatchObject({
      reason: expect.stringContaining(
        "the approval policy does not hold: description: someone edited"
      ),
      status: "declined",
      withdrew: expect.stringMatching(/^the decision no longer holds: /u),
    });
    expect(github.mutations.map(({ name }) => name)).toStrictEqual([
      "disablePullRequestAutoMerge",
    ]);
  });

  it("only tells a dry run that it would take back its auto-merge", async () => {
    const github = fakeGitHub({
      pullRequest: {
        ...ownAutoMerge("2026-10-04T06:00:01Z"),
        mergeStateStatus: "DIRTY",
      },
    });

    await expect(run(github, { dryRun: true })).resolves.toMatchObject({
      reason: "it has conflicts",
      status: "declined",
      withdrew: "the decision no longer holds: it has conflicts",
    });
    expect(github.mutations).toStrictEqual([]);
  });

  it("takes back its auto-merge when the head moved and is not approved", async () => {
    const github = fakeGitHub({
      pullRequest: ownAutoMerge("2026-10-04T06:00:01Z"),
      reviews: [ownApproval({ commit_id: EARLIER_HEAD })],
    });

    const result = await run(github);

    expect(result).toMatchObject({
      reason: "the bot's approval of 4658aaa does not stand",
      status: "declined",
      withdrew: "the bot's approval of the head 4658aaa does not stand",
    });
    expect(github.mutations.map(({ name }) => name)).toStrictEqual([
      "disablePullRequestAutoMerge",
    ]);
  });

  it("decides again when its auto-merge predates the approval of the head", async () => {
    const github = fakeGitHub({
      pullRequest: {
        ...ownAutoMerge("2026-10-04T05:00:00Z"),
        mergeStateStatus: "BLOCKED",
      },
    });

    const result = await run(github);

    expect(result).toMatchObject({
      status: "enabled",
      withdrew: "it was decided for an earlier head than 4658aaa",
    });
    expect(github.mutations.map(({ name }) => name)).toStrictEqual([
      "disablePullRequestAutoMerge",
      "enablePullRequestAutoMerge",
    ]);
  });

  it("takes back its stale queue entry", async () => {
    const github = fakeGitHub({
      pullRequest: {
        mergeQueueEntry: {
          enqueuedAt: "2026-10-04T05:00:00Z",
          enqueuer: botActor,
        },
      },
    });

    const result = await run(github, { dryRun: true });

    expect(result).toMatchObject({
      status: "would-merge",
      withdrew: "it was decided for an earlier head than 4658aaa",
    });
    expect(github.mutations).toStrictEqual([]);
  });

  it("leaves someone else's auto-merge as it is", async () => {
    const github = fakeGitHub({
      pullRequest: {
        autoMergeRequest: {
          enabledAt: "2026-10-04T06:00:01Z",
          enabledBy: { __typename: "User", login: "ykzts" },
        },
      },
    });

    await expect(run(github, { enabled: false })).resolves.toStrictEqual({
      headSha: HEAD,
      status: "disabled",
    });
    await expect(run(github)).resolves.toMatchObject({
      reason: "ykzts already enabled auto-merge",
      status: "declined",
    });
    expect(github.mutations).toStrictEqual([]);
  });

  it("declines a head the bot has not approved, without evaluating it", async () => {
    const github = fakeGitHub({
      reviews: [ownApproval({ state: "DISMISSED" })],
    });
    approvable.mockClear();

    await expect(run(github)).resolves.toMatchObject({
      reason: "the bot's approval of 4658aaa does not stand",
      status: "declined",
    });
    expect(approvable).not.toHaveBeenCalled();
  });

  it("declines when the approval policy no longer holds", async () => {
    const github = fakeGitHub();

    const result = await run(github, {
      approve: () =>
        Promise.resolve({
          conditions: [
            {
              condition: "author",
              detail: "opened by renovate[bot]",
              passed: true,
            },
            { condition: "checks", detail: "failed: Test", passed: false },
          ],
          headSha: HEAD,
          status: "skipped",
        }),
    });

    expect(result).toMatchObject({
      reason: "the approval policy does not hold: checks: failed: Test",
      status: "declined",
    });
    expect(github.mutations).toStrictEqual([]);
  });

  it.each([
    [
      "a conflicted pull request",
      { pullRequest: { mergeStateStatus: "DIRTY" } },
      "it has conflicts",
    ],
    [
      "a change to the workflows",
      { files: [{ filename: ".github/workflows/ci.yml" }] },
      "it changes .github/workflows/, which the App cannot merge without the Workflows permission",
    ],
    [
      "a branch whose approval survives a push",
      { rules: [pullRequestRule({ dismiss_stale_reviews_on_push: false })] },
      "the base branch's rulesets do not require an approval that a push dismisses, so GitHub would not hold back a new head",
    ],
    [
      "a branch without a ruleset requiring an approval",
      { rules: [] },
      "the base branch's rulesets do not require an approval that a push dismisses, so GitHub would not hold back a new head",
    ],
    [
      "a repository without auto-merge",
      { repository: { autoMergeAllowed: false } },
      "the repository does not allow auto-merge",
    ],
  ] as const)("declines %s", async (_, scenario, reason) => {
    const github = fakeGitHub(scenario);

    await expect(run(github)).resolves.toMatchObject({
      reason,
      status: "declined",
    });
    expect(github.mutations).toStrictEqual([]);
    expect(github.writes).toStrictEqual([]);
  });

  it("queues a pull request GitHub can merge already", async () => {
    const github = fakeGitHub({
      enableErrors: ["Pull request Pull request is in clean status"],
      rules: [pullRequestRule(), { type: "merge_queue" }],
    });

    await expect(run(github)).resolves.toMatchObject({ status: "enqueued" });
    expect(github.mutations.at(-1)).toStrictEqual({
      name: "enqueuePullRequest",
      variables: { expectedHeadOid: HEAD, pullRequestId: PR_ID },
    });
  });

  it("merges a pull request GitHub can merge already at the head only", async () => {
    const github = fakeGitHub({
      enableErrors: ["Pull request Pull request is in clean status"],
    });

    await expect(run(github)).resolves.toMatchObject({
      mergeMethod: "SQUASH",
      status: "merged",
    });
    expect(github.writes).toStrictEqual([
      {
        body: { merge_method: "squash", sha: HEAD },
        route: "PUT /repos/publira/agents/pulls/31/merge",
      },
    ]);
  });

  it("records GitHub's reason when it refuses", async () => {
    const github = fakeGitHub({
      enableErrors: ["Head sha didn't match expected head sha"],
    });

    await expect(run(github)).resolves.toMatchObject({
      reason: "Head sha didn't match expected head sha",
      status: "refused",
    });
  });

  it("records GitHub's reason when it refuses the merge", async () => {
    const github = fakeGitHub({
      enableErrors: ["Pull request Pull request is in clean status"],
      mergeResponse: Response.json(
        {
          message: "Head branch was modified. Review and try the merge again.",
        },
        { status: 409 }
      ),
    });

    await expect(run(github)).resolves.toMatchObject({
      reason: "Head branch was modified. Review and try the merge again.",
      status: "refused",
    });
  });

  it("explains a dry run without writing", async () => {
    const github = fakeGitHub({
      rules: [pullRequestRule(), { type: "merge_queue" }],
    });

    await expect(run(github, { dryRun: true })).resolves.toStrictEqual({
      headSha: HEAD,
      mergeMethod: "SQUASH",
      mergeQueue: true,
      status: "would-merge",
      withdrew: undefined,
    });
    expect(github.mutations).toStrictEqual([]);
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves a closed pull request alone", async () => {
    const github = fakeGitHub({ pullRequest: { state: "MERGED" } });

    await expect(run(github)).resolves.toStrictEqual({
      headSha: HEAD,
      status: "closed",
    });
  });
});
