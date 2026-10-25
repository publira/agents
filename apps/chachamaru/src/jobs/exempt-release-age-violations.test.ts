import { createGitHubClient } from "@publira/github";
import { formatReleaseAgeExemptionMarker } from "@publira/maintenance-policies";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  approveReleaseAgeExemption,
  askReleaseAgeExemption,
  minimizeOutdatedReleaseAgeQuestions,
  summarizeReleaseAgeExemptionResult,
} from "./exempt-release-age-violations.ts";

const BOT = "chachamaru-bot[bot]";
const HEAD = "4658aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_HEAD = "1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BRANCH = "renovate/playwright-monorepo";
const REPOSITORY = "/repos/publira/publira";
const NOW = new Date("2026-10-08T09:00:00.000Z");

const APPROVAL_URL =
  "https://github.com/publira/publira/pull/3949#issuecomment-50";

const WORKSPACE = `packages:
  - apps/*
minimumReleaseAgeExclude:
  - "@publira/*"
`;

const violations = [
  {
    name: "@playwright/test",
    publishedAt: new Date("2026-10-07T18:02:39.953Z"),
    version: "1.64.0",
  },
  {
    name: "playwright",
    publishedAt: new Date("2026-10-07T18:01:58.238Z"),
    version: "1.64.0",
  },
];

const entries = [
  {
    availableAt: new Date("2026-10-08T18:02:39.953Z"),
    selector: "@playwright/test@1.64.0",
  },
  {
    availableAt: new Date("2026-10-08T18:01:58.238Z"),
    selector: "playwright@1.64.0",
  },
];

const question = (head = HEAD, approved = false) =>
  [
    formatReleaseAgeExemptionMarker(head, entries),
    "pnpm refuses to install it.",
    ...(approved
      ? [
          `<!-- chachamaru-release-age-exemption-approval url=${APPROVAL_URL} -->`,
        ]
      : []),
  ].join("\n");

interface Comment {
  id: number;
  body: string;
  author: string;
}

interface Scenario {
  head?: string;
  user?: { login: string; type: string };
  state?: string;
  workspace?: string | null;
  comments?: Comment[];
  permissions?: Record<string, string>;
  moved?: boolean;
}

const graphqlRequest = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()),
});

const requestBody = z.record(z.string(), z.unknown()).optional();

type RequestBody = z.infer<typeof requestBody>;

