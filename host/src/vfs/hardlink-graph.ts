export interface HardlinkGraphNode {
  path: string;
  type: "directory" | "file" | "symlink" | "hardlink";
  mode: number;
  size: number;
  target?: string;
  inodeGroup?: string;
}

export interface ResolvedHardlinkGraph {
  canonicalByGroup: ReadonlyMap<string, HardlinkGraphNode>;
  canonicalTargetByPath: ReadonlyMap<string, HardlinkGraphNode>;
}

/**
 * Resolve a closed hard-link graph in linear time.
 *
 * Each hard link is visited at most once. `visiting` detects cycles while the
 * resolved map path-compresses every completed chain to its canonical file.
 */
export function resolveHardlinkGraph(
  nodes: readonly HardlinkGraphNode[],
  label: string,
): ResolvedHardlinkGraph {
  const byPath = new Map<string, HardlinkGraphNode>();
  const canonicalByGroup = new Map<string, HardlinkGraphNode>();
  for (const node of nodes) {
    if (byPath.has(node.path)) {
      throw new Error(`${label} duplicates path ${node.path}`);
    }
    byPath.set(node.path, node);
    if (node.type !== "file") continue;
    if (!node.inodeGroup) {
      throw new Error(`${label} file ${node.path} has no inode group`);
    }
    if (canonicalByGroup.has(node.inodeGroup)) {
      throw new Error(
        `${label} inode group ${node.inodeGroup} has multiple files`,
      );
    }
    canonicalByGroup.set(node.inodeGroup, node);
  }

  const visiting = new Set<string>();
  const canonicalTargetByPath = new Map<string, HardlinkGraphNode>();
  for (const start of nodes) {
    if (start.type !== "hardlink" || canonicalTargetByPath.has(start.path)) {
      continue;
    }

    const chain: HardlinkGraphNode[] = [];
    let cursor = start;
    let canonical: HardlinkGraphNode | undefined;
    while (cursor.type === "hardlink") {
      const compressed = canonicalTargetByPath.get(cursor.path);
      if (compressed) {
        canonical = compressed;
        break;
      }
      if (visiting.has(cursor.path)) {
        throw new Error(`${label} hardlink cycle reaches ${cursor.path}`);
      }
      visiting.add(cursor.path);
      chain.push(cursor);

      if (!cursor.target) {
        throw new Error(`${label} hardlink ${cursor.path} has no target`);
      }
      const target = byPath.get(cursor.target);
      if (!target) {
        throw new Error(
          `${label} hardlink ${cursor.path} target ${cursor.target} is missing`,
        );
      }
      if (
        (target.type !== "file" && target.type !== "hardlink") ||
        !cursor.inodeGroup || target.inodeGroup !== cursor.inodeGroup ||
        target.size !== cursor.size || target.mode !== cursor.mode
      ) {
        throw new Error(`${label} hardlink ${cursor.path} has an invalid target`);
      }
      cursor = target;
    }

    canonical ??= cursor.type === "file" ? cursor : undefined;
    const expected = canonicalByGroup.get(start.inodeGroup ?? "");
    if (!canonical || canonical !== expected) {
      throw new Error(
        `${label} hardlink ${start.path} does not resolve to its inode`,
      );
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const link = chain[index];
      const linkCanonical = canonicalByGroup.get(link.inodeGroup ?? "");
      if (linkCanonical !== canonical) {
        throw new Error(
          `${label} hardlink ${link.path} does not resolve to its inode`,
        );
      }
      visiting.delete(link.path);
      canonicalTargetByPath.set(link.path, canonical);
    }
  }

  return { canonicalByGroup, canonicalTargetByPath };
}
