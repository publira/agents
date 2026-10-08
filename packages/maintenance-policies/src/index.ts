export type {
  ApprovalPolicyVerdict,
  AutoMergeInput,
  AutoMergeVerdict,
  MergeMethod,
} from "./auto-merge.ts";
export { canAutoMerge } from "./auto-merge.ts";
export type {
  FeatureBump,
  FeatureBumpsVerdict,
  FeatureReference,
  LockedFeature,
  LockFileSyncInput,
  LockFileSyncVerdict,
  ResolvedFeature,
} from "./devcontainer-lock-file.ts";
export {
  devContainerLockFilePathOf,
  findFeatureBumps,
  isDevContainerConfigPath,
  parseFeatureReference,
  syncLockFileEntries,
} from "./devcontainer-lock-file.ts";
export type {
  AccountRef,
  CheckRunInput,
  CommitChecksInput,
  CommitChecksVerdict,
  CommitStatusInput,
  LockFileCommitScope,
  MergedPullRequest,
  PullRequestCommit,
  PullRequestReview,
  RenovateCommitsVerdict,
  RequiredCheckInput,
} from "./equivalent-update-approval.ts";
export {
  evaluateCommitChecks,
  evaluateRenovateCommits,
  findPrecedentApprovers,
  isMaintainerPermission,
  isRenovate,
} from "./equivalent-update-approval.ts";
export type {
  ParentIssueInput,
  ParentIssueVerdict,
} from "./parent-issue-completion.ts";
export { evaluateParentIssue } from "./parent-issue-completion.ts";
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
