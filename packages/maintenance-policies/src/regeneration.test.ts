import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  matchesAnyPathPattern,
  matchesPathPattern,
  parseRegenerationConfig,
  readWorkflowEnv,
  REGENERATION_CONFIG_JSON_SCHEMA,
  REGENERATION_CONFIG_SCHEMA_URL,
  triggeredRegenerationTargets,
} from "./regeneration.ts";

const SQLC_SETUP =
  // oxlint-disable-next-line no-template-curly-in-string -- shell variables
  'curl -fsSL "https://github.com/sqlc-dev/sqlc/releases/download/v${SQLC_VERSION}/sqlc_${SQLC_VERSION}_linux_amd64.tar.gz" | tar -xz -C ~/.local/bin sqlc';

// publira/publira's declaration.
const CONFIG = `triggers:
  - buf.gen.yaml
  - .github/workflows/ci.yml
workflowEnv: .github/workflows/ci.yml
setup:
  - curl -fsSL "https://github.com/sqlc-dev/sqlc/releases/download/v\${SQLC_VERSION}/sqlc_\${SQLC_VERSION}_linux_amd64.tar.gz" | tar -xz -C ~/.local/bin sqlc
command: task gen
paths:
  - server/internal/proto/gen/**
  - server/internal/db/gen/**
  - packages/api-client/src/gen/**
`;

// The same as a target, beside one that regenerates the iOS package pins.
const TARGETS_CONFIG = `targets:
  codegen:
${CONFIG.replaceAll(/^/gmu, "    ").trimEnd()}
  ios-packages:
    triggers:
      - mobile/pubspec.lock
    command: flutter pub get
    paths:
      - mobile/ios/Runner.xcworkspace/xcshareddata/swiftpm/Package.resolved
`;

// Declares the targets of `paths`, each triggered by its own file.
const targets = (...paths: string[]) =>
  `targets:\n${paths.map((path, index) => `  t${index}:\n    triggers: [t${index}]\n    command: make\n    paths: [${path}]\n`).join("")}`;

const CODEGEN = {
  command: "task gen",
  paths: [
    "server/internal/proto/gen/**",
    "server/internal/db/gen/**",
    "packages/api-client/src/gen/**",
  ],
  setup: [SQLC_SETUP],
  setupTimeout: 120,
  timeout: 120,
  triggers: ["buf.gen.yaml", ".github/workflows/ci.yml"],
  workflowEnv: ".github/workflows/ci.yml",
};

