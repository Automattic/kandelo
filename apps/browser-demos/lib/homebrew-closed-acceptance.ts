export const HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE =
  "homebrew-closed-acceptance";
export const HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV =
  "VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT";
export const HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV =
  "KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT";
const HOMEBREW_BOOTSTRAP_TREE_ID = "homebrew-bootstrap/source-tree";
const HOMEBREW_BOOTSTRAP_PACKAGE = "homebrew-bootstrap";
const HOMEBREW_BOOTSTRAP_OUTPUT = "homebrew-bootstrap.zip";

const HOMEBREW_CLOSED_ACCEPTANCE_INPUTS = [
  "main",
  "homebrew-vfs-test",
] as const;

export interface HomebrewBootstrapClosedBinding {
  output: typeof HOMEBREW_BOOTSTRAP_OUTPUT;
  url: typeof HOMEBREW_BOOTSTRAP_OUTPUT;
  sha256: string;
  bytes: number;
}

/**
 * Select the exact package-source transport owned by a closed Homebrew image.
 * The main shell deliberately keeps `brew` lazy, so every image derived from
 * that shell must retain this binding along with its inherited lazy tree.
 */
export function homebrewBootstrapClosedBinding(
  metadata: unknown,
): HomebrewBootstrapClosedBinding {
  if (!isPlainRecord(metadata)) {
    throw new Error("closed Homebrew image omits image metadata");
  }
  const packageDeferredTrees = metadata.packageDeferredTrees;
  if (!Array.isArray(packageDeferredTrees)) {
    throw new Error(
      packageDeferredTrees === undefined
        ? "closed Homebrew image omits packageDeferredTrees metadata"
        : "closed Homebrew image has invalid packageDeferredTrees metadata",
    );
  }

  // WHY: a malformed binding may retain either half of its identity. Treat
  // the canonical id OR package name as a claim, then reject the incomplete
  // record instead of silently classifying it as no bootstrap capability.
  const candidates = packageDeferredTrees.filter((value) => {
    if (!isPlainRecord(value)) return false;
    if (value.id === HOMEBREW_BOOTSTRAP_TREE_ID) return true;
    return isPlainRecord(value.package) &&
      value.package.name === HOMEBREW_BOOTSTRAP_PACKAGE;
  });
  if (candidates.length !== 1) {
    throw new Error(
      `closed Homebrew image has ${candidates.length} ` +
        "Homebrew bootstrap bindings",
    );
  }

  const binding = candidates[0]!;
  const packageRecord = binding.package;
  const archiveRecord = binding.archive;
  if (!isPlainRecord(packageRecord) || !isPlainRecord(archiveRecord)) {
    throw invalidBootstrapBinding();
  }
  const sha256 = archiveRecord.sha256;
  const bytes = archiveRecord.bytes;
  if (
    binding.id !== HOMEBREW_BOOTSTRAP_TREE_ID ||
    binding.state !== "deferred" ||
    packageRecord.name !== HOMEBREW_BOOTSTRAP_PACKAGE ||
    packageRecord.output !== HOMEBREW_BOOTSTRAP_OUTPUT ||
    archiveRecord.output !== HOMEBREW_BOOTSTRAP_OUTPUT ||
    archiveRecord.url !== HOMEBREW_BOOTSTRAP_OUTPUT ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  ) {
    throw invalidBootstrapBinding();
  }
  return {
    output: HOMEBREW_BOOTSTRAP_OUTPUT,
    url: HOMEBREW_BOOTSTRAP_OUTPUT,
    sha256,
    bytes,
  };
}

/**
 * Return the exact local mirror root only for the named closed-acceptance
 * build. Vite marks every optimized build as PROD, including this one, so
 * MODE—not DEV/PROD—is the authority that separates a sealed CI proof from a
 * normal product build.
 */
export function homebrewClosedAcceptanceAssetRoot(
  mode: string,
  configuredRoot: string | undefined,
): string | undefined {
  return validateHomebrewClosedAcceptanceRoot(
    mode,
    configuredRoot,
    HOMEBREW_CLOSED_ACCEPTANCE_VITE_ROOT_ENV,
  );
}

export function homebrewClosedAcceptancePlaywrightRoot(
  mode: string,
  configuredRoot: string | undefined,
): string | undefined {
  return validateHomebrewClosedAcceptanceRoot(
    mode,
    configuredRoot,
    HOMEBREW_CLOSED_ACCEPTANCE_PLAYWRIGHT_ROOT_ENV,
  );
}

function validateHomebrewClosedAcceptanceRoot(
  mode: string,
  configuredRoot: string | undefined,
  authorityEnvironmentName: string,
): string | undefined {
  const root = configuredRoot?.trim() || undefined;
  const enabled = mode === HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE;
  if (enabled && root === undefined) {
    throw new Error(
      `${HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE} requires ` +
        authorityEnvironmentName,
    );
  }
  if (!enabled && root !== undefined) {
    throw new Error(
      `${authorityEnvironmentName} is permitted only in ` +
        HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
    );
  }
  return root;
}

function invalidBootstrapBinding(): Error {
  return new Error(
    "closed Homebrew image has an invalid Homebrew bootstrap binding",
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Closed acceptance needs the real root shell page and the otherwise-private
 * lifecycle fixture page in one optimized tree. Full-gallery deployment is a
 * separate Pages gate; admitting those unrelated entries here would make one
 * stale optional image block proof of the shell that users actually launch.
 * Other modes return no override so their ordinary input policy remains
 * authoritative.
 */
export function homebrewClosedAcceptanceInputNames(
  mode: string,
): typeof HOMEBREW_CLOSED_ACCEPTANCE_INPUTS | undefined {
  return mode === HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE
    ? HOMEBREW_CLOSED_ACCEPTANCE_INPUTS
    : undefined;
}
