import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

// Octokit binds `console.error` when it loads, before a test could spy on
// it, and vitest hands the tests a console of its own. A child process shows
// what the clients write to the real stderr, which the runtime logs collect.
const moduleUrl = (name: string) =>
  JSON.stringify(new URL(name, import.meta.url).href);

const script = `
import { generateKeyPairSync } from "node:crypto";

import { createGitHubApp } from ${moduleUrl("./app.ts")};
import { createGitHubClient } from ${moduleUrl("./client.ts")};
import { readOptionalRepositoryFile } from ${moduleUrl("./repository-file.ts")};

const notFound = () =>
  Response.json({ message: "Not Found" }, { status: 404 });

const client = createGitHubClient({ fetch: () => Promise.resolve(notFound()) });
const file = await readOptionalRepositoryFile(client, {
  owner: "publira",
  path: ".chachamaru/regenerate.yml",
  repo: "website",
});

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs1" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const app = createGitHubApp({
  appId: 123,
  fetch: (input, init) =>
    Promise.resolve(
      init?.method === "POST" && String(input).endsWith("/access_tokens")
        ? Response.json({
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: { contents: "read" },
            repository_selection: "selected",
            token: "ghs_one",
          })
        : notFound()
    ),
  privateKey,
});
const installation = await app.getInstallationOctokit(42);
let status;
try {
  await installation.rest.repos.get({ owner: "publira", repo: "agents" });
} catch (error) {
  status = error.status;
}

console.log(JSON.stringify({ file: file ?? null, status }));
`;

describe("the clients' logging", () => {
  it("writes no line for a failed request", async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: import.meta.dirname }
    );

    expect(JSON.parse(stdout)).toStrictEqual({ file: null, status: 404 });
    expect(stderr).toBe("");
  }, 30_000);
});
