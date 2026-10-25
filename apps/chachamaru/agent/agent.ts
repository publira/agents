import { defineAgent } from "eve";

import { AGENT_MODEL } from "#ai/models.ts";

export default defineAgent({
  // The agent only reads, through its own tools. Without eve's defaults it
  // has no shell, file, web, or subagent tools, and needs no sandbox.
  defaultTools: false,
  model: AGENT_MODEL,
});
