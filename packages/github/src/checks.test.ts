import { describe, expect, it } from "vitest";

import { getCommitChecks, getRequiredStatusChecks } from "./checks.ts";
import { createGitHubClient } from "./client.ts";
import { fakeGitHub } from "./fake-github.ts";

const repository = "/repos/publira/agents";

describe(getCommitChecks, () => {
  it("reads the latest check runs and statuses", async () => {
    const github = fakeGitHub({
      [`GET ${repository}/commits/head/check-runs`]: {
        check_runs: [
          {
            app: { slug: "github-actions" },
            conclusion: "success",
            name: "Test",
            status: "completed",
          },
          {
            app: { slug: "github-actions" },
            conclusion: null,
            name: "Build",
            status: "in_progress",
          },
        ],
        total_count: 2,
      },
      [`GET ${repository}/commits/head/statuses`]: [
        { context: "vercel", state: "success" },
        { context: "renovate/stability-days", state: "success" },
        { context: "vercel", state: "pending" },
      ],
    });

    await expect(
      getCommitChecks(createGitHubClient({ fetch: github.fetch }), {
        owner: "publira",
        ref: "head",
        repo: "agents",
      })
    ).resolves.toStrictEqual({
      checkRuns: [
        {
          appSlug: "github-actions",
          conclusion: "success",
          name: "Test",
          status: "completed",
        },
        {
          appSlug: "github-actions",
          conclusion: null,
          name: "Build",
          status: "in_progress",
        },
      ],
      statuses: [
        { context: "vercel", state: "success" },
        { context: "renovate/stability-days", state: "success" },
      ],
    });
    expect(github.requests[0]?.url.searchParams.get("filter")).toBe("latest");
  });
});

describe(getRequiredStatusChecks, () => {
  it("collects the required checks of every ruleset", async () => {
    const github = fakeGitHub({
      [`GET ${repository}/rules/branches/main`]: [
        { type: "deletion" },
        {
          parameters: {
            required_status_checks: [
              { context: "Lint", integration_id: 15_368 },
              { context: "Test", integration_id: 15_368 },
            ],
          },
          type: "required_status_checks",
        },
        {
          parameters: {
            required_status_checks: [
              { context: "Test", integration_id: 15_368 },
              { context: "vercel" },
            ],
          },
          type: "required_status_checks",
        },
      ],
    });

    await expect(
      getRequiredStatusChecks(createGitHubClient({ fetch: github.fetch }), {
        branch: "main",
        owner: "publira",
        repo: "agents",
      })
    ).resolves.toStrictEqual([
      { context: "Lint", integrationId: 15_368 },
      { context: "Test", integrationId: 15_368 },
      { context: "vercel", integrationId: undefined },
    ]);
  });
});
