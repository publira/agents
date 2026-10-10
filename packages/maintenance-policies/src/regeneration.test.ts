import { describe, expect, it } from "vitest";

import {
  LEGACY_REGENERATION_CONFIG_PATH,
  matchesAnyPathPattern,
  matchesPathPattern,
  parseRegenerationConfig,
  readWorkflowEnv,
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

describe(parseRegenerationConfig, () => {
  it("reads a declaration", () => {
    expect(parseRegenerationConfig(CONFIG)).toStrictEqual({
      config: {
        command: "task gen",
        paths: [
          "server/internal/proto/gen/**",
          "server/internal/db/gen/**",
          "packages/api-client/src/gen/**",
        ],
        setup: [SQLC_SETUP],
        triggers: ["buf.gen.yaml", ".github/workflows/ci.yml"],
        workflowEnv: ".github/workflows/ci.yml",
      },
      result: "valid",
    });
  });

  it("reads generated paths beside the workflows", () => {
    expect(
      parseRegenerationConfig(
        "triggers: [a]\ncommand: make\npaths: [.github/gen/**, .github/workflows.json]\n"
      )
    ).toMatchObject({
      config: { paths: [".github/gen/**", ".github/workflows.json"] },
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
        command: "pnpm codegen",
        paths: ["src/gen/**"],
        setup: [],
        triggers: ["schema.graphql"],
      },
      result: "valid",
    });
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
    ["a list", "- make\n"],
    ["broken YAML", "command: [make\n"],
  ])("refuses one with %s", (_, source) => {
    expect(parseRegenerationConfig(source)).toMatchObject({
      reason: expect.stringMatching(/^\.chachamaru\/regenerate\.yml/u),
      result: "invalid",
    });
  });

  it("names the file it read in the reason", () => {
    expect(
      parseRegenerationConfig(
        "command: make\n",
        LEGACY_REGENERATION_CONFIG_PATH
      )
    ).toMatchObject({
      reason: expect.stringMatching(
        /^\.github\/maintenance-bot\/regenerate\.yml: /u
      ),
      result: "invalid",
    });
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
