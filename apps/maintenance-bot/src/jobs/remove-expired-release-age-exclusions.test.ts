import { createGitHubClient } from "@publira/github";
import type { GitHubApp } from "@publira/github";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Log } from "../log.ts";
import {
  CLEANUP_BRANCH,
  removeExpiredReleaseAgeExclusions,
  removeExpiredReleaseAgeExclusionsEverywhere,
} from "./remove-expired-release-age-exclusions.ts";
import type { ExclusionEditor } from "./remove-expired-release-age-exclusions.ts";

// pnpm-workspace.yaml of publira/website after publira/website#113, cut down
// to two of the pinned @next/* packages.
const workspaceManifest = `allowBuilds:
  lefthook: true
minimumReleaseAgeExclude:
  - "@publira/*"
  # Next.js 16.3.8, the September 30, 2026 security release. Drop the pins
  # once the release is a day old.
  # https://nextjs.org/blog/september-2026-security-release
  - "@next/env@16.3.8"
  - next@16.3.8
`;

const cleanedManifest = `allowBuilds:
  lefthook: true
minimumReleaseAgeExclude:
  - "@publira/*"
`;

const nextPackument = { time: { "16.3.8": "2026-09-30T08:00:00.000Z" } };
const packuments = new Map([
  ["/@next%2fenv", nextPackument],
  ["/next", nextPackument],
]);

// Inside the one-day window, and past it.
const BEFORE_EXPIRY = new Date("2026-10-01T07:00:00.000Z");
const AFTER_EXPIRY = new Date("2026-10-01T09:00:00.000Z");

const repository = "/repos/publira/website";

const fileResponse = (content?: string) =>
  content === undefined
    ? Response.json({ message: "Not Found" }, { status: 404 })
    : Response.json({
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
        type: "file",
      });

interface FakeOptions {
  /** `null` when the repository has no pnpm-workspace.yaml. */
  manifest?: string | null;
  /** The open cleanup pull request and its version of the file. */
  openPullRequest?: string;
  /** The files the head commit of that pull request changes. */
  headFiles?: string[];
}

