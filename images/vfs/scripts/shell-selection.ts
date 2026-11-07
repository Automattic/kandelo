/**
 * Which of the shell's packages an image carries.
 *
 * The canonical shell carries every package its dependency contract
 * (packages/registry/shell/source-rootfs-shell-dependencies.json) declares.
 * A PARTIAL shell — built by `./run.sh partial` so a developer can iterate on
 * a few packages without building the whole shell — carries the rootfs base
 * plus the packages they named. The composer asks this module, step by step,
 * whether a package's files belong in the image, and filters the image's
 * activities to the ones whose packages are present.
 *
 * WHY an explicit canonical variant rather than "a partial selection that
 * happens to list everything": the canonical composer's completeness checks
 * must stay exactly as strict as before. Canonical mode is never inferred
 * from a list that might be missing something.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolveDemoRequires,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";

export type ShellSelection =
  | { kind: "canonical" }
  | { kind: "partial"; packages: ReadonlySet<string> };

export const CANONICAL_SHELL_SELECTION: ShellSelection = Object.freeze({
  kind: "canonical",
});

export function partialShellSelection(packages: Iterable<string>): ShellSelection {
  return { kind: "partial", packages: new Set(packages) };
}

/** Whether `pkg`'s files belong in an image composed for `selection`. */
export function selectionIncludes(selection: ShellSelection, pkg: string): boolean {
  return selection.kind === "canonical" || selection.packages.has(pkg);
}

/** A profile left out of a partial image, and the packages it lacked. */
export interface ExcludedProfile {
  profile: string;
  missing: string[];
}

export interface FilteredDemoConfig {
  config: KandeloDemoConfig;
  included: string[];
  excluded: ExcludedProfile[];
}

/**
 * Keep only the profiles whose `requires` packages are all selected.
 *
 * A profile missing a package is left out of the image entirely: an image
 * must not list an activity it cannot run. The canonical selection keeps the
 * config unchanged.
 */
export function filterDemoConfigForSelection(
  config: KandeloDemoConfig,
  selection: ShellSelection,
): FilteredDemoConfig {
  const profiles = config.profiles ?? {};
  if (selection.kind === "canonical") {
    return { config, included: Object.keys(profiles), excluded: [] };
  }
  const kept: Record<string, NonNullable<KandeloDemoConfig["profiles"]>[string]> = {};
  const included: string[] = [];
  const excluded: ExcludedProfile[] = [];
  for (const [profileId, profile] of Object.entries(profiles)) {
    const missing = resolveDemoRequires(config, profileId)
      .filter((pkg) => !selection.packages.has(pkg));
    if (missing.length === 0) {
      kept[profileId] = profile;
      included.push(profileId);
    } else {
      excluded.push({ profile: profileId, missing });
    }
  }
  const filtered: KandeloDemoConfig = { ...config, profiles: kept };
  if (config.defaultProfile !== undefined && !Object.hasOwn(kept, config.defaultProfile)) {
    throw new Error(
      `partial shell dropped the default profile ${config.defaultProfile}; ` +
        "it must not require anything beyond the base",
    );
  }
  validateKandeloDemoConfig(filtered);
  return { config: filtered, included, excluded };
}

const SHELL_DEPENDENCY_CONTRACT = fileURLToPath(
  new URL(
    "../../../packages/registry/shell/source-rootfs-shell-dependencies.json",
    import.meta.url,
  ),
);

/** Every package name the shell's dependency contract declares. */
export function readShellContractPackageNames(
  path = SHELL_DEPENDENCY_CONTRACT,
): ReadonlySet<string> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const dependencies = (value as { dependencies?: unknown }).dependencies;
  if (!Array.isArray(dependencies)) {
    throw new Error(`invalid source-rootfs shell dependency contract: ${path}`);
  }
  return new Set(dependencies.map((entry: { name: string }) => entry.name));
}

/**
 * Every profile's `requires` must name packages the shell actually declares,
 * so a typo or a renamed package cannot quietly drop an activity from every
 * partial image (or keep one whose package no longer exists).
 */
export function requireProfileRequirementsDeclared(
  config: KandeloDemoConfig,
  shellPackages: ReadonlySet<string>,
): void {
  for (const profileId of Object.keys(config.profiles ?? {})) {
    for (const pkg of resolveDemoRequires(config, profileId)) {
      if (!shellPackages.has(pkg)) {
        throw new Error(
          `demo profile ${profileId} requires ${pkg}, which is not a shell package ` +
            "(packages/registry/shell/source-rootfs-shell-dependencies.json)",
        );
      }
    }
  }
}
