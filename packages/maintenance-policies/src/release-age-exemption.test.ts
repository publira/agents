import { describe, expect, it } from "vitest";

import {
  findApprovedReleaseAgeExemption,
  formatReleaseAgeExemptionApprovalMarker,
  formatReleaseAgeExemptionMarker,
  parseReleaseAgeExemptionQuestion,
  pendingReleaseAgeExemptionEntries,
  readReleaseAgeViolations,
  releaseAgeExemptionEntries,
  requestsReleaseAgeExemption,
} from "./release-age-exemption.ts";

// What `pnpm install --frozen-lockfile` prints, wrapped at 80 columns.
const VIOLATION_OUTPUT = `Lockfile is up to date, resolution step is skipped
Error: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION

  × installing dependencies
  ╰─▶ 3 lockfile entries failed verification:
        @playwright/test@1.64.0 was published at 2026-10-07T18:02:39.953Z, within
      the minimumReleaseAge cutoff (2026-10-07T09:27:38.533Z)
        playwright@1.64.0 was published at 2026-10-07T18:01:58.238Z, within the
      minimumReleaseAge cutoff (2026-10-07T09:27:38.533Z)
        playwright-core@1.64.0 was published at 2026-10-07T18:01:13.306Z, within
      the minimumReleaseAge cutoff (2026-10-07T09:27:38.533Z)
  help: The lockfile contains entries that the active policies reject. This
        can mean the lockfile is stale, or that someone committed a lockfile
        that bypassed the policy locally — inspect recent changes to pnpm-
        lock.yaml before trusting it.
`;

const HEAD = "0123456789abcdef0123456789abcdef01234567";

describe(readReleaseAgeViolations, () => {
  it("reads every refused version with its publish time", () => {
    expect(readReleaseAgeViolations(VIOLATION_OUTPUT)).toStrictEqual({
      result: "violations",
      violations: [
        {
          name: "@playwright/test",
          publishedAt: new Date("2026-10-07T18:02:39.953Z"),
          version: "1.64.0",
        },
        {
          name: "playwright",
          publishedAt: new Date("2026-10-07T18:01:58.238Z"),
          version: "1.64.0",
        },
        {
          name: "playwright-core",
          publishedAt: new Date("2026-10-07T18:01:13.306Z"),
          version: "1.64.0",
        },
      ],
    });
  });

  it("finds nothing in an install that failed for another reason", () => {
    expect(
      readReleaseAgeViolations(
        "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile"
      )
    ).toStrictEqual({ result: "none" });
  });

  it("does not read a list in which another policy rejected an entry", () => {
    expect(
      readReleaseAgeViolations(
        VIOLATION_OUTPUT.replace("3 lockfile entries", "4 lockfile entries")
      )
    ).toStrictEqual({
      reason:
        "4 lockfile entries failed verification, 3 of them for minimumReleaseAge",
      result: "unreadable",
    });
  });

  it("does not read an entry that is not an exact version", () => {
    expect(
      readReleaseAgeViolations(
        VIOLATION_OUTPUT.replace("playwright@1.64.0", "playwright@latest")
      )
    ).toStrictEqual({
      reason:
        'the output names an entry the rules cannot read: "playwright@latest"',
      result: "unreadable",
    });
  });

  it("does not read an output without the count", () => {
    expect(
      readReleaseAgeViolations(
        "Error: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION\n  × installing dependencies"
      )
    ).toStrictEqual({
      reason: "the output does not say how many lockfile entries failed",
      result: "unreadable",
    });
  });
});

describe(releaseAgeExemptionEntries, () => {
  it("dates each entry by its window and drops the versions past it", () => {
    expect(
      releaseAgeExemptionEntries({
        minimumReleaseAge: 1440,
        now: new Date("2026-10-08T18:01:30.000Z"),
        violations: [
          {
            name: "playwright-core",
            publishedAt: new Date("2026-10-07T18:01:13.306Z"),
            version: "1.64.0",
          },
          {
            name: "@playwright/test",
            publishedAt: new Date("2026-10-07T18:02:39.953Z"),
            version: "1.64.0",
          },
        ],
      })
    ).toStrictEqual([
      {
        availableAt: new Date("2026-10-08T18:02:39.953Z"),
        selector: "@playwright/test@1.64.0",
      },
    ]);
  });
});

