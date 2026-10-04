import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createModelExclusionEditor } from "./exclusion-editor.ts";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 1,
  },
  outputTokens: { reasoning: undefined, text: undefined, total: 1 },
};

describe(createModelExclusionEditor, () => {
  it("asks the model for the lines to delete", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: '{"deleteLines":[2,3]}', type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        response: { modelId: "anthropic/claude-sonnet-5.5" },
        usage,
        warnings: [],
      },
    });
    const editor = createModelExclusionEditor(model);

    await expect(
      editor({
        lines: [
          "minimumReleaseAgeExclude:",
          "  # The Next.js security release and the webpack fix it needs.",
          "  - next@16.3.8",
          "  - webpack@5.102.1",
        ],
        reason: "a comment describes entries of which only some are removed",
        selectors: ["next@16.3.8"],
      })
    ).resolves.toStrictEqual({
      lineNumbers: [2, 3],
      model: "anthropic/claude-sonnet-5.5",
    });

    const sent = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(sent).toContain("- next@16.3.8");
    expect(sent).toContain("3:   - next@16.3.8");
    expect(sent).toContain("do not judge it");
  });

  it("rejects an answer that is not line numbers", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: '{"deleteLines":["next@16.3.8"]}', type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage,
        warnings: [],
      },
    });

    await expect(
      createModelExclusionEditor(model)({
        lines: ["minimumReleaseAgeExclude:", "  - next@16.3.8"],
        reason: "removing every entry leaves minimumReleaseAgeExclude empty",
        selectors: ["next@16.3.8"],
      })
    ).rejects.toThrow("No object generated");
  });
});
