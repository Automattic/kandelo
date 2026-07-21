export interface PlaywrightServerEnvironment {
  CI?: string;
  KANDELO_HOMEBREW_MAIN_SHELL_STRICT?: string;
}

/**
 * Reusing a developer's Vite server keeps ordinary local browser tests fast,
 * but an exact-artifact proof must own the server that resolves its binaries.
 * Otherwise a server from another worktree can silently serve different VFS
 * bytes on the same port.
 */
export function shouldReuseExistingPlaywrightServer(
  env: PlaywrightServerEnvironment,
): boolean {
  return !env.CI && env.KANDELO_HOMEBREW_MAIN_SHELL_STRICT !== "1";
}
