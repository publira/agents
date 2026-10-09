import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createGitHubApp } from "./app.ts";
import { fakeGitHub } from "./fake-github.ts";
import { createRepositoryReadToken } from "./read-token.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs1" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

describe(createRepositoryReadToken, () => {
  it("asks for a token that reads the contents of one repository", async () => {
    const github = fakeGitHub({
      "POST /app/installations/7/access_tokens": {
        expires_at: "2026-10-12T01:00:00Z",
        permissions: { contents: "read", metadata: "read" },
        repository_selection: "selected",
        token: "ghs_read",
      },
    });

    await expect(
      createRepositoryReadToken(
        createGitHubApp({ appId: 123, fetch: github.fetch, privateKey }),
        { installationId: 7, repo: "publira" }
      )
    ).resolves.toBe("ghs_read");
    expect(github.requests[0]?.body).toStrictEqual({
      permissions: { contents: "read" },
      repositories: ["publira"],
    });
    expect(github.requests[0]?.headers.get("authorization")).toMatch(
      /^bearer /u
    );
  });
});