describe(parseRegenerationConfig, () => {
  it("reads a declaration as one target", () => {
    expect(parseRegenerationConfig(CONFIG)).toStrictEqual({
      config: { targets: [{ ...CODEGEN, name: "default" }] },
      result: "valid",
    });
  });

  it("reads generated paths beside the workflows", () => {
    expect(
      parseRegenerationConfig(
        "triggers: [a]\ncommand: make\npaths: [.github/gen/**, .github/workflows.json]\n"
      )
    ).toMatchObject({
      config: {
        targets: [{ paths: [".github/gen/**", ".github/workflows.json"] }],
      },
      result: "valid",
    });
  });

  it("reads one without setup or workflow", () => {
    expect(
      parseRegenerationConfig(
        "triggers: [schema.graphql]\ncommand: pnpm codegen\npaths: [src/gen/**]\n"
      )
    ).toStrictEqual({
      config: {
        targets: [
          {
            command: "pnpm codegen",
            name: "default",
            paths: ["src/gen/**"],
            setup: [],
            setupTimeout: 120,
            timeout: 120,
            triggers: ["schema.graphql"],
          },
        ],
      },
      result: "valid",
    });
  });

  it("reads the time limits a declaration sets", () => {
    expect(
      parseRegenerationConfig(
        "triggers: [pubspec.yaml]\nsetup: [a, b]\nsetupTimeout: 150\ncommand: make\ntimeout: 180\npaths: [gen/**]\n"
      )
    ).toMatchObject({
      config: { targets: [{ setupTimeout: 150, timeout: 180 }] },
      result: "valid",
    });
  });

  it("reads limits that total the maximum", () => {
    expect(
      parseRegenerationConfig(
        "triggers: [a]\nsetup: [a, b, c]\ncommand: make\npaths: [gen/**]\n"
      )
    ).toMatchObject({ result: "valid" });
  });

  it("reads named targets in their order", () => {
    expect(parseRegenerationConfig(TARGETS_CONFIG)).toStrictEqual({
      config: {
        targets: [
          { ...CODEGEN, name: "codegen" },
          {
            command: "flutter pub get",
            name: "ios-packages",
            paths: [
              "mobile/ios/Runner.xcworkspace/xcshareddata/swiftpm/Package.resolved",
            ],
            setup: [],
            setupTimeout: 120,
            timeout: 120,
            triggers: ["mobile/pubspec.lock"],
          },
        ],
      },
      result: "valid",
    });
  });

  it.each([
    ["two files", ["a.txt", "b.txt"]],
    ["two directories side by side", ["gen/**", "generated/**"]],
    ["a file beside a directory", ["gen.txt", "gen/**"]],
  ])("reads targets with paths that do not overlap: %s", (_, paths) => {
    expect(parseRegenerationConfig(targets(...paths))).toMatchObject({
      result: "valid",
    });
  });

  it.each([
    ["the same file", ["gen/a.txt", "gen/a.txt"]],
    ["a file under a directory", ["gen/**", "gen/a.txt"]],
    ["a directory under a directory", ["gen/v1/**", "gen/**"]],
    ["the same directory", ["gen/**", "gen/**"]],
  ])("refuses targets with overlapping paths: %s", (_, paths) => {
    const parsed = parseRegenerationConfig(targets(...paths));

    expect(parsed).toMatchObject({ result: "invalid" });
    expect(parsed.result === "invalid" && parsed.reason).toMatch(
      `overlaps ${paths[0]} of target t0   → at targets.t1.paths[0]`
    );
  });

  it("names the target whose field is invalid", () => {
    const parsed = parseRegenerationConfig(
      `${targets("gen/**")}    timeout: 481\n`
    );

    expect(parsed.result === "invalid" && parsed.reason).toMatch(
      /targets\.t0\.timeout/u
    );
  });

  it.each([
    ["a timeout over the maximum", "timeout: 481\n", /timeout/u],
    ["a setupTimeout over the maximum", "setupTimeout: 481\n", /setupTimeout/u],
    ["a timeout of zero", "timeout: 0\n", /timeout/u],
    ["a fractional timeout", "timeout: 1.5\n", /timeout/u],
    ["a timeout as text", "timeout: 2m\n", /timeout/u],
    [
      "limits that total more than the maximum",
      "setup: [a, b, c]\nsetupTimeout: 121\n",
      /timeout and setupTimeout .* at most 480 seconds, not 483/u,
    ],
  ])("refuses one with %s, naming the field", (_, limits, field) => {
    const parsed = parseRegenerationConfig(
      `triggers: [a]\ncommand: make\npaths: [gen/**]\n${limits}`
    );

    expect(parsed).toMatchObject({ result: "invalid" });
    expect(parsed.result === "invalid" && parsed.reason).toMatch(field);
  });

  it.each([
    ["no command", "triggers: [a]\npaths: [gen/**]\n"],
    ["no paths", "triggers: [a]\ncommand: make\npaths: []\n"],
    ["no triggers", "command: make\npaths: [gen/**]\n"],
    ["a glob", "triggers: [a]\ncommand: make\npaths: [gen/*.go]\n"],
    ["a path from /", "triggers: [a]\ncommand: make\npaths: [/gen/**]\n"],
    [
      "a path out of the root",
      "triggers: [a]\ncommand: make\npaths: [../gen/**]\n",
    ],
    ["the root", "triggers: [a]\ncommand: make\npaths: ['**']\n"],
    [
      "a workflow path",
      "triggers: [a]\ncommand: make\npaths: [.github/workflows/ci.yml]\n",
    ],
    [
      "the workflows directory",
      "triggers: [a]\ncommand: make\npaths: [.github/workflows/**]\n",
    ],
    [
      "a directory under the workflows",
      "triggers: [a]\ncommand: make\npaths: [.github/workflows/gen/**]\n",
    ],
    [
      "a directory holding the workflows",
      "triggers: [a]\ncommand: make\npaths: [.github/**]\n",
    ],
    [
      "an unknown key",
      "triggers: [a]\ncommand: make\npaths: [gen/**]\nbase: main\n",
    ],
    ["no targets", "targets: {}\n"],
    ["targets that are a list", "targets: [make]\n"],
    [
      "a target's name in capitals",
      "targets:\n  Gen:\n    triggers: [a]\n    command: make\n    paths: [gen/**]\n",
    ],
    [
      "a target's field beside the targets",
      `${targets("gen/**")}command: make\n`,
    ],
    [
      "a target without paths",
      "targets:\n  gen:\n    triggers: [a]\n    command: make\n",
    ],
    ["a list", "- make\n"],
    ["broken YAML", "command: [make\n"],
  ])("refuses one with %s", (_, source) => {
    expect(parseRegenerationConfig(source)).toMatchObject({
      reason: expect.stringMatching(/^\.chachamaru\/regenerate\.yml/u),
      result: "invalid",
    });
  });
});

