import { createGitHubClient } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import { checkReleaseAgeExclusions } from "./check-release-age-exclusions.ts";

const workspaceManifest = `packages:
  - apps/*
minimumReleaseAgeExclude:
  - "@publira/*"
  - next@16.3.8
  - "@next/env@16.3.8"
  - webpack@5.102.1
`;

const packuments = new Map([
  ["/@next%2fenv", { time: { "16.3.8": "2026-09-30T08:00:00.000Z" } }],
  ["/next", { time: { "16.3.8": "2026-09-30T08:00:00.000Z" } }],
  ["/webpack", { time: { "5.102.1": "2026-09-01T00:00:00.000Z" } }],
]);

// Answers both the GitHub API and the npm registry.
const fakeFetch = () =>
  vi.fn<typeof fetch>((input) => {
    const url = new URL(String(input));

    if (url.hostname === "api.github.com") {
      return Promise.resolve(
        Response.json({
          content: Buffer.from(workspaceManifest).toString("base64"),
          encoding: "base64",
          type: "file",
        })
      );
    }

    const packument = packuments.get(url.pathname);
    return Promise.resolve(
      packument === undefined
        ? new Response("Not Found", { status: 404 })
        : Response.json(packument)
    );
  });

describe(checkReleaseAgeExclusions, () => {
  it("judges every entry against the registry", async () => {
    const fetchImpl = fakeFetch();

    const reports = await checkReleaseAgeExclusions({
      now: new Date("2026-09-30T20:00:00.000Z"),
      octokit: createGitHubClient({ fetch: fetchImpl }),
      owner: "publira",
      registry: { fetch: fetchImpl },
      repo: "publira",
    });

    expect(reports).toStrictEqual([
      { selector: "@publira/*", verdict: { action: "keep" } },
      {
        selector: "next@16.3.8",
        verdict: {
          action: "waiting",
          availableAt: new Date("2026-10-01T08:00:00.000Z"),
        },
      },
      {
        selector: "@next/env@16.3.8",
        verdict: {
          action: "waiting",
          availableAt: new Date("2026-10-01T08:00:00.000Z"),
        },
      },
      { selector: "webpack@5.102.1", verdict: { action: "expired" } },
    ]);
  });

  it("does not ask the registry about an entry without versions", async () => {
    const fetchImpl = fakeFetch();

    await checkReleaseAgeExclusions({
      octokit: createGitHubClient({ fetch: fetchImpl }),
      owner: "publira",
      registry: { fetch: fetchImpl },
      repo: "publira",
    });

    const registryPaths = fetchImpl.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.hostname === "registry.npmjs.org")
      .map((url) => url.pathname);
    expect(registryPaths.toSorted()).toStrictEqual([
      "/@next%2fenv",
      "/next",
      "/webpack",
    ]);
  });
});
