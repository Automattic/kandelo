export interface BrowserBinaryResolution {
  resolve(relPath: string): string | null;
}

export interface BrowserBinaryResolutionDependencies {
  normalizeRelPath(relPath: string): string;
  resolveBatch(relPaths: readonly string[]): Array<string | null>;
  resolveOne(relPath: string): string | null;
  approve(file: string): string;
  mirrorEntryExists(relPath: string): boolean;
}

/**
 * Resolve the complete authored browser artifact graph at one checked
 * boundary, then serve later Vite requests from exact cached capabilities.
 */
export function createBatchedBrowserBinaryResolution(
  declaredRelPaths: readonly string[],
  dependencies: BrowserBinaryResolutionDependencies,
): BrowserBinaryResolution {
  const normalizedRelPaths = [
    ...new Set(
      declaredRelPaths.map((relPath) =>
        dependencies.normalizeRelPath(relPath)
      ),
    ),
  ];
  const initialPaths = dependencies.resolveBatch(normalizedRelPaths);
  if (initialPaths.length !== normalizedRelPaths.length) {
    throw new Error(
      "Browser binary batch resolver returned the wrong number of entries",
    );
  }

  const resolvedByRelPath = new Map<string, string | null>();
  for (const [index, relPath] of normalizedRelPaths.entries()) {
    const resolved = initialPaths[index] ?? null;
    resolvedByRelPath.set(
      relPath,
      resolved === null ? null : dependencies.approve(resolved),
    );
  }

  return {
    resolve(relPath: string): string | null {
      const normalized = dependencies.normalizeRelPath(relPath);
      const cached = resolvedByRelPath.get(normalized);
      if (cached !== undefined && cached !== null) return cached;

      // Optional artifacts may be installed while Vite is already running.
      // Avoid repeating the expensive source-projection check for ordinary
      // misses; re-enter it only after a mirror entry actually appears.
      if (!dependencies.mirrorEntryExists(normalized)) return null;

      const resolved = dependencies.resolveOne(normalized);
      const approved = resolved === null
        ? null
        : dependencies.approve(resolved);
      resolvedByRelPath.set(normalized, approved);
      return approved;
    },
  };
}
