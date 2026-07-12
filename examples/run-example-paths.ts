import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

/**
 * Return whether an existing candidate is physically contained by an existing
 * parent directory.
 *
 * The Node-backed guest VFS canonicalizes host paths. Compare canonical paths
 * here as well so aliases such as macOS's /var -> /private/var do not turn an
 * in-workdir guest executable into an apparent escape. Canonicalizing both
 * sides also prevents a symlink below the workdir from escaping this boundary.
 */
export function isWithinRealDirectory(parent: string, candidate: string): boolean {
  const rel = relative(realpathSync(parent), realpathSync(candidate));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
