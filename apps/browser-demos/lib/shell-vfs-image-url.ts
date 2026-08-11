export const SHELL_VFS_IMAGE_PATH_PATTERN_SOURCE = String.raw`(?:^|/)shell\.vfs(?:-[A-Za-z0-9_-]+)?\.zst$`;
export const NODE_VFS_IMAGE_PATH_PATTERN_SOURCE = String.raw`(?:^|/)node-vfs\.vfs(?:-[A-Za-z0-9_-]+)?\.zst$`;

const VFS_IMAGE_PATH_PATTERN_SOURCE = String.raw`(?:^|/)[^/]+\.vfs(?:-[A-Za-z0-9_-]+)?(?:\.zst)?$`;

const shellVfsImagePathPattern = new RegExp(
  SHELL_VFS_IMAGE_PATH_PATTERN_SOURCE,
);
const nodeVfsImagePathPattern = new RegExp(NODE_VFS_IMAGE_PATH_PATTERN_SOURCE);
const vfsImagePathPattern = new RegExp(VFS_IMAGE_PATH_PATTERN_SOURCE);

function pathnameFromUrl(url: string): string | undefined {
  try {
    return new URL(url, "https://kandelo.invalid/").pathname;
  } catch {
    return undefined;
  }
}

/**
 * Identify source and Vite-built VFS artifacts, compressed or uncompressed.
 */
export function isVfsImageUrl(url: string): boolean {
  const pathname = pathnameFromUrl(url);
  return pathname !== undefined && vfsImagePathPattern.test(pathname);
}

/**
 * Identify the canonical shell VFS response in both source and optimized
 * browser builds.
 */
export function isShellVfsImageUrl(url: string): boolean {
  const pathname = pathnameFromUrl(url);
  // WHY: Vite inserts its content hash between `.vfs` and `.zst`; matching
  // only the source filename silently skips the exact bytes served in CI.
  return pathname !== undefined && shellVfsImagePathPattern.test(pathname);
}

/**
 * Identify the Node product VFS response in both source and optimized builds.
 */
export function isNodeVfsImageUrl(url: string): boolean {
  const pathname = pathnameFromUrl(url);
  return pathname !== undefined && nodeVfsImagePathPattern.test(pathname);
}
