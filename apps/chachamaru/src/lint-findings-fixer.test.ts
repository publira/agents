import { once } from "node:events";

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createModelLintFindingsFixer } from "./lint-findings-fixer.ts";
import type { Sandbox } from "./sandbox-runner.ts";

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
      modelId: "anthropic/claude-haiku-5.5",
    });
    const sandbox = fakeSandbox();

    await expect(
      createModelLintFindingsFixer(model)(request(sandbox))
    ).resolves.toStrictEqual({
      model: "anthropic/claude-haiku-5.5",
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
    ).resolves.toMatchObject({ stopped: true });
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
      modelId: "anthropic/claude-haiku-5.5",
    });
    const sandbox = fakeSandbox();

    await expect(
      createModelLintFindingsFixer(model)(request(sandbox, Date.now() + 100))
    ).resolves.toStrictEqual({
      model: "anthropic/claude-haiku-5.5",
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

  it("fails when the model call fails", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(new Error("The gateway is down")),
    });

    await expect(
      createModelLintFindingsFixer(model)(request(fakeSandbox()))
    ).rejects.toThrow("The gateway is down");
  });
});
