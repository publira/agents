import { describe, expect, it, vi } from "vitest";

import { createGitHubClient } from "./client.ts";
import {
  readOptionalRepositoryFile,
  readRepositoryFile,
} from "./repository-file.ts";

const location = {
  owner: "publira",
  path: "pnpm-workspace.yaml",
  ref: "main",
  repo: "agents",
};

const respondWith = (response: Response) =>
  vi.fn<typeof fetch>(() => Promise.resolve(response));

const fileResponse = (content: string): Response =>
  Response.json({
    content: Buffer.from(content).toString("base64"),
    encoding: "base64",
    name: "pnpm-workspace.yaml",
    path: "pnpm-workspace.yaml",
    type: "file",
  });

describe(readRepositoryFile, () => {
  it("decodes the file contents", async () => {
    const fetchImpl = respondWith(fileResponse("packages:\n  - apps/*\n"));

    const content = await readRepositoryFile(
      createGitHubClient({ fetch: fetchImpl }),
      location
    );

    expect(content).toBe("packages:\n  - apps/*\n");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/publira/agents/contents/pnpm-workspace.yaml?ref=main"
    );
  });

  it("sends the token", async () => {
    const fetchImpl = respondWith(fileResponse(""));

    await readRepositoryFile(
      createGitHubClient({ auth: "test-token", fetch: fetchImpl }),
      location
    );

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("token test-token");
  });

  it("rejects a directory", async () => {
    const fetchImpl = respondWith(Response.json([]));

    await expect(
      readRepositoryFile(createGitHubClient({ fetch: fetchImpl }), location)
    ).rejects.toThrow("publira/agents/pnpm-workspace.yaml is not a file");
  });

  it("rejects a file the contents API does not return", async () => {
    const fetchImpl = respondWith(
      Response.json({
        content: "",
        encoding: "none",
        name: "pnpm-workspace.yaml",
        path: "pnpm-workspace.yaml",
        type: "file",
      })
    );

    await expect(
      readRepositoryFile(createGitHubClient({ fetch: fetchImpl }), location)
    ).rejects.toThrow("too large");
  });
});

describe(readOptionalRepositoryFile, () => {
  it("decodes the file contents", async () => {
    const fetchImpl = respondWith(fileResponse("packages: []\n"));

    await expect(
      readOptionalRepositoryFile(
        createGitHubClient({ fetch: fetchImpl }),
        location
      )
    ).resolves.toBe("packages: []\n");
  });

  it("returns undefined for a missing file", async () => {
    const fetchImpl = respondWith(
      Response.json({ message: "Not Found" }, { status: 404 })
    );

    await expect(
      readOptionalRepositoryFile(
        createGitHubClient({ fetch: fetchImpl }),
        location
      )
    ).resolves.toBeUndefined();
  });

  it("passes on other failures", async () => {
    const fetchImpl = respondWith(
      Response.json({ message: "Server Error" }, { status: 500 })
    );

    await expect(
      readOptionalRepositoryFile(
        createGitHubClient({ fetch: fetchImpl }),
        location
      )
    ).rejects.toMatchObject({ status: 500 });
  });
});
