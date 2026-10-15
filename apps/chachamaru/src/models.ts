// The AI Gateway model IDs the bot uses, all of them here. On Vercel, AI
// Gateway authenticates the deployment through its OIDC token; elsewhere it
// needs AI_GATEWAY_API_KEY, or `eve dev` asks for a connection.
//
// The team is on the AI Gateway free tier, which serves only the models the
// catalog at https://vercel.com/ai-gateway/models marks as available to it;
// a call to any other model fails. Pick a model from those, with tool use.

/**
 * The agent's model, which also chooses the lines of the
 * `minimumReleaseAgeExclude` block the fixed rules cannot sort out, so it
 * needs structured output too.
 */
export const AGENT_MODEL = "openai/gpt-5.2";

/**
 * The model that fixes the lint findings the automatic fix leaves: many
 * small, bounded coding tasks, each within the time a sandbox has left, and
 * checked by the job afterwards. A small coding model does them fast.
 */
export const LINT_FINDINGS_MODEL = "openai/gpt-5.1-codex-mini";
