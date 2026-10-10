// The AI Gateway model IDs the bot uses, all of them here. On Vercel, AI
// Gateway authenticates the deployment through its OIDC token; elsewhere it
// needs AI_GATEWAY_API_KEY, or `eve dev` asks for a connection.

/**
 * The agent's model, which also chooses the lines of the
 * `minimumReleaseAgeExclude` block the fixed rules cannot sort out.
 */
export const AGENT_MODEL = "anthropic/claude-sonnet-5.5";

/**
 * The model that fixes the lint findings the automatic fix leaves: many
 * small, bounded coding tasks, each within the time a sandbox has left, and
 * checked by the job afterwards.
 */
export const LINT_FINDINGS_MODEL = "anthropic/claude-haiku-5.5";
