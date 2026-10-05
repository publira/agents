import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.ts";
import { fakeGitHub } from "./fake-github.ts";
import { getRepositoryPermission } from "./repository-permission.ts";

const ROUTE = "GET /repos/publira/agents/collaborators/ykzts/permission";
const location = { owner: "publira", repo: "agents", username: "ykzts" };

describe(getRepositoryPermission, () => {
  it("returns the user's permission", async () => {
    const github = fakeGitHub({
      [ROUTE]: { permission: "write", role_name: "maintain", user: null },
    });

    await expect(
      getRepositoryPermission(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).resolves.toBe("write");
    expect(github.routes).toStrictEqual([ROUTE]);
  });

  it.each([403, 404])(
    "returns undefined when the token cannot read it (%i)",
    async (status) => {
      const github = fakeGitHub({
        [ROUTE]: Response.json({ message: "Refused" }, { status }),
      });

      await expect(
        getRepositoryPermission(
          createGitHubClient({ fetch: github.fetch }),
          location
        )
      ).resolves.toBeUndefined();
    }
  );

  it("throws when the rate limit ran out", async () => {
    const github = fakeGitHub({
      [ROUTE]: Response.json(
        { message: "API rate limit exceeded" },
        { headers: { "retry-after": "3600" }, status: 403 }
      ),
    });

    await expect(
      getRepositoryPermission(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it("throws when the token is not accepted", async () => {
    const github = fakeGitHub({
      [ROUTE]: Response.json(
        { message: "Requires authentication" },
        {
          status: 401,
        }
      ),
    });

    await expect(
      getRepositoryPermission(
        createGitHubClient({ fetch: github.fetch }),
        location
      )
    ).rejects.toMatchObject({ status: 401 });
  });
});
