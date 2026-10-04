export type {
  ApprovalPolicyVerdict,
  AutoMergeInput,
  AutoMergeVerdict,
  MergeMethod,
} from "./auto-merge.ts";
export { canAutoMerge } from "./auto-merge.ts";
export type {
  AccountRef,
  CheckRunInput,
  CommitChecksInput,
  CommitChecksVerdict,
  CommitStatusInput,
  MergedPullRequest,
  PullRequestCommit,
  PullRequestReview,
  RenovateCommitsVerdict,
  RequiredCheckInput,
} from "./equivalent-update-approval.ts";
export {
  evaluateCommitChecks,
  evaluateRenovateCommits,
  findPrecedentApproval,
  isRenovate,
} from "./equivalent-update-approval.ts";
export type {
  ReleaseAgeExclusionInput,
  ReleaseAgeExclusionKeepReason,
  ReleaseAgeExclusionTarget,
  ReleaseAgeExclusionVerdict,
} from "./release-age-exclusion.ts";
export {
  evaluateReleaseAgeExclusion,
  findReleaseAgeExclusionKeepReason,
} from "./release-age-exclusion.ts";
export type {
  RenovateUpdate,
  RenovateUpdatesParseResult,
} from "./renovate-update.ts";
export {
  fingerprintRenovateUpdates,
  formatRenovateUpdate,
  parseRenovateUpdates,
  RENOVATE_LOGIN,
  RENOVATE_UPDATE_MARKER,
} from "./renovate-update.ts";