describe("the JSON Schema", () => {
  // Strict mode also refuses a keyword the schema should not carry.
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    REGENERATION_CONFIG_JSON_SCHEMA
  );

  it("is identified by the URL it is served at", () => {
    expect(REGENERATION_CONFIG_JSON_SCHEMA.$id).toBe(
      REGENERATION_CONFIG_SCHEMA_URL
    );
  });

  it("accepts a declaration", () => {
    expect(validate(parse(CONFIG))).toBeTruthy();
  });

  it("accepts one without setup or workflow", () => {
    expect(
      validate({
        command: "pnpm codegen",
        paths: ["src/gen/**"],
        triggers: ["schema.graphql"],
      })
    ).toBeTruthy();
  });

  it("accepts named targets", () => {
    expect(validate(parse(TARGETS_CONFIG))).toBeTruthy();
  });

  it.each([
    ["none", {}],
    ["a target's name in capitals", { Gen: parse(CONFIG) }],
    [
      "a target with an unknown field",
      { gen: { ...parse(CONFIG), base: "main" } },
    ],
  ])("refuses targets: %s", (_label, declared) => {
    expect(validate({ targets: declared })).toBeFalsy();
  });

  it("refuses a target's field beside the targets", () => {
    expect(validate({ ...parse(TARGETS_CONFIG), command: "make" })).toBeFalsy();
  });

  it.each([
    ["an unknown field", { generate: "make" }],
    ["an empty command", { command: "" }],
    ["no generated paths", { paths: [] }],
    ["a trigger that is not a string", { triggers: [1] }],
    ["a timeout over the maximum", { timeout: 481 }],
    ["a fractional setupTimeout", { setupTimeout: 1.5 }],
  ])("refuses %s", (_label, change) => {
    expect(validate({ ...parse(CONFIG), ...change })).toBeFalsy();
  });

  it("is generated from the parser's definition", async () => {
    await expect(
      `${JSON.stringify(REGENERATION_CONFIG_JSON_SCHEMA, null, 2)}\n`
    ).toMatchFileSnapshot("__snapshots__/regenerate-v1.json");
  });
});

describe(matchesPathPattern, () => {
  it.each([
    ["gen/**", "gen/a.go"],
    ["gen/**", "gen/v1/a.go"],
    ["buf.gen.yaml", "buf.gen.yaml"],
  ])("matches %s with %s", (pattern, path) => {
    expect(matchesPathPattern(pattern, path)).toBeTruthy();
  });

  it.each([
    ["gen/**", "gen"],
    ["gen/**", "generated/a.go"],
    ["gen/**", "server/gen/a.go"],
    ["buf.gen.yaml", "proto/buf.gen.yaml"],
  ])("does not match %s with %s", (pattern, path) => {
    expect(matchesPathPattern(pattern, path)).toBeFalsy();
  });
});

describe(matchesAnyPathPattern, () => {
  it("matches no path without patterns", () => {
    expect(matchesAnyPathPattern([], "gen/a.go")).toBeFalsy();
  });
});

describe(triggeredRegenerationTargets, () => {
  const parsed = parseRegenerationConfig(TARGETS_CONFIG);

  it.each([
    ["one target", ["mobile/pubspec.lock"], ["ios-packages"]],
    [
      "two targets",
      ["buf.gen.yaml", "mobile/pubspec.lock"],
      ["codegen", "ios-packages"],
    ],
    ["none", ["mobile/pubspec.yaml"], []],
  ])("selects %s by the changed files", (_, changed, names) => {
    expect(
      parsed.result === "valid" &&
        triggeredRegenerationTargets(parsed.config, changed).map(
          ({ name }) => name
        )
    ).toStrictEqual(names);
  });
});

describe(readWorkflowEnv, () => {
  it("reads the top-level env block", () => {
    expect(
      readWorkflowEnv(`name: CI
env:
  # renovate: datasource=github-releases depName=sqlc-dev/sqlc
  SQLC_VERSION: 1.31.1
  RETRIES: 5
  STRICT: true
on:
  pull_request:
jobs:
  check:
    env:
      JOB_ONLY: "1"
`)
    ).toStrictEqual({ RETRIES: "5", SQLC_VERSION: "1.31.1", STRICT: "true" });
  });

  it("reads none from a workflow without one", () => {
    expect(readWorkflowEnv("on: push\n")).toStrictEqual({});
  });

  it("refuses an env block that is not a map of values", () => {
    expect(() => readWorkflowEnv("env:\n  A: [1]\n")).toThrow(/env block/u);
  });
});