// Answers the GitHub API for publira/publira#3949 and records the writes.
const fakeGitHub = ({
  head: initialHead = HEAD,
  user = { login: "renovate[bot]", type: "Bot" },
  state = "open",
  workspace = WORKSPACE,
  comments: initial = [],
  permissions = { ykzts: "admin" },
  moved = false,
}: Scenario = {}) => {
  const comments = initial.map((comment) => ({ ...comment }));
  const minimized = new Set<number>();
  const writes: { route: string; body: unknown }[] = [];
  let tree: unknown;
  // The pull request's head, until the job's commit moves it.
  let head = initialHead;

  const respond = (route: string, body: RequestBody): Response => {
    switch (route) {
      case `GET ${REPOSITORY}/pulls/3949`: {
        return Response.json({
          base: { repo: { full_name: "publira/publira", private: false } },
          head: {
            ref: BRANCH,
            repo: { full_name: "publira/publira" },
            sha: head,
          },
          number: 3949,
          state,
          user,
        });
      }

      case `GET ${REPOSITORY}/contents/pnpm-workspace.yaml`: {
        return workspace === null
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json({
              content: Buffer.from(workspace).toString("base64"),
              encoding: "base64",
              type: "file",
            });
      }

      case `GET ${REPOSITORY}/issues/3949/comments`: {
        return Response.json(
          comments.map(({ id, body: text, author }) => ({
            body: text,
            id,
            user: { login: author },
          }))
        );
      }

      case `POST ${REPOSITORY}/issues/3949/comments`: {
        const posted = {
          author: BOT,
          body: z.object({ body: z.string() }).parse(body).body,
          id: 100 + comments.length,
        };

        comments.push(posted);

        return Response.json({ id: posted.id });
      }

      case `GET ${REPOSITORY}/git/commits/${head}`: {
        return Response.json({ sha: head, tree: { sha: "head-tree" } });
      }

      case `POST ${REPOSITORY}/git/trees`: {
        tree = body;

        return Response.json({ sha: "new-tree" });
      }

      case `POST ${REPOSITORY}/git/commits`: {
        return Response.json({ sha: "new-commit" });
      }

      case `PATCH ${REPOSITORY}/git/refs/heads/${BRANCH}`: {
        if (moved) {
          return Response.json(
            { message: "Update is not a fast forward" },
            { status: 422 }
          );
        }

        head = "new-commit";

        return Response.json({});
      }

      case "POST /graphql": {
        const { query, variables } = graphqlRequest.parse(body);

        if (query.includes("minimizeComment")) {
          minimized.add(Number(String(variables.id).slice("IC_".length)));

          return Response.json({ data: { minimizeComment: {} } });
        }

        return Response.json({
          data: {
            repository: {
              issueOrPullRequest: {
                comments: {
                  nodes: comments.map(({ id, body: text, author }) => ({
                    author: {
                      __typename: author.endsWith("[bot]") ? "Bot" : "User",
                      login: author.replace(/\[bot\]$/u, ""),
                    },
                    body: text,
                    fullDatabaseId: String(id),
                    id: `IC_${id}`,
                    isMinimized: minimized.has(id),
                  })),
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          },
        });
      }

      default: {
        const permission = /\/collaborators\/(?<user>[^/]+)\/permission$/u.exec(
          route
        )?.groups?.user;

        if (permission !== undefined) {
          return permissions[permission] === undefined
            ? Response.json({ message: "Not Found" }, { status: 404 })
            : Response.json({ permission: permissions[permission] });
        }

        const updated = /^PATCH .*\/issues\/comments\/(?<id>\d+)$/u.exec(route)
          ?.groups?.id;

        const comment = comments.find(({ id }) => String(id) === updated);

        if (comment !== undefined) {
          comment.body = z.object({ body: z.string() }).parse(body).body;

          return Response.json({ id: comment.id });
        }

        return Response.json({ message: "Not Found" }, { status: 404 });
      }
    }
  };

  const octokit = createGitHubClient({
    fetch: (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const route = `${method} ${decodeURIComponent(url.pathname)}`;

      const body = requestBody.parse(
        init?.body === undefined ? undefined : JSON.parse(String(init.body))
      );

      if (method !== "GET" && route !== "POST /graphql") {
        writes.push({ body, route });
      } else if (
        route === "POST /graphql" &&
        String(body?.query).includes("minimizeComment")
      ) {
        writes.push({ body: body?.variables, route: "minimize" });
      }

      const response = respond(route, body);
      Object.defineProperty(response, "url", { value: url.href });

      return Promise.resolve(response);
    },
  });

  return {
    comments,
    minimized,
    octokit,
    tree: () => tree,
    writes,
  };
};

const location = {
  botLogin: BOT,
  now: NOW,
  owner: "publira",
  pullNumber: 3949,
  repo: "publira",
};

const reading = { result: "violations" as const, violations };

const EXEMPTED = `packages:
  - apps/*
minimumReleaseAgeExclude:
  - "@publira/*"
  # Exempted for #3949, a Renovate update, on a maintainer's approval:
  # ${APPROVAL_URL}
  - "@playwright/test@1.64.0"
  - playwright@1.64.0
`;

describe(askReleaseAgeExemption, () => {
  it("asks once for the head, naming the entries and how to approve", async () => {
    const github = fakeGitHub({
      comments: [{ author: BOT, body: question(OLD_HEAD), id: 10 }],
    });

    await expect(
      askReleaseAgeExemption({
        ...location,
        headSha: HEAD,
        octokit: github.octokit,
        reading,
      })
    ).resolves.toStrictEqual({
      comment: { created: true, id: 101 },
      entries: ["@playwright/test@1.64.0", "playwright@1.64.0"],
      headSha: HEAD,
      outdatedQuestions: { minimized: 1 },
      status: "asked",
    });

    const posted = github.comments.at(-1)?.body ?? "";
    expect(posted).toContain(formatReleaseAgeExemptionMarker(HEAD, entries));
    expect(posted).toContain(
      "| `@playwright/test@1.64.0` | 2026-10-08T18:02:39.953Z |"
    );
    expect(posted).toContain("`@chachamaru-bot add`");
    expect([...github.minimized]).toStrictEqual([10]);
  });

  it("asks nothing again for a head it asked about", async () => {
    const github = fakeGitHub({
      comments: [{ author: BOT, body: question(), id: 10 }],
    });

    await expect(
      askReleaseAgeExemption({
        ...location,
        headSha: HEAD,
        octokit: github.octokit,
        reading,
      })
    ).resolves.toMatchObject({
      comment: { created: false, id: 10 },
      status: "asked",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("only logs the question in a dry run", async () => {
    const github = fakeGitHub();

    await expect(
      askReleaseAgeExemption({
        ...location,
        dryRun: true,
        headSha: HEAD,
        octokit: github.octokit,
        reading,
      })
    ).resolves.toStrictEqual({
      entries: ["@playwright/test@1.64.0", "playwright@1.64.0"],
      headSha: HEAD,
      status: "would-ask",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("commits the entries a maintainer approved for the same versions", async () => {
    const github = fakeGitHub({
      comments: [{ author: BOT, body: question(OLD_HEAD, true), id: 10 }],
    });

    await expect(
      askReleaseAgeExemption({
        ...location,
        headSha: HEAD,
        octokit: github.octokit,
        reading,
      })
    ).resolves.toStrictEqual({
      approvedIn: APPROVAL_URL,
      commitSha: "new-commit",
      entries: ["@playwright/test@1.64.0", "playwright@1.64.0"],
      headSha: HEAD,
      outdatedQuestions: { minimized: 1 },
      status: "committed",
    });
    expect(github.tree()).toMatchObject({
      tree: [{ content: EXEMPTED, path: "pnpm-workspace.yaml" }],
    });
    expect(github.writes).toContainEqual({
      body: expect.objectContaining({
        message: expect.stringMatching(
          /^chore\(deps\): exempt @playwright\/test, playwright from minimumReleaseAge\n\n/u
        ),
        parents: [HEAD],
      }),
      route: `POST ${REPOSITORY}/git/commits`,
    });
  });

  it("asks again when an approval does not cover every version", async () => {
    const github = fakeGitHub({
      comments: [{ author: BOT, body: question(OLD_HEAD, true), id: 10 }],
    });

    await expect(
      askReleaseAgeExemption({
        ...location,
        headSha: HEAD,
        octokit: github.octokit,
        reading: {
          result: "violations",
          violations: [
            ...violations,
            {
              name: "playwright-core",
              publishedAt: new Date("2026-10-07T18:01:13.306Z"),
              version: "1.64.0",
            },
          ],
        },
      })
    ).resolves.toMatchObject({ status: "asked" });
  });

  it("ignores an approval someone else wrote into a comment", async () => {
    const github = fakeGitHub({
      comments: [{ author: "ykzts", body: question(OLD_HEAD, true), id: 10 }],
    });

    await expect(
      askReleaseAgeExemption({
        ...location,
        dryRun: true,
        headSha: HEAD,
        octokit: github.octokit,
        reading,
      })
    ).resolves.toMatchObject({ status: "would-ask" });
  });

  it.each([
    [
      "an output it cannot read",
      { reading: { reason: "unreadable", result: "unreadable" as const } },
      {},
      "unreadable",
    ],
    ["a head that moved", { headSha: OLD_HEAD }, {}, "the head moved"],
    [
      "a head without pnpm-workspace.yaml",
      {},
      { workspace: null },
      "the head has no pnpm-workspace.yaml",
    ],
    [
      "versions past the window",
      { now: new Date("2026-10-09T00:00:00.000Z") },
      {},
      "no refused version needs an entry any more",
    ],
  ])("skips %s", async (_label, overrides, scenario, reason) => {
    const github = fakeGitHub(scenario);

    await expect(
      askReleaseAgeExemption({
        ...location,
        headSha: HEAD,
        octokit: github.octokit,
        reading,
        ...overrides,
      })
    ).resolves.toMatchObject({ reason, status: "skipped" });
    expect(github.writes).toStrictEqual([]);
  });
});

const approval = (body = "@chachamaru-bot add", author = "ykzts") => ({
  author,
  body,
  id: 50,
  url: APPROVAL_URL,
});

describe(approveReleaseAgeExemption, () => {
  it("records the approval and commits the entries on top of the head", async () => {
    const github = fakeGitHub({
      comments: [{ author: BOT, body: question(), id: 10 }],
    });

    await expect(
      approveReleaseAgeExemption({
        ...location,
        comment: approval(),
        octokit: github.octokit,
      })
    ).resolves.toStrictEqual({
      approvedIn: APPROVAL_URL,
      commitSha: "new-commit",
      entries: ["@playwright/test@1.64.0", "playwright@1.64.0"],
      headSha: HEAD,
      outdatedQuestions: { minimized: 1 },
      status: "committed",
    });

    expect(github.comments[0]?.body).toBe(
      `${question()}\n\n<!-- chachamaru-release-age-exemption-approval url=${APPROVAL_URL} -->\nApproved in ${APPROVAL_URL}.`
    );
    expect(github.tree()).toMatchObject({
      tree: [{ content: EXEMPTED, path: "pnpm-workspace.yaml" }],
    });
    expect(github.writes.map(({ route }) => route)).toStrictEqual([
      `PATCH ${REPOSITORY}/issues/comments/10`,
      `POST ${REPOSITORY}/git/trees`,
      `POST ${REPOSITORY}/git/commits`,
      `PATCH ${REPOSITORY}/git/refs/heads/${BRANCH}`,
      "minimize",
    ]);
  });

  it("only logs the commit in a dry run", async () => {
    const github = fakeGitHub({
      comments: [{ author: BOT, body: question(), id: 10 }],
    });

    await expect(
      approveReleaseAgeExemption({
        ...location,
        comment: approval(),
        dryRun: true,
        octokit: github.octokit,
      })
    ).resolves.toStrictEqual({
      approvedIn: APPROVAL_URL,
      entries: ["@playwright/test@1.64.0", "playwright@1.64.0"],
      headSha: HEAD,
      status: "would-commit",
      subject:
        "chore(deps): exempt @playwright/test, playwright from minimumReleaseAge",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("leaves a branch that moved meanwhile", async () => {
    const github = fakeGitHub({
      comments: [{ author: BOT, body: question(), id: 10 }],
      moved: true,
    });

    await expect(
      approveReleaseAgeExemption({
        ...location,
        comment: approval(),
        octokit: github.octokit,
      })
    ).resolves.toMatchObject({ status: "head-moved" });
  });

  it("commits only the entries still needed", async () => {
    const github = fakeGitHub({
      comments: [{ author: BOT, body: question(), id: 10 }],
      workspace: `${WORKSPACE}  - playwright@1.64.0\n`,
    });

    await expect(
      approveReleaseAgeExemption({
        ...location,
        comment: approval(),
        dryRun: true,
        octokit: github.octokit,
      })
    ).resolves.toMatchObject({
      entries: ["@playwright/test@1.64.0"],
      status: "would-commit",
    });
  });

  it.each([
    [
      "the bot's own comment",
      { comment: approval("@chachamaru-bot add", BOT) },
      {},
      "the comment is the bot's own",
    ],
    [
      "a comment without the mention",
      { comment: approval("add them") },
      {},
      "the comment does not mention @chachamaru-bot and say to add",
    ],
    [
      "a comment by someone who cannot write",
      { comment: approval("@chachamaru-bot add", "someone") },
      { permissions: { someone: "read" } },
      "the author cannot write to the repository",
    ],
    [
      "a comment whose author's permission cannot be read",
      { comment: approval("@chachamaru-bot add", "someone") },
      {},
      "the author's permission on the repository cannot be read",
    ],
    [
      "a pull request Renovate did not open",
      {},
      { user: { login: "ykzts", type: "User" } },
      "Renovate did not open the pull request",
    ],
    [
      "a closed pull request",
      {},
      { state: "closed" },
      "the pull request is closed",
    ],
    [
      "a reply after the head changed",
      {},
      { comments: [{ author: BOT, body: question(OLD_HEAD), id: 10 }] },
      "no question of the bot for the head precedes the comment",
    ],
    [
      "a comment before the question",
      {},
      { comments: [{ author: BOT, body: question(), id: 60 }] },
      "no question of the bot for the head precedes the comment",
    ],
    [
      "a question whose window has passed",
      { now: new Date("2026-10-09T00:00:00.000Z") },
      { comments: [{ author: BOT, body: question(), id: 10 }] },
      "the entries the question asks for are no longer needed",
    ],
  ])("changes nothing for %s", async (_label, overrides, scenario, reason) => {
    const github = fakeGitHub(scenario);

    await expect(
      approveReleaseAgeExemption({
        ...location,
        comment: approval(),
        octokit: github.octokit,
        ...overrides,
      })
    ).resolves.toMatchObject({ reason, status: "skipped" });
    expect(github.writes).toStrictEqual([]);
  });
});

describe(minimizeOutdatedReleaseAgeQuestions, () => {
  it("minimizes the questions for other heads and past windows", async () => {
    const github = fakeGitHub({
      comments: [
        { author: BOT, body: question(OLD_HEAD), id: 10 },
        { author: BOT, body: question(), id: 11 },
        { author: "ykzts", body: question(OLD_HEAD), id: 12 },
      ],
    });

    await expect(
      minimizeOutdatedReleaseAgeQuestions({
        ...location,
        octokit: github.octokit,
      })
    ).resolves.toBe(1);
    expect([...github.minimized]).toStrictEqual([10]);

    await expect(
      minimizeOutdatedReleaseAgeQuestions({
        ...location,
        now: new Date("2026-10-09T00:00:00.000Z"),
        octokit: github.octokit,
      })
    ).resolves.toBe(1);
    expect([...github.minimized]).toStrictEqual([10, 11]);
  });
});

describe(summarizeReleaseAgeExemptionResult, () => {
  it("logs what was decided without a model", () => {
    expect(
      summarizeReleaseAgeExemptionResult({
        approvedIn: APPROVAL_URL,
        commitSha: "new-commit",
        entries: ["playwright@1.64.0"],
        headSha: HEAD,
        outdatedQuestions: { minimized: 1 },
        status: "committed",
      })
    ).toStrictEqual({
      approvedIn: APPROVAL_URL,
      comment: undefined,
      commentCreated: undefined,
      commit: "new-commit",
      entries: ["playwright@1.64.0"],
      headSha: HEAD,
      minimizedComments: 1,
      modelInvoked: false,
      reason: undefined,
      status: "committed",
      subject: undefined,
    });
  });
});
