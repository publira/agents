import type { WorkspaceManifest } from "./manifest.ts";

/** The registry pnpm installs from unless a setting names another. */
export const PUBLIC_NPM_REGISTRY_URL = "https://registry.npmjs.org/";

// Registries pnpm assigns to a scope on its own.
const builtInScopeRegistries = new Map([["@jsr", "https://npm.jsr.io/"]]);

export interface RegistrySettings {
  /** The workspace manifest's `registry` and `registries`. */
  manifest: Pick<WorkspaceManifest, "registries" | "registry">;
  /** The contents of the repository's `.npmrc`, if it has one. */
  npmrc?: string;
}

// `.npmrc` is an INI file of `key=value` lines; a value may be quoted.
const parseNpmrc = (source: string): Map<string, string> => {
  const settings = new Map<string, string>();

  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("=");
    if (trimmed.startsWith("#") || trimmed.startsWith(";") || separator < 1) {
      continue;
    }
    const value = trimmed.slice(separator + 1).trim();
    settings.set(
      trimmed.slice(0, separator).trim(),
      /^(?<quote>["']).*\k<quote>$/u.test(value) ? value.slice(1, -1) : value
    );
  }

  return settings;
};

/**
 * The registry pnpm installs a package from, as the repository's settings
 * configure it. Settings in `pnpm-workspace.yaml` take precedence over
 * `.npmrc`, and a scope's registry over the default one. A value may still
 * hold an environment variable reference such as `${REGISTRY}`.
 */
export const resolvePackageRegistry = (
  name: string,
  { manifest, npmrc = "" }: RegistrySettings
): string => {
  const settings = parseNpmrc(npmrc);
  const scope = name.startsWith("@") ? name.split("/")[0] : undefined;
  const scopeRegistry =
    scope === undefined
      ? undefined
      : (manifest.registries[scope] ??
        settings.get(`${scope}:registry`) ??
        builtInScopeRegistries.get(scope));

  return (
    scopeRegistry ??
    manifest.registries.default ??
    manifest.registry ??
    settings.get("registry") ??
    PUBLIC_NPM_REGISTRY_URL
  );
};
