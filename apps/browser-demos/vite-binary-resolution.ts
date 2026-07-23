export interface BrowserBinaryResolution {
  resolve(relPath: string): string | null;
}

export interface BrowserBinaryResolutionDependencies {
  normalizeRelPath(relPath: string): string;
  resolveBatch(relPaths: readonly string[]): Array<string | null>;
  resolveOne(relPath: string): string | null;
  approve(file: string): string;
  candidateEntryExists(relPath: string): boolean;
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
  let resolvedByRelPath: Map<string, string | null> | null = null;

  function checkedGraph(): Map<string, string | null> {
    if (resolvedByRelPath !== null) return resolvedByRelPath;
    // Absence needs no provenance check because there are no bytes to serve.
    // If a mirror appears later, resolve() re-enters the checked scalar path.
    const initialPaths = normalizedRelPaths.some(
      dependencies.candidateEntryExists,
    )
      ? dependencies.resolveBatch(normalizedRelPaths)
      : normalizedRelPaths.map(() => null);
    if (initialPaths.length !== normalizedRelPaths.length) {
      throw new Error(
        "Browser binary batch resolver returned the wrong number of entries",
      );
    }
    const nextResolvedByRelPath = new Map<string, string | null>();
    for (const [index, relPath] of normalizedRelPaths.entries()) {
      const resolved = initialPaths[index] ?? null;
      nextResolvedByRelPath.set(
        relPath,
        resolved === null ? null : dependencies.approve(resolved),
      );
    }
    // Publish the cache only after every exact capability is approved. A
    // failed batch stays fail-closed and a later Vite request may retry after
    // the package projection or filesystem problem has been repaired.
    resolvedByRelPath = nextResolvedByRelPath;
    return resolvedByRelPath;
  }

  return {
    resolve(relPath: string): string | null {
      // Some Vite consumers only exercise HTML/service-worker behavior and
      // intentionally have neither the package toolchain nor any package
      // artifacts installed. Preserve that boundary by running the one full
      // graph check only when candidate package bytes actually exist.
      const checked = checkedGraph();
      const normalized = dependencies.normalizeRelPath(relPath);
      const cached = checked.get(normalized);
      if (cached !== undefined && cached !== null) return cached;

      // Optional artifacts may be installed while Vite is already running.
      // Avoid repeating the expensive source-projection check for ordinary
      // misses; re-enter it only after a mirror entry actually appears.
      if (!dependencies.candidateEntryExists(normalized)) return null;

      const resolved = dependencies.resolveOne(normalized);
      const approved = resolved === null
        ? null
        : dependencies.approve(resolved);
      checked.set(normalized, approved);
      return approved;
    },
  };
}
