import { describe, expect, it, vi } from "vitest";

import { fetchPublishTimes } from "./publish-times.ts";

const packument = {
  name: "@next/env",
  time: {
    "16.3.7": "2026-09-20T10:00:00.000Z",
    "16.3.8": "2026-09-30T08:00:00.000Z",
    created: "2020-01-01T00:00:00.000Z",
    modified: "2026-09-30T08:00:00.000Z",
  },
};

const respondWith = (response: Response) =>
  vi.fn<typeof fetch>(() => Promise.resolve(response));

describe(fetchPublishTimes, () => {
  it("maps each version to its publish time", async () => {
    const publishTimes = await fetchPublishTimes("@next/env", {
      fetch: respondWith(Response.json(packument)),
    });

    expect(publishTimes).toStrictEqual(
      new Map([
        ["16.3.7", new Date("2026-09-20T10:00:00.000Z")],
        ["16.3.8", new Date("2026-09-30T08:00:00.000Z")],
      ])
    );
  });

  it("escapes the slash of a scoped name", async () => {
    const fetchImpl = respondWith(Response.json(packument));

    await fetchPublishTimes("@next/env", {
      fetch: fetchImpl,
      registryUrl: "https://registry.example.com/npm/",
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://registry.example.com/npm/@next%2fenv"
    );
  });

  it("returns no versions for an unpublished package", async () => {
    const fetchImpl = respondWith(
      Response.json({
        name: "gone",
        time: {
          created: "2020-01-01T00:00:00.000Z",
          modified: "2021-01-01T00:00:00.000Z",
          unpublished: {
            time: "2021-01-01T00:00:00.000Z",
            versions: ["1.0.0"],
          },
        },
      })
    );

    await expect(
      fetchPublishTimes("gone", { fetch: fetchImpl })
    ).resolves.toStrictEqual(new Map());
  });

  it("fails when the registry does not answer with the package", async () => {
    const fetchImpl = respondWith(new Response("Not Found", { status: 404 }));

    await expect(
      fetchPublishTimes("missing", { fetch: fetchImpl })
    ).rejects.toThrow('The npm registry answered 404 for "missing"');
  });
});
