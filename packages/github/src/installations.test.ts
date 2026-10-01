import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createGitHubApp } from "./app.ts";
import { dynamic, fakeGitHub } from "./fake-github.ts";
import { listAppRepositories } from "./installations.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs1" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const tokenResponse = (token: string) => ({
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  permissions: { metadata: "read" },
  repository_selection: "selected",
  token,
});

const repository = (owner: string, name: string) => ({
  archived: false,
  default_branch: "main",
  name,
  owner: { login: owner },
});

describe(listAppRepositories, () => {
  it("lists the repositories of every active installation", async () => {
    const github = fakeGitHub({
      "GET /app/installations": [
        { id: 1, suspended_at: null },
        { id: 2, suspended_at: "2026-09-01T00:00:00Z" },
        { id: 3, suspended_at: null },
      ],
      "GET /installation/repositories": dynamic(({ headers }) =>
        headers.get("authorization") === "token ghs_one"
          ? {
              repositories: [
                repository("publira", "agents"),
                repository("publira", "publira"),
              ],
              total_count: 2,
            }
          : { repositories: [repository("yykamei", "x")], total_count: 1 }
      ),
      "POST /app/installations/1/access_tokens": tokenResponse("ghs_one"),
      "POST /app/installations/3/access_tokens": tokenResponse("ghs_three"),
    });

    const repositories = await listAppRepositories(
      createGitHubApp({ appId: 123, fetch: github.fetch, privateKey })
    );

    expect(repositories).toStrictEqual([
      {
        archived: false,
        defaultBranch: "main",
        installationId: 1,
        owner: "publira",
        repo: "agents",
      },
      {
        archived: false,
        defaultBranch: "main",
        installationId: 1,
        owner: "publira",
        repo: "publira",
      },
      {
        archived: false,
        defaultBranch: "main",
        installationId: 3,
        owner: "yykamei",
        repo: "x",
      },
    ]);
    expect(github.routes).not.toContain(
      "POST /app/installations/2/access_tokens"
    );
  });
});
