import { once } from "node:events";

import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { Sandbox } from "#sandbox/runner.ts";

import {
  createModelLintFindingsFixer,
  LintFindingsRunError,
} from "./lint-findings-fixer.ts";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 1,
  },
  outputTokens: { reasoning: undefined, text: undefined, total: 1 },
};

const toolCall = (
  toolName: string,
  input: Readonly<Record<string, string>>
) => ({
  content: [
    {
      input: JSON.stringify(input),
      toolCallId: toolName,
      toolName,
      type: "tool-call" as const,
    },
  ],
  finishReason: { raw: "tool_use", unified: "tool-calls" as const },
  usage,
  warnings: [],
});

const reply = {
  content: [{ text: "Removed the debugger statement.", type: "text" as const }],
  finishReason: { raw: "stop", unified: "stop" as const },
  usage,
  warnings: [],
};

// A model call that answers only by failing once it is aborted.
const untilAborted = async (
  signal: AbortSignal | undefined
): Promise<never> => {
  if (signal === undefined) {
    throw new Error("The call has no abort signal");
  }

  await once(signal, "abort");
  throw signal.reason;
};

// AI Gateway's answer to a call over the rate limit.
const rateLimited = (retryAfter: string) =>
  new APICallError({
    isRetryable: true,
    message: "Rate limit exceeded",
    requestBodyValues: {},
    responseHeaders: { "retry-after": retryAfter },
    statusCode: 429,
    url: "https://ai-gateway.vercel.sh/v4/ai/language-model",
  });

const fakeSandbox = () => {
  const sandbox: Sandbox = {
    denyNetwork: vi.fn<Sandbox["denyNetwork"]>(),
    run: vi.fn<Sandbox["run"]>(({ cmd }) =>
      Promise.resolve(
        cmd === "cat"
          ? { exitCode: 0, stderr: "", stdout: "debugger;\n" }
          : { exitCode: 1, stderr: "", stdout: "debugger statement\n" }
      )
    ),
    stopsAt: Date.now() + 240_000,
    writeFile: vi.fn<Sandbox["writeFile"]>(() => Promise.resolve()),
  };

  return sandbox;
};

const request = (sandbox: Sandbox, deadline = Date.now() + 60_000) => ({
  command: "pnpm exec ultracite check",
  deadline,
  diff: "",
  output: "src/index.ts: debugger statement\n",
  sandbox,
  worktree: "/tmp/repository",
});

