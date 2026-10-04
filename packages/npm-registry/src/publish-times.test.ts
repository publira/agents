import { once } from "node:events";

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

  it("returns no versions for a package the registry does not have", async () => {
    const fetchImpl = respondWith(new Response("Not Found", { status: 404 }));

    await expect(
      fetchPublishTimes("missing", { fetch: fetchImpl })
    ).resolves.toStrictEqual(new Map());
  });

  it("fails when the registry does not answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 }))
    );

    await expect(
      fetchPublishTimes("next", { fetch: fetchImpl, retryDelay: 0 })
    ).rejects.toThrow('The npm registry answered 503 for "next"');
    // The first attempt and two retries.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("tries again after a server error or a failed request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json(packument));

    await expect(
      fetchPublishTimes("@next/env", { fetch: fetchImpl, retryDelay: 0 })
    ).resolves.toHaveProperty("size", 2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not try a client error again", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("Forbidden", { status: 403 }))
    );

    await expect(
      fetchPublishTimes("next", { fetch: fetchImpl, retryDelay: 0 })
    ).rejects.toThrow('The npm registry answered 403 for "next"');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("times out an attempt that takes too long", async () => {
    // Answers only once the request is aborted.
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal) {
        await once(init.signal, "abort");
      }
      throw init?.signal?.reason;
    });

    await expect(
      fetchPublishTimes("next", {
        fetch: fetchImpl,
        retries: 1,
        retryDelay: 0,
        timeout: 10,
      })
    ).rejects.toThrow('The npm registry did not answer for "next"');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