// Answers the GitHub API and the npm registry, and records the writes.
const fake = ({
  manifest = workspaceManifest,
  openPullRequest,
  headFiles = ["pnpm-workspace.yaml"],
}: FakeOptions = {}) => {
  const writes: { route: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${decodeURIComponent(url.pathname)}`;

    if (url.hostname === "registry.npmjs.org") {
      const packument = packuments.get(url.pathname);
      return Promise.resolve(
        packument === undefined
          ? new Response("Not Found", { status: 404 })
          : Response.json(packument)
      );
    }

    if (method !== "GET") {
      writes.push({ body: JSON.parse(String(init?.body)), route });
    }

    const responses = new Map<string, () => Response>([
      [`GET ${repository}`, () => Response.json({ default_branch: "main" })],
      [
        `GET ${repository}/branches/main`,
        () => Response.json({ commit: { sha: "base" } }),
      ],
      [
        `GET ${repository}/contents/pnpm-workspace.yaml`,
        () =>
          fileResponse(
            url.searchParams.get("ref") === "pull-head"
              ? openPullRequest
              : (manifest ?? undefined)
          ),
      ],
      [`GET ${repository}/contents/.npmrc`, () => fileResponse()],
      [
        `GET ${repository}/pulls`,
        () =>
          Response.json(
            openPullRequest === undefined
              ? []
              : [
                  {
                    body: "",
                    head: { sha: "pull-head" },
                    html_url: "https://github.com/publira/website/pull/120",
                    number: 120,
                    title: "",
                  },
                ]
          ),
      ],
      [
        `GET ${repository}/commits/pull-head`,
        () =>
          Response.json({
            files: headFiles.map((filename) => ({ filename })),
            parents: [{ sha: "older-base" }],
          }),
      ],
      [
        `GET ${repository}/git/commits/base`,
        () => Response.json({ tree: { sha: "base-tree" } }),
      ],
      [
        `GET ${repository}/git/ref/heads/${CLEANUP_BRANCH}`,
        () => Response.json({ message: "Not Found" }, { status: 404 }),
      ],
      [
        `POST ${repository}/git/trees`,
        () => Response.json({ sha: "new-tree" }),
      ],
      [
        `POST ${repository}/git/commits`,
        () => Response.json({ sha: "new-commit" }),
      ],
      [`POST ${repository}/git/refs`, () => Response.json({})],
      [`PATCH ${repository}/pulls/120`, () => Response.json({})],
      [
        `POST ${repository}/pulls`,
        () =>
          Response.json({
            html_url: "https://github.com/publira/website/pull/121",
            number: 121,
          }),
      ],
    ]);
    const respond = responses.get(route);

    return Promise.resolve(
      respond === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : respond()
    );
  });

  return {
    options: {
      octokit: createGitHubClient({ fetch: fetchImpl }),
      owner: "publira",
      registry: { fetch: fetchImpl },
      repo: "website",
    },
    /** The paths of every request, in order. */
    get paths() {
      return fetchImpl.mock.calls.map(
        ([input]) => new URL(String(input)).pathname
      );
    },
    writes,
  };
};

const pullRequestSchema = z.looseObject({ body: z.string() });
const commitSchema = z.looseObject({ message: z.string() });

const MODEL = "anthropic/claude-sonnet-5.5";

const neverCalled: ExclusionEditor = () =>
  Promise.reject(new Error("The editor must not be called"));

describe(removeExpiredReleaseAgeExclusions, () => {
  it("stops before the registry when nothing is pinned", async () => {
    const github = fake({
      manifest: 'minimumReleaseAgeExclude:\n  - "@publira/*"\n',
    });

    await expect(
      removeExpiredReleaseAgeExclusions({
        ...github.options,
        editor: neverCalled,
        now: AFTER_EXPIRY,
      })
    ).resolves.toStrictEqual({
      reports: [
        {
          selector: "@publira/*",
          verdict: { action: "keep", reason: "unpinned" },
        },
      ],
      status: "nothing-expired",
    });
    expect(github.paths).not.toContain("/next");
    expect(github.writes).toStrictEqual([]);
  });

  it("does nothing while the release is inside the window", async () => {
    const github = fake();

    await expect(
      removeExpiredReleaseAgeExclusions({
        ...github.options,
        editor: neverCalled,
        now: BEFORE_EXPIRY,
      })
    ).resolves.toMatchObject({ status: "nothing-expired" });
    expect(github.paths).not.toContain(`${repository}/pulls`);
    expect(github.writes).toStrictEqual([]);
  });

  it("does nothing in a repository without pnpm-workspace.yaml", async () => {
    const github = fake({ manifest: null });

    await expect(
      removeExpiredReleaseAgeExclusions({
        ...github.options,
        now: AFTER_EXPIRY,
      })
    ).resolves.toMatchObject({ status: "nothing-expired" });
  });

  it("opens a pull request that removes the expired block", async () => {
    const github = fake();

    const result = await removeExpiredReleaseAgeExclusions({
      ...github.options,
      editor: neverCalled,
      now: AFTER_EXPIRY,
    });

    expect(result).toStrictEqual({
      editedBy: "rules",
      expired: [
        {
          availableAt: new Date("2026-10-01T08:00:00.000Z"),
          selector: "@next/env@16.3.8",
        },
        {
          availableAt: new Date("2026-10-01T08:00:00.000Z"),
          selector: "next@16.3.8",
        },
      ],
      pullRequest: {
        created: true,
        number: 121,
        url: "https://github.com/publira/website/pull/121",
      },
      status: "pull-request",
    });
    expect(github.writes.map(({ route }) => route)).toStrictEqual([
      `POST ${repository}/git/trees`,
      `POST ${repository}/git/commits`,
      `POST ${repository}/git/refs`,
      `POST ${repository}/pulls`,
    ]);
    expect(github.writes[0]?.body).toMatchObject({
      base_tree: "base-tree",
      tree: [{ content: cleanedManifest, path: "pnpm-workspace.yaml" }],
    });
    expect(github.writes[2]?.body).toMatchObject({
      ref: `refs/heads/${CLEANUP_BRANCH}`,
    });
  });

  it("explains in the pull request why the entries can go", async () => {
    const github = fake();

    await removeExpiredReleaseAgeExclusions({
      ...github.options,
      now: AFTER_EXPIRY,
    });

    const pullRequest = pullRequestSchema.parse(github.writes[3]?.body);
    expect(pullRequest).toMatchObject({
      base: "main",
      head: CLEANUP_BRANCH,
      title: "chore(deps): remove expired minimumReleaseAgeExclude entries",
    });
    expect(pullRequest.body).toContain(
      "| `next@16.3.8` | 2026-10-01T08:00:00.000Z |"
    );
    expect(pullRequest.body).toContain("(1440 minutes)");
    expect(pullRequest.body).toContain("no model was involved");
    expect(pullRequest.body).not.toContain("Assisted-by");
  });

  it("leaves an open pull request that already holds the cleanup", async () => {
    const github = fake({ openPullRequest: cleanedManifest });

    await expect(
      removeExpiredReleaseAgeExclusions({
        ...github.options,
        editor: neverCalled,
        now: AFTER_EXPIRY,
      })
    ).resolves.toMatchObject({
      editedBy: undefined,
      pullRequest: { created: false, number: 120 },
      status: "pull-request",
    });
    expect(github.writes).toStrictEqual([]);
  });

  it("replaces an open pull request with another change on it", async () => {
    // Someone pushed a change to another file onto the cleanup branch.
    const github = fake({
      headFiles: ["pnpm-workspace.yaml", "package.json"],
      openPullRequest: cleanedManifest,
    });

    await removeExpiredReleaseAgeExclusions({
      ...github.options,
      now: AFTER_EXPIRY,
    });

    expect(github.writes.map(({ route }) => route)).toStrictEqual([
      `POST ${repository}/git/trees`,
      `POST ${repository}/git/commits`,
      `POST ${repository}/git/refs`,
      `PATCH ${repository}/pulls/120`,
    ]);
  });

  it("updates an open pull request that holds another cleanup", async () => {
    // Opened when only @next/env had expired.
    const github = fake({
      openPullRequest: workspaceManifest.replace(
        '  - "@next/env@16.3.8"\n',
        ""
      ),
    });

    await removeExpiredReleaseAgeExclusions({
      ...github.options,
      now: AFTER_EXPIRY,
    });

    expect(github.writes.map(({ route }) => route)).toStrictEqual([
      `POST ${repository}/git/trees`,
      `POST ${repository}/git/commits`,
      `POST ${repository}/git/refs`,
      `PATCH ${repository}/pulls/120`,
    ]);
  });

  describe("when comments make the edit ambiguous", () => {
    // The comment covers an entry that stays.
    const manifest = `minimumReleaseAgeExclude:
  # The Next.js 16.3.8 security release, and the webpack fix it needs.
  - next@16.3.8
  - webpack@5.102.1
`;

    it("lets the editor choose the lines, then checks them", async () => {
      const github = fake({ manifest });
      const editor = vi.fn<ExclusionEditor>(() =>
        Promise.resolve({ lineNumbers: [3], model: MODEL })
      );

      await expect(
        removeExpiredReleaseAgeExclusions({
          ...github.options,
          dryRun: true,
          editor,
          now: AFTER_EXPIRY,
        })
      ).resolves.toMatchObject({
        editedBy: "model",
        source: `minimumReleaseAgeExclude:
  # The Next.js 16.3.8 security release, and the webpack fix it needs.
  - webpack@5.102.1
`,
        status: "planned",
      });
      expect(editor).toHaveBeenCalledExactlyOnceWith({
        lines: manifest.trimEnd().split("\n"),
        reason:
          "a comment describes entries of which only some are removed: line 2",
        selectors: ["next@16.3.8"],
      });
      expect(github.writes).toStrictEqual([]);
    });

    it("rejects an edit that deletes an entry that stays", async () => {
      const github = fake({ manifest });

      await expect(
        removeExpiredReleaseAgeExclusions({
          ...github.options,
          editor: () => Promise.resolve({ lineNumbers: [3, 4], model: MODEL }),
          now: AFTER_EXPIRY,
        })
      ).rejects.toThrow(
        "the model's edit of pnpm-workspace.yaml is wrong: minimumReleaseAgeExclude should list"
      );
      expect(github.writes).toStrictEqual([]);
    });

    it("discloses the model in the commit and the pull request", async () => {
      const github = fake({ manifest });

      await removeExpiredReleaseAgeExclusions({
        ...github.options,
        editor: () => Promise.resolve({ lineNumbers: [3], model: MODEL }),
        now: AFTER_EXPIRY,
      });

      // The trailer ends both, after a blank line.
      const trailer = ["", `Assisted-by: publira-maintenance-bot:${MODEL}`];
      const commit = commitSchema.parse(github.writes[1]?.body);
      const pullRequest = pullRequestSchema.parse(github.writes[3]?.body);
      expect(commit.message.split("\n").slice(-2)).toStrictEqual(trailer);
      expect(pullRequest.body.split("\n").slice(-2)).toStrictEqual(trailer);
      expect(pullRequest.body).toContain("a model chose the lines to delete");
    });

    it("fails without an editor", async () => {
      const github = fake({ manifest });

      await expect(
        removeExpiredReleaseAgeExclusions({
          ...github.options,
          now: AFTER_EXPIRY,
        })
      ).rejects.toThrow("no editor was given");
    });
  });
});

describe(removeExpiredReleaseAgeExclusionsEverywhere, () => {
  const installationRepositories = [
    { archived: false, default_branch: "main", name: "website" },
    { archived: true, default_branch: "main", name: "old-site" },
    { archived: false, default_branch: "trunk", name: "publira" },
  ].map((installed) => ({ ...installed, owner: { login: "publira" } }));

  const appFetch = vi.fn<typeof fetch>((input) => {
    const url = new URL(String(input));
    const response = Response.json(
      url.pathname === "/app/installations"
        ? [{ id: 42, suspended_at: null }]
        : {
            repositories: installationRepositories,
            total_count: installationRepositories.length,
          }
    );
    // The pagination plugin reads the URL of a fetched response.
    Object.defineProperty(response, "url", { value: url.href });
    return Promise.resolve(response);
  });
  const octokit = createGitHubClient({ fetch: appFetch });
  const app: GitHubApp = {
    getBotLogin: () => Promise.reject(new Error("unused")),
    getInstallationOctokit: () => Promise.resolve(octokit),
    getRepositoryOctokit: () => Promise.reject(new Error("unused")),
    octokit,
  };

  it("runs on each unarchived repository and logs each outcome", async () => {
    const log = vi.fn<Log>();
    const job = vi.fn<typeof removeExpiredReleaseAgeExclusions>(({ repo }) =>
      repo === "website"
        ? Promise.reject(new Error("The registry is down"))
        : Promise.resolve({ reports: [], status: "nothing-expired" })
    );

    await removeExpiredReleaseAgeExclusionsEverywhere({ app, job, log });

    expect(
      job.mock.calls.map(([{ base, owner, repo }]) => ({ base, owner, repo }))
    ).toStrictEqual([
      { base: "main", owner: "publira", repo: "website" },
      { base: "trunk", owner: "publira", repo: "publira" },
    ]);
    expect(log.mock.calls.toSorted()).toStrictEqual([
      [
        "error",
        "Release age exclusion cleanup failed",
        {
          error: "The registry is down",
          owner: "publira",
          repo: "website",
          status: undefined,
        },
      ],
      [
        "info",
        "Release age exclusions checked",
        {
          editedBy: undefined,
          expired: 0,
          owner: "publira",
          pullRequest: undefined,
          repo: "publira",
          status: "nothing-expired",
        },
      ],
    ]);
  });
});
