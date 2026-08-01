/**
 * Canonical paths for Homebrew running inside a Kandelo guest.
 *
 * WHY: Kandelo bottles and VFS metadata need one platform identity that cannot
 * be confused with the separate host-tool Homebrew installation used by
 * native CI. Keep this projection synchronized with
 * homebrew/kandelo-guest-layout.json; the contract test enforces that link.
 */
export const KANDELO_HOMEBREW_GUEST_LAYOUT = Object.freeze({
  prefix: "/opt/kandelo/homebrew",
  cellar: "/opt/kandelo/homebrew/Cellar",
  repository: "/opt/kandelo/homebrew",
  stableEntrypoint: "/usr/bin/brew",
});
