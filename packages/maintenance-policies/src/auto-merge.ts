export type MergeMethod = "MERGE" | "REBASE" | "SQUASH";

/** The approval policy's verdict, evaluated again for the merge. */
export type ApprovalPolicyVerdict =
  | { approvable: true; headSha: string }
  | { approvable: false; reason: string };

export interface AutoMergeInput {
  /** Whether auto-merge is turned on. */
  enabled: boolean;
  /** The pull request's head as GitHub reports it now. */
  headSha: string;
  /** Whether the bot's own approval of the head stands, not dismissed. */
  approvedByBot: boolean;
  /**
   * The approval policy evaluated again on the head, `undefined` when it was
   * not because the bot's approval does not stand.
   */
  approval: ApprovalPolicyVerdict | undefined;
  /** GitHub's merge state, such as `CLEAN`, `BLOCKED`, or `DIRTY`. */
  mergeStateStatus: string;
  /** Whether the pull request changes a file under `.github/workflows/`. */
  changesWorkflows: boolean;
  /** What the base branch's rulesets require of a merge. */
  rules: {
    requiredApprovingReviewCount: number;
    dismissesStaleReviewsOnPush: boolean;
    /** `undefined` when no ruleset restricts the merge methods. */
    allowedMergeMethods: readonly MergeMethod[] | undefined;
  };
  repository: {
    autoMergeAllowed: boolean;
    /** The merge methods the repository's settings allow. */
    mergeMethods: readonly MergeMethod[];
  };
}

export type AutoMergeVerdict =
  | { result: "merge"; mergeMethod: MergeMethod }
  | { result: "declined"; reason: string };

// Publira squash-merges, so a squash is taken whenever it is allowed.
const PREFERRED_METHODS: readonly MergeMethod[] = ["SQUASH", "MERGE", "REBASE"];

const shortSha = (sha: string) => sha.slice(0, 7);

const decline = (reason: string): AutoMergeVerdict => ({
  reason,
  result: "declined",
});

/**
 * Decides whether the bot may have GitHub merge an approved Renovate pull
 * request, and with which method. It is a decision of its own on top of the
 * approval policy: the bot's approval of the current head has to stand, and
 * the approval policy has to hold again on that head.
 *
 * GitHub stays the authority on the merge: the decision only lets the bot
 * enable auto-merge, or queue the pull request, for the head it was made for,
 * and GitHub still enforces the required checks and every other rule. The
 * base branch therefore has to require an approval that a push dismisses, so
 * that a new head is blocked until it is approved again: the decision does
 * not carry over to another head.
 */
export const canAutoMerge = ({
  enabled,
  headSha,
  approval,
  approvedByBot,
  mergeStateStatus,
  changesWorkflows,
  rules,
  repository,
}: AutoMergeInput): AutoMergeVerdict => {
  if (!enabled) {
    return decline("auto-merge is disabled");
  }
  if (!approvedByBot) {
    return decline(`the bot's approval of ${shortSha(headSha)} does not stand`);
  }
  if (approval === undefined) {
    return decline("the approval policy was not evaluated again");
  }
  if (!approval.approvable) {
    return decline(`the approval policy does not hold: ${approval.reason}`);
  }
  if (approval.headSha !== headSha) {
    return decline(
      `the approval policy was evaluated on ${shortSha(approval.headSha)}, but the head is ${shortSha(headSha)}`
    );
  }
  if (mergeStateStatus === "DIRTY") {
    return decline("it has conflicts");
  }
  if (mergeStateStatus === "DRAFT") {
    return decline("it is a draft");
  }
  if (changesWorkflows) {
    return decline(
      "it changes .github/workflows/, which the App cannot merge without the Workflows permission"
    );
  }
  if (
    rules.requiredApprovingReviewCount < 1 ||
    !rules.dismissesStaleReviewsOnPush
  ) {
    return decline(
      "the base branch's rulesets do not require an approval that a push dismisses, so GitHub would not hold back a new head"
    );
  }
  if (!repository.autoMergeAllowed) {
    return decline("the repository does not allow auto-merge");
  }

  const mergeMethod = PREFERRED_METHODS.find(
    (method) =>
      repository.mergeMethods.includes(method) &&
      (rules.allowedMergeMethods === undefined ||
        rules.allowedMergeMethods.includes(method))
  );

  return mergeMethod === undefined
    ? decline(
        "no merge method is allowed by both the repository's settings and its rulesets"
      )
    : { mergeMethod, result: "merge" };
};
