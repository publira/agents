import { describe, expect, it, vi } from "vitest";

import { listChangedFiles } from "./changed-files.ts";
import { createGitHubClient } from "./client.ts";

const location = { owner: "publira", repo: "agents", sha: "head" };

describe(listChangedFiles, () => {
  it("lists the files of every page", async () => {
    const files = Array.from({ length: 150 }, (_, index) => `src/${index}.ts`);
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = new URL(String(input));
      const perPage = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page"));
      return Promise.resolve(
        Response.json({
          files: files
            .slice((page - 1) * perPage, page * perPage)
            .map((filename) => ({ filename })),
          sha: "head",
        })
      );
    });

    await expect(
      listChangedFiles(createGitHubClient({ fetch: fetchImpl }), location)
    ).resolves.toStrictEqual(files);
    expect(
      fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname)
    ).toStrictEqual([
      "/repos/publira/agents/commits/head",
      "/repos/publira/agents/commits/head",
    ]);
  });

  it("lists none for a commit that changes nothing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ files: [], sha: "head" }))
    );

    await expect(
      listChangedFiles(createGitHubClient({ fetch: fetchImpl }), location)
    ).resolves.toStrictEqual([]);
  });
});
