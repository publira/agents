/**
 * A package selector as `minimumReleaseAgeExclude` accepts it: a name or a
 * name pattern, optionally followed by `@` and versions joined with `||`.
 * https://pnpm.io/settings#minimumreleaseageexclude
 */
export interface PackageSelector {
  /** The package name, or a pattern such as `@publira/*`. */
  name: string;
  /** The exact versions selected. Empty when every version is selected. */
  versions: string[];
}

const invalidSelector = (selector: string): Error =>
  new Error(`Invalid package selector: ${JSON.stringify(selector)}`);

export const parsePackageSelector = (selector: string): PackageSelector => {
  const trimmed = selector.trim();
  // A scope's leading `@` is part of the name, so look for the separator
  // after it.
  const separator = trimmed.indexOf("@", 1);

  if (separator === -1) {
    if (trimmed === "") {
      throw invalidSelector(selector);
    }
    return { name: trimmed, versions: [] };
  }

  const versions = trimmed
    .slice(separator + 1)
    .split("||")
    .map((version) => version.trim())
    .filter((version) => version !== "");

  if (versions.length === 0) {
    throw invalidSelector(selector);
  }

  return { name: trimmed.slice(0, separator), versions };
};
