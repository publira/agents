import { createGitHubClient } from "@publira/github";
import { describe, expect, it, vi } from "vitest";

import { readRegenerationConfig } from "./regeneration-config.ts";

const CONFIG = "triggers: [buf.gen.yaml]\ncommand: make\npaths: [gen/**]\n";

const CONTENTS = "/repos/publira/publira/contents/";

// Answers the contents of the given files at `base`, and 404 for the rest.
const fakeGitHub = (files: Readonly<Record<string, string>>) => {
  const fetchImpl = vi.fn<typeof fetch>((input) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname).slice(CONTENTS.length);
    const content = files[path];
    return Promise.resolve(
      content === undefined || url.searchParams.get("ref") !== "base"
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json({
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
            type: "file",
          })
    );
  });
  const read = () =>
    readRegenerationConfig(createGitHubClient({ fetch: fetchImpl }), {
      owner: "publira",
      ref: "base",
      repo: "publira",
    });
  return { fetchImpl, read };
};

describe(readRegenerationConfig, () => {
  it("reads .chachamaru/regenerate.yml first", async () => {
    const { fetchImpl, read } = fakeGitHub({
      ".chachamaru/regenerate.yml": CONFIG,
      ".github/maintenance-bot/regenerate.yml": "command: make\n",
    });

    await expect(read()).resolves.toMatchObject({
      config: { command: "make", paths: ["gen/**"] },
      result: "valid",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("falls back to .github/maintenance-bot/regenerate.yml", async () => {
    const { read } = fakeGitHub({
      ".github/maintenance-bot/regenerate.yml": CONFIG,
    });

    await expect(read()).resolves.toMatchObject({ result: "valid" });
  });

  it("names the old path when the declaration there is invalid", async () => {
    const { read } = fakeGitHub({
      ".github/maintenance-bot/regenerate.yml": "command: make\n",
    });

    await expect(read()).resolves.toMatchObject({
      reason: expect.stringMatching(
        /^\.github\/maintenance-bot\/regenerate\.yml: /u
      ),
      result: "invalid",
    });
  });

  it("returns undefined when the repository has neither", async () => {
    const { read } = fakeGitHub({});

    await expect(read()).resolves.toBeUndefined();
  });
});
