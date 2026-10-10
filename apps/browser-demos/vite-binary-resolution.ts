export interface BrowserBinaryResolution {
  resolve(relPath: string): string | null;
}

export interface BrowserBinaryResolutionDependencies {
  normalizeRelPath(relPath: string): string;
  resolveBatch(relPaths: readonly string[]): Array<string | null>;
  resolveOne(relPath: string): string | null;
  approveBatch(files: readonly string[]): string[];
  approve(file: string): string;
  candidateEntryExists(relPath: string): boolean;
}

/**
 * Check required artifacts together, admitting optional artifacts only when
 * requested. Each admission rechecks the whole active graph before publishing
 * exact capabilities, preserving the resolver's single provenance tier.
 */
export function createBatchedBrowserBinaryResolution(
  declaredRelPaths: readonly string[],
  dependencies: BrowserBinaryResolutionDependencies,
  optionalRelPaths: readonly string[] = [],
): BrowserBinaryResolution {
  const normalizedRelPaths = [
    ...new Set(
      declaredRelPaths.map((relPath) =>
        dependencies.normalizeRelPath(relPath)
      ),
    ),
  ];
  const declaredRelPathSet = new Set(normalizedRelPaths);
  const optionalRelPathSet = new Set(
    optionalRelPaths.map((path) => dependencies.normalizeRelPath(path)),
  );
  let admittedRelPaths = normalizedRelPaths.filter(
    (path) => !optionalRelPathSet.has(path),
  );
  let resolvedByRelPath: Map<string, string | null> | null = null;

  function buildCheckedGraph(relPaths = admittedRelPaths): Map<string, string | null> {
    // Absence needs no provenance check because there are no bytes to serve.
    // If a declared mirror appears later, resolve() rebuilds this complete
    // graph so a multi-file package still comes from one pinned generation.
    const resolvedPaths = relPaths.some(
      dependencies.candidateEntryExists,
    )
      ? dependencies.resolveBatch(relPaths)
      : relPaths.map(() => null);
    if (resolvedPaths.length !== relPaths.length) {
      throw new Error(
        "Browser binary batch resolver returned the wrong number of entries",
      );
    }

    const files = resolvedPaths.filter(
      (resolved): resolved is string => resolved !== null,
    );
    const approvedFiles = dependencies.approveBatch(files);
    if (approvedFiles.length !== files.length) {
      throw new Error(
        "Browser binary capability approver returned the wrong number of entries",
      );
    }

    const nextResolvedByRelPath = new Map<string, string | null>();
    let approvedIndex = 0;
    for (const [index, relPath] of relPaths.entries()) {
      const resolved = resolvedPaths[index] ?? null;
      nextResolvedByRelPath.set(
        relPath,
        resolved === null ? null : approvedFiles[approvedIndex++]!,
      );
    }
    return nextResolvedByRelPath;
  }

  function checkedGraph(): Map<string, string | null> {
    if (resolvedByRelPath !== null) return resolvedByRelPath;
    const nextResolvedByRelPath = buildCheckedGraph();
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

      // A lazy glob is an optional dependency until its loader is called.
      // Join it to the active graph and validate every admitted request together;
      // an unrelated absent or rejected optional asset must not poison boot.
      if (!dependencies.candidateEntryExists(normalized)) return null;
      if (declaredRelPathSet.has(normalized)) {
        const nextRelPaths = admittedRelPaths.includes(normalized)
          ? admittedRelPaths : [...admittedRelPaths, normalized];
        const nextResolvedByRelPath = buildCheckedGraph(nextRelPaths);
        admittedRelPaths = nextRelPaths;
        resolvedByRelPath = nextResolvedByRelPath;
        return nextResolvedByRelPath.get(normalized) ?? null;
      }

      // Truly undeclared requests cannot participate in the authored graph.
      // The canonical scalar resolver still discovers and pins the requested
      // member's complete package closure before returning its exact path.
      const resolved = dependencies.resolveOne(normalized);
      const approved = resolved === null
        ? null
        : dependencies.approve(resolved);
      checked.set(normalized, approved);
      return approved;
    },
  };
}
