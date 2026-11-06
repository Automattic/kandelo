/** A VFS-image package embeds its own activity declaration in its image. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import { parsePackageSessions, PACKAGE_SESSIONS_DIR, PACKAGE_SESSION_CLIENTS_DIR } from "../../../web-libs/kandelo-session/src/package-sessions";
import { ensureDirRecursive, writeVfsBinary } from "./vfs-image-helpers";
import type { KandeloImageFs } from "../lib/kandelo-image-fs";
export function installImageSessions(fs: KandeloImageFs, name: string, clientOnly = false): void {
  const source = readFileSync(join(findRepoRoot(), "packages/registry", name, "sessions.json"));
  if (parsePackageSessions(source.toString("utf8")).package !== name) throw new Error(`Wrong activity owner: ${name}`);
  const directory = clientOnly ? PACKAGE_SESSION_CLIENTS_DIR : PACKAGE_SESSIONS_DIR;
  ensureDirRecursive(fs, directory);
  writeVfsBinary(fs, `${directory}/${name}.json`, new Uint8Array(source), 0o644);
}
