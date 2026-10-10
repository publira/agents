import { defineAgent } from "eve";

export default defineAgent({
  // The agent only reads, through its own tools. Without eve's defaults it
  // has no shell, file, web, or subagent tools, and needs no sandbox.
  defaultTools: false,
  model: "anthropic/claude-sonnet-5.5",
});
