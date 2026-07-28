export const HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE =
  "homebrew-closed-acceptance";

const HOMEBREW_CLOSED_ACCEPTANCE_INPUTS = [
  "main",
  "kandelo",
  "network",
  "homebrew-vfs-test",
] as const;

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
  const root = configuredRoot?.trim() || undefined;
  const enabled = mode === HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE;
  if (enabled && root === undefined) {
    throw new Error(
      `${HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE} requires ` +
        "VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT",
    );
  }
  if (!enabled && root !== undefined) {
    throw new Error(
      "VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT is permitted only in " +
        HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE,
    );
  }
  return root;
}

/**
 * Closed acceptance needs the real product pages and the otherwise-private
 * lifecycle fixture page in one optimized tree. Other modes return no
 * override so their ordinary input-selection policy remains authoritative.
 */
export function homebrewClosedAcceptanceInputNames(
  mode: string,
): typeof HOMEBREW_CLOSED_ACCEPTANCE_INPUTS | undefined {
  return mode === HOMEBREW_CLOSED_ACCEPTANCE_VITE_MODE
    ? HOMEBREW_CLOSED_ACCEPTANCE_INPUTS
    : undefined;
}
