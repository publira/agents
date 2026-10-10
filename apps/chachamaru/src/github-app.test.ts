import { describe, expect, it } from "vitest";

import { readGitHubAppConfig } from "./github-app.ts";

const privateKey =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n";

const env = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: "test-secret",
};

describe(readGitHubAppConfig, () => {
  it("reads the App's credentials", () => {
    expect(readGitHubAppConfig(env)).toStrictEqual({
      appId: "123",
      privateKey,
      webhookSecret: "test-secret",
    });
  });

  it("restores the line breaks of a key pasted on one line", () => {
    expect(
      readGitHubAppConfig({
        ...env,
        GITHUB_APP_PRIVATE_KEY: privateKey.replaceAll("\n", String.raw`\n`),
      })?.privateKey
    ).toBe(privateKey);
  });

  it("runs without the App when none of the variables is set", () => {
    expect(readGitHubAppConfig({})).toBeUndefined();
    expect(
      readGitHubAppConfig({
        GITHUB_APP_ID: "",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_WEBHOOK_SECRET: "",
      })
    ).toBeUndefined();
  });

  it("rejects a partial configuration without echoing the values", () => {
    expect(() =>
      readGitHubAppConfig({ GITHUB_WEBHOOK_SECRET: "test-secret" })
    ).toThrow(/GITHUB_APP_ID.*GITHUB_APP_PRIVATE_KEY/u);
    expect(() =>
      readGitHubAppConfig({ GITHUB_WEBHOOK_SECRET: "test-secret" })
    ).not.toThrow("test-secret");
  });

  it.each([
    ["an App ID that is not a number", { GITHUB_APP_ID: "my-app" }],
    ["a private key that is not PEM", { GITHUB_APP_PRIVATE_KEY: "secret" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => readGitHubAppConfig({ ...env, ...overrides })).toThrow(
      "misconfigured"
    );
  });
});
