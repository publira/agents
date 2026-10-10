import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createGitHubApp } from "./app.ts";
import { dynamic, fakeGitHub } from "./fake-github.ts";

// GitHub hands out PKCS#1 keys.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs1" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const tokenResponse = (token: string) => ({
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  permissions: { contents: "write", metadata: "read" },
  repository_selection: "selected",
  token,
});

const jwtClaimsSchema = z.object({ iss: z.number() });

const jwtClaims = (authorization: string | null) => {
  const [scheme, jwt] = authorization?.split(" ") ?? [];
  expect(scheme?.toLowerCase()).toBe("bearer");
  return jwtClaimsSchema.parse(
    JSON.parse(Buffer.from(jwt?.split(".")[1] ?? "", "base64url").toString())
  );
};

describe(createGitHubApp, () => {
  it("authenticates as the App with a JWT", async () => {
    const github = fakeGitHub({ "GET /app": { slug: "chachamaru-bot" } });
    const app = createGitHubApp({
      appId: 123,
      fetch: github.fetch,
      privateKey,
    });

    await app.octokit.rest.apps.getAuthenticated();

    expect(
      jwtClaims(github.requests[0]?.headers.get("authorization") ?? null).iss
    ).toBe(123);
  });

  it("authenticates as an installation with its token", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": { full_name: "publira/agents" },
      "POST /app/installations/42/access_tokens": tokenResponse("ghs_one"),
    });
    const app = createGitHubApp({
      appId: 123,
      fetch: github.fetch,
      privateKey,
    });

    const octokit = await app.getInstallationOctokit(42);
    await octokit.rest.repos.get({ owner: "publira", repo: "agents" });

    expect(github.routes).toStrictEqual([
      "POST /app/installations/42/access_tokens",
      "GET /repos/publira/agents",
    ]);
    expect(
      jwtClaims(github.requests[0]?.headers.get("authorization") ?? null).iss
    ).toBe(123);
    expect(github.requests[1]?.headers.get("authorization")).toBe(
      "token ghs_one"
    );
  });

  it("tries an installation's failed reads again", async () => {
    let attempts = 0;
    const github = fakeGitHub({
      "GET /repos/publira/agents": dynamic(() => {
        attempts += 1;
        return attempts === 1
          ? Response.json({ message: "Bad Gateway" }, { status: 502 })
          : { full_name: "publira/agents" };
      }),
      "POST /app/installations/42/access_tokens": tokenResponse("ghs_one"),
    });
    const app = createGitHubApp({
      appId: 123,
      fetch: github.fetch,
      privateKey,
      requestPolicy: { retryDelay: 0 },
    });

    const octokit = await app.getInstallationOctokit(42);
    await octokit.rest.repos.get({ owner: "publira", repo: "agents" });

    expect(github.routes).toStrictEqual([
      "POST /app/installations/42/access_tokens",
      "GET /repos/publira/agents",
      "GET /repos/publira/agents",
    ]);
  });

  it("shares installation tokens across clients", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": { full_name: "publira/agents" },
      "POST /app/installations/42/access_tokens": tokenResponse("ghs_one"),
    });
    const app = createGitHubApp({
      appId: 123,
      fetch: github.fetch,
      privateKey,
    });

    const first = await app.getInstallationOctokit(42);
    await first.rest.repos.get({ owner: "publira", repo: "agents" });
    const second = await app.getInstallationOctokit(42);
    await second.rest.repos.get({ owner: "publira", repo: "agents" });

    expect(
      github.routes.filter((route) => route.endsWith("/access_tokens"))
    ).toHaveLength(1);
  });

  it("finds the installation that covers a repository", async () => {
    const github = fakeGitHub({
      "GET /repos/publira/agents": { full_name: "publira/agents" },
      "GET /repos/publira/agents/installation": { id: 42 },
      "POST /app/installations/42/access_tokens": tokenResponse("ghs_one"),
    });
    const app = createGitHubApp({
      appId: 123,
      fetch: github.fetch,
      privateKey,
    });

    const octokit = await app.getRepositoryOctokit({
      owner: "publira",
      repo: "agents",
    });
    await octokit.rest.repos.get({ owner: "publira", repo: "agents" });

    expect(github.requests.at(-1)?.headers.get("authorization")).toBe(
      "token ghs_one"
    );
  });

  it("derives the bot login from the App's slug once", async () => {
    const github = fakeGitHub({ "GET /app": { slug: "chachamaru-bot" } });
    const app = createGitHubApp({
      appId: 123,
      fetch: github.fetch,
      privateKey,
    });

    await expect(app.getBotLogin()).resolves.toBe("chachamaru-bot[bot]");
    await expect(app.getBotLogin()).resolves.toBe("chachamaru-bot[bot]");
    expect(github.routes).toStrictEqual(["GET /app"]);
  });

  it("asks for the bot login again after a failure", async () => {
    let attempts = 0;
    const github = fakeGitHub({
      "GET /app": dynamic(() => {
        attempts += 1;
        return attempts === 1
          ? Response.json({ message: "Forbidden" }, { status: 403 })
          : { slug: "chachamaru-bot" };
      }),
    });
    const app = createGitHubApp({
      appId: 123,
      fetch: github.fetch,
      privateKey,
    });

    await expect(app.getBotLogin()).rejects.toThrow("Forbidden");
    await expect(app.getBotLogin()).resolves.toBe("chachamaru-bot[bot]");
  });
});