describe(createModelLintFindingsFixer, () => {
  it("lets the model work on the repository through the sandbox's tools", async () => {
    const steps = [
      toolCall("bash", { command: "pnpm exec ultracite check" }),
      toolCall("read_file", { path: "src/index.ts" }),
      toolCall("write_file", { content: "", path: "src/index.ts" }),
      reply,
    ];

    const model = new MockLanguageModelV4({
      doGenerate: () => {
        const step = steps.shift();

        return Promise.resolve(step ?? reply);
      },
      modelId: "openai/gpt-5.1-codex-mini",
    });

    const sandbox = fakeSandbox();

    await expect(
      createModelLintFindingsFixer(model)(request(sandbox))
    ).resolves.toStrictEqual({
      model: "openai/gpt-5.1-codex-mini",
      run: {
        failedCalls: [],
        reply: "Removed the debugger statement.",
        steps: 4,
        toolCalls: ["bash (exit 1)", "read_file", "write_file"],
      },
      stopped: false,
    });

    expect(sandbox.run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["-c", "pnpm exec ultracite check"],
        cmd: "bash",
        cwd: "/tmp/repository",
      })
    );
    expect(sandbox.run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["--", "/tmp/repository/src/index.ts"],
        cmd: "cat",
      })
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/tmp/repository/src/index.ts",
      ""
    );
  });

  it("tells the model the check, its output, and the rules", async () => {
    const model = new MockLanguageModelV4({ doGenerate: reply });

    await createModelLintFindingsFixer(model)(request(fakeSandbox()));

    const sent = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(sent).toContain("`pnpm exec ultracite check` fails");
    expect(sent).toContain("src/index.ts: debugger statement");
    expect(sent).toContain("`ultracite fix` changed nothing.");
    expect(sent).toContain("Never turn a finding off");
  });

  it("stops a model that keeps calling tools", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: toolCall("bash", { command: "pnpm exec ultracite check" }),
    });

    await expect(
      createModelLintFindingsFixer(model)(request(fakeSandbox()))
    ).resolves.toMatchObject({
      run: { steps: 40, stopReason: "steps" },
      stopped: true,
    });
    expect(model.doGenerateCalls).toHaveLength(40);
  });

  it("gives the model the automatic fix's diff", async () => {
    const model = new MockLanguageModelV4({ doGenerate: reply });

    await createModelLintFindingsFixer(model)({
      ...request(fakeSandbox()),
      diff: "-# Comic Viewer \n+# Comic Viewer\n",
    });

    const sent = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(sent).toContain("-# Comic Viewer \\n+# Comic Viewer");
  });

  it("applies the patch of an apply_patch command itself", async () => {
    const command = [
      "cd /tmp/repository && apply_patch <<'PATCH'",
      "*** Begin Patch",
      "*** Update File: src/index.ts",
      "-debugger;",
      "+export {};",
      "*** End Patch",
      "PATCH",
    ].join("\n");

    const steps = [toolCall("bash", { command }), reply];

    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(steps.shift() ?? reply),
    });

    const sandbox = fakeSandbox();

    await createModelLintFindingsFixer(model)(request(sandbox));

    expect(sandbox.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "bash" })
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/tmp/repository/src/index.ts",
      "export {};\n"
    );
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
      "Exit code 0\\nApplied the patch to src/index.ts."
    );
  });

  it("applies a second update of a file to the first's result", async () => {
    const command = [
      "apply_patch <<'PATCH'",
      "*** Begin Patch",
      "*** Update File: src/index.ts",
      "-debugger;",
      "+console.log(1);",
      "*** End Patch",
      "*** Begin Patch",
      "*** Update File: ./src/index.ts",
      "-console.log(1);",
      "+export {};",
      "*** End Patch",
      "PATCH",
    ].join("\n");

    const steps = [toolCall("bash", { command }), reply];

    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(steps.shift() ?? reply),
    });

    const sandbox = fakeSandbox();

    await createModelLintFindingsFixer(model)(request(sandbox));

    expect(sandbox.writeFile).toHaveBeenCalledExactlyOnceWith(
      "/tmp/repository/src/index.ts",
      "export {};\n"
    );
  });

  it("changes nothing when a patch does not apply", async () => {
    const command = [
      "apply_patch <<'PATCH'",
      "*** Begin Patch",
      "*** Update File: src/index.ts",
      "-console.log(1);",
      "+export {};",
      "*** End Patch",
      "PATCH",
    ].join("\n");

    const steps = [toolCall("bash", { command }), reply];

    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(steps.shift() ?? reply),
    });

    const sandbox = fakeSandbox();

    await createModelLintFindingsFixer(model)(request(sandbox));

    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
      "Exit code 1\\nThe patch was not applied, and nothing changed: Cannot find these lines"
    );
  });

  it("gives the model a command's output without its color codes", async () => {
    const steps = [
      toolCall("bash", { command: "pnpm exec ultracite check" }),
      reply,
    ];

    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(steps.shift() ?? reply),
    });

    const sandbox = fakeSandbox();
    vi.mocked(sandbox.run).mockResolvedValue({
      exitCode: 1,
      stderr: "",
      stdout: "\u001B[31mdebugger statement\u001B[0m\n",
    });

    await createModelLintFindingsFixer(model)(request(sandbox));

    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
      "Exit code 1\\ndebugger statement\\n"
    );
  });

  it("refuses to return a file too large to read whole", async () => {
    const steps = [toolCall("read_file", { path: "dist/bundle.js" }), reply];

    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(steps.shift() ?? reply),
    });

    const sandbox = fakeSandbox();
    vi.mocked(sandbox.run).mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "x".repeat(200_001),
    });

    await createModelLintFindingsFixer(model)(request(sandbox));

    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
      "dist/bundle.js has 200001 characters, too many to read whole"
    );
  });

  it("keeps what the model did when the deadline cuts a call short", async () => {
    // The first step writes a file; the second call hangs past the deadline.
    const steps = [toolCall("write_file", { content: "", path: "a.ts" })];

    const model = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) => {
        const step = steps.shift();

        return step === undefined
          ? untilAborted(abortSignal)
          : Promise.resolve(step);
      },
      modelId: "openai/gpt-5.1-codex-mini",
    });

    const sandbox = fakeSandbox();

    await expect(
      createModelLintFindingsFixer(model)(request(sandbox, Date.now() + 100))
    ).resolves.toStrictEqual({
      model: "openai/gpt-5.1-codex-mini",
      run: {
        failedCalls: ["no status: The operation was aborted due to timeout"],
        steps: 1,
        stopReason: "deadline",
        toolCalls: ["write_file"],
      },
      stopped: true,
    });
    expect(sandbox.writeFile).toHaveBeenCalledWith("/tmp/repository/a.ts", "");
  });

  it("fails when the deadline passes before the model answers", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) => untilAborted(abortSignal),
    });

    await expect(
      createModelLintFindingsFixer(model)(
        request(fakeSandbox(), Date.now() + 50)
      )
    ).rejects.toThrow("The operation was aborted due to timeout");
  });

  it("cuts a command off at the deadline", async () => {
    const steps = [toolCall("bash", { command: "sleep 600" }), reply];

    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(steps.shift() ?? reply),
    });

    const sandbox = fakeSandbox();

    await createModelLintFindingsFixer(model)(
      request(sandbox, Date.now() + 10_000)
    );

    const [command] = vi.mocked(sandbox.run).mock.calls[0] ?? [];
    expect(command?.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("makes a call AI Gateway refused for the rate limit again when it says", async () => {
    const refused = Object.assign(new Error("Rate limit exceeded"), {
      cause: rateLimited("0"),
      statusCode: 429,
    });

    // More refusals than the AI SDK's own retries would take.
    const calls = [refused, rateLimited("0"), rateLimited("0")];

    const model = new MockLanguageModelV4({
      doGenerate: () => {
        const error = calls.shift();

        return error === undefined
          ? Promise.resolve(reply)
          : Promise.reject(error);
      },
      modelId: "openai/gpt-5.1-codex-mini",
    });

    await expect(
      createModelLintFindingsFixer(model)(request(fakeSandbox()))
    ).resolves.toStrictEqual({
      model: "openai/gpt-5.1-codex-mini",
      run: {
        failedCalls: Array.from(
          { length: 3 },
          () => "429: Rate limit exceeded"
        ),
        reply: "Removed the debugger statement.",
        steps: 1,
        toolCalls: [],
      },
      stopped: false,
    });
    expect(model.doGenerateCalls).toHaveLength(4);
  });

  it("waits out the rate limit only until the deadline", async () => {
    const steps = [toolCall("write_file", { content: "", path: "a.ts" })];

    const model = new MockLanguageModelV4({
      doGenerate: () => {
        const step = steps.shift();

        return step === undefined
          ? Promise.reject(rateLimited("60"))
          : Promise.resolve(step);
      },
      modelId: "openai/gpt-5.1-codex-mini",
    });

    await expect(
      createModelLintFindingsFixer(model)(
        request(fakeSandbox(), Date.now() + 100)
      )
    ).resolves.toStrictEqual({
      model: "openai/gpt-5.1-codex-mini",
      run: {
        failedCalls: ["429: Rate limit exceeded"],
        steps: 1,
        stopReason: "deadline",
        toolCalls: ["write_file"],
      },
      stopped: true,
    });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("fails when the model call fails, with the calls that failed", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          Object.assign(new Error("The gateway is down"), { statusCode: 503 })
        ),
    });

    const failure = createModelLintFindingsFixer(model)(request(fakeSandbox()));

    await expect(failure).rejects.toThrow(LintFindingsRunError);
    await expect(failure).rejects.toMatchObject({
      message: "The gateway is down",
      run: {
        failedCalls: ["503: The gateway is down"],
        steps: 0,
        toolCalls: [],
      },
    });
  });

  it("records that the time to start steps ran out", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: toolCall("bash", { command: "pnpm exec ultracite check" }),
    });

    const sandbox = fakeSandbox();
    vi.useFakeTimers({ toFake: ["Date"] });
    // The first command takes longer than the model may keep starting
    // steps, by the clock alone.
    vi.mocked(sandbox.run).mockImplementation(() => {
      vi.setSystemTime(Date.now() + 91_000);

      return Promise.resolve({
        exitCode: 1,
        stderr: "",
        stdout: "debugger statement\n",
      });
    });

    try {
      await expect(
        createModelLintFindingsFixer(model)(
          request(sandbox, Date.now() + 200_000)
        )
      ).resolves.toMatchObject({
        run: { steps: 1, stopReason: "time" },
        stopped: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
