/** The label that marks a pull request whose commits disclose an agent. */
export const AI_ASSISTED_LABEL = "ai-assisted";

// The `Assisted-by: <agent>:<model>` trailer. Git matches a trailer token
// case-insensitively, so `assisted-by:` is the same disclosure.
const ASSISTED_BY_TRAILER = /^assisted-by:[ \t]*\S/imu;

/** Whether a commit message discloses a coding agent's help. */
export const disclosesAgentAssistance = (message: string): boolean =>
  ASSISTED_BY_TRAILER.test(message);

export interface AgentAssistanceLabelInput {
  /** Whether the pull request is a draft, which is labelled once ready. */
  draft: boolean;
  /** The messages of all of its commits. */
  commitMessages: readonly string[];
  /** The names of the labels it carries now. */
  labels: readonly string[];
  /** Whether the repository defines {@link AI_ASSISTED_LABEL}. */
  labelDefined: boolean;
}

export type AgentAssistanceLabelVerdict =
  | { action: "add" }
  | { action: "remove" }
  | { action: "leave"; reason: string };

const leave = (reason: string): AgentAssistanceLabelVerdict => ({
  action: "leave",
  reason,
});

/**
 * Decides whether a pull request carries {@link AI_ASSISTED_LABEL}: it does
 * exactly when one of its commits has an `Assisted-by:` trailer. The trailers
 * are the only source of truth, so a pull request that loses its agent
 * commits to a force-push loses the label with them, and the label is never
 * created in a repository that does not define it.
 */
export const evaluateAgentAssistanceLabel = ({
  draft,
  commitMessages,
  labels,
  labelDefined,
}: AgentAssistanceLabelInput): AgentAssistanceLabelVerdict => {
  if (draft) {
    return leave("it is a draft");
  }

  const assisted = commitMessages.some(disclosesAgentAssistance);
  const labelled = labels.includes(AI_ASSISTED_LABEL);

  if (assisted === labelled) {
    return leave(
      assisted
        ? "it is already labelled"
        : "no commit discloses an agent, and it is not labelled"
    );
  }
  if (!assisted) {
    return { action: "remove" };
  }
  if (!labelDefined) {
    return leave(
      `the repository does not define the ${AI_ASSISTED_LABEL} label`
    );
  }
  return { action: "add" };
};
