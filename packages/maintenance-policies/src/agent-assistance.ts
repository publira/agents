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
  /** The messages of its commits, as far as GitHub lists them. */
  commitMessages: readonly string[];
  /**
   * How many commits it has. GitHub lists at most 250 of a pull request's
   * commits, so the messages can fall short of this.
   */
  commitCount: number;
  /** The names of the labels it carries now. */
  labels: readonly string[];
  /**
   * Whether {@link AI_ASSISTED_LABEL} can be added: `active` when the
   * repository defines it, `archived` when it archived the label, which
   * GitHub refuses to add, and `missing` when it does not define it.
   */
  labelState: "active" | "archived" | "missing";
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
 * created in a repository that does not define it, nor added once archived.
 * The label stays on a pull
 * request whose commits GitHub does not list in full, since a trailer may be
 * in one it leaves out.
 */
export const evaluateAgentAssistanceLabel = ({
  draft,
  commitMessages,
  commitCount,
  labels,
  labelState,
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
    return commitMessages.length < commitCount
      ? leave(
          `GitHub lists only ${commitMessages.length} of its ${commitCount} commits`
        )
      : { action: "remove" };
  }
  if (labelState === "missing") {
    return leave(
      `the repository does not define the ${AI_ASSISTED_LABEL} label`
    );
  }
  if (labelState === "archived") {
    return leave(`the repository archived the ${AI_ASSISTED_LABEL} label`);
  }
  return { action: "add" };
};
