export interface PlaywrightServerEnvironment {
  CI?: string;
  KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT?: string;
  KANDELO_ABI_STAGING_BROWSER_OBSERVATION?: string;
  KANDELO_ABI_STAGING_BROWSER_SESSION?: string;
  KANDELO_CANONICAL_FLAT_SHELL_STRICT?: string;
  KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE?: string;
  KANDELO_HOMEBREW_MAIN_SHELL_STRICT?: string;
  KANDELO_NODE_VFS_STRICT?: string;
  KANDELO_PLAYWRIGHT_SERVE_DIST?: string;
  KANDELO_SOURCE_ROOTFS_SHELL_STRICT?: string;
}

export function playwrightTestIgnoreForEnvironment(
  env: PlaywrightServerEnvironment,
  argv: readonly string[] = [],
): RegExp[] {
  const ignored: RegExp[] = [];
  if (env.KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT === undefined) {
    ignored.push(/abi-staging-pages-assembled-site\.spec\.ts$/);
  }
  // Ordinary browser runs have no protected evidence handoff. Keep an
  // explicitly named evidence spec visible so its missing-input check fails
  // loudly instead of turning a broken direct gate into a silent skip.
  if (
    !argv.some((argument) =>
      /(?:^|[/\\])abi-staging-product-evidence\.spec\.ts(?::\d+)?$/.test(
        argument,
      )
    ) &&
    (
      env.KANDELO_ABI_STAGING_BROWSER_SESSION === undefined ||
      env.KANDELO_ABI_STAGING_BROWSER_OBSERVATION === undefined
    )
  ) {
    ignored.push(/abi-staging-product-evidence\.spec\.ts$/);
  }
  return ignored;
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
