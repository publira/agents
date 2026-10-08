export type { FeatureReferencesParseResult } from "./config.ts";
export { parseFeatureReferences } from "./config.ts";
export type {
  LockFileFeature,
  LockFileFormat,
  LockFileParseResult,
} from "./lock-file.ts";
export { formatLockFile, parseLockFile } from "./lock-file.ts";
export type {
  FeatureLocation,
  RegistryOptions,
  ResolvedFeature,
} from "./registry.ts";
export { resolveFeature } from "./registry.ts";