const ENTRIES = [
  {
    availableAt: new Date("2026-10-08T18:02:39.953Z"),
    selector: "@playwright/test@1.64.0",
  },
  {
    availableAt: new Date("2026-10-08T18:01:58.238Z"),
    selector: "playwright@1.64.0",
  },
];

const APPROVAL_URL =
  "https://github.com/publira/publira/pull/3949#issuecomment-123";

describe(parseReleaseAgeExemptionQuestion, () => {
  it("reads the head and the entries back from the mark", () => {
    expect(
      parseReleaseAgeExemptionQuestion(
        `${formatReleaseAgeExemptionMarker(HEAD, ENTRIES)}\nThe question.`
      )
    ).toStrictEqual({ entries: ENTRIES, headSha: HEAD });
  });

  it("reads the approval the bot recorded", () => {
    expect(
      parseReleaseAgeExemptionQuestion(
        [
          formatReleaseAgeExemptionMarker(HEAD, ENTRIES),
          "The question.",
          formatReleaseAgeExemptionApprovalMarker(APPROVAL_URL),
        ].join("\n")
      )
    ).toStrictEqual({
      approvedIn: APPROVAL_URL,
      entries: ENTRIES,
      headSha: HEAD,
    });
  });

  it("finds no question in another comment", () => {
    expect(
      parseReleaseAgeExemptionQuestion(
        "<!-- chachamaru-lint-findings head=1 -->"
      )
    ).toBeUndefined();
  });
});

describe(pendingReleaseAgeExemptionEntries, () => {
  it("keeps the entries not listed yet whose window is still open", () => {
    expect(
      pendingReleaseAgeExemptionEntries(ENTRIES, {
        excluded: ["@publira/*", "@playwright/test@1.64.0"],
        now: new Date("2026-10-08T10:00:00.000Z"),
      })
    ).toStrictEqual([ENTRIES[1]]);
    expect(
      pendingReleaseAgeExemptionEntries(ENTRIES, {
        excluded: [],
        now: new Date("2026-10-08T18:02:00.000Z"),
      })
    ).toStrictEqual([ENTRIES[0]]);
  });
});

describe(findApprovedReleaseAgeExemption, () => {
  const approved = {
    approvedIn: APPROVAL_URL,
    entries: ENTRIES,
    headSha: HEAD,
  };

  it("finds an approved question that covers every version", () => {
    expect(
      findApprovedReleaseAgeExemption(
        [{ entries: ENTRIES, headSha: "1" }, approved],
        ["playwright@1.64.0"]
      )
    ).toBe(approved);
  });

  it("finds none for a version no approval covers", () => {
    expect(
      findApprovedReleaseAgeExemption(
        [approved],
        ["playwright@1.64.0", "playwright-core@1.64.0"]
      )
    ).toBeUndefined();
  });

  it("finds none in a question nobody approved", () => {
    expect(
      findApprovedReleaseAgeExemption(
        [{ entries: ENTRIES, headSha: HEAD }],
        ["playwright@1.64.0"]
      )
    ).toBeUndefined();
  });
});

describe(requestsReleaseAgeExemption, () => {
  const BOT = "chachamaru-bot[bot]";

  it.each([
    "@chachamaru-bot add",
    "@Chachamaru-Bot please add them.",
    "Add them, @chachamaru-bot",
  ])("reads %j as a request", (body) => {
    expect(requestsReleaseAgeExemption(body, BOT)).toBeTruthy();
  });

  it.each([
    "add",
    "@chachamaru-bot",
    "@chachamaru-bot address this later",
    "@chachamaru-bot-test add",
    "> reply `@chachamaru-bot add`\n\nNot yet.",
    "foo@chachamaru-bot add",
  ])("does not read %j as a request", (body) => {
    expect(requestsReleaseAgeExemption(body, BOT)).toBeFalsy();
  });
});
