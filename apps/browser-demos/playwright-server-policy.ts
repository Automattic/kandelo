export interface PlaywrightServerEnvironment {
  CI?: string;
  KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT?: string;
  KANDELO_CANONICAL_FLAT_SHELL_STRICT?: string;
  KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE?: string;
  KANDELO_HOMEBREW_MAIN_SHELL_STRICT?: string;
  KANDELO_NODE_VFS_STRICT?: string;
  KANDELO_PLAYWRIGHT_SERVE_DIST?: string;
  KANDELO_SOURCE_ROOTFS_SHELL_STRICT?: string;
}

export function playwrightTestIgnoreForEnvironment(
  env: PlaywrightServerEnvironment,
): RegExp[] {
  return env.KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT === undefined
    ? [/abi-staging-pages-assembled-site\.spec\.ts$/]
    : [];
}

/**
 * Reusing a developer's Vite server keeps ordinary local browser tests fast,
 * but production-preview and exact-artifact proofs must own the server that
 * resolves their binaries. Otherwise a server from another worktree can
 * silently serve different VFS bytes on the same port.
 */
export function shouldReuseExistingPlaywrightServer(
  env: PlaywrightServerEnvironment,
): boolean {
  return (
    !env.CI &&
    env.KANDELO_CANONICAL_FLAT_SHELL_STRICT !== "1" &&
    env.KANDELO_HOMEBREW_MAIN_SHELL_STRICT !== "1" &&
    env.KANDELO_NODE_VFS_STRICT !== "1" &&
    env.KANDELO_PLAYWRIGHT_SERVE_DIST !== "1" &&
    env.KANDELO_SOURCE_ROOTFS_SHELL_STRICT !== "1" &&
    env.KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE !== "1"
  );
}
