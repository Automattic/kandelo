import { installImageSessions } from "./image-session-files";
/** Image composition selects capabilities; packages own their procedures. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPackageRuntimeFileContract } from "../../../scripts/package-runtime-file";
import { parsePackageSessions, PACKAGE_SESSIONS_DIR } from "../../../web-libs/kandelo-session/src/package-sessions";
import { ensureDirRecursive, writeVfsBinary } from "./vfs-image-helpers";
import type { KandeloImageFs } from "../lib/kandelo-image-fs";
import type { ShellLazyArchiveResolver } from "./shell-lazy-archives";

export const SHELL_SESSION_PACKAGES = ["fbdoom", "termchat", "tyrquake", "freeciv-browser-bundle", "netcat", "python-browser-bundle", "php"] as const;

export const SHELL_SESSION_IMAGE_PACKAGES = ["nginx-vfs", "nginx-php-vfs", "nginx-python-vfs", "wordpress", "lamp", "ruby-todo-vfs", "redis-vfs", "web-stack-vfs", "wordpress-family-vfs"] as const;

export function installPackageSessionFiles(
  fs: KandeloImageFs,
  resolveArtifact: ShellLazyArchiveResolver,
  includesPackage: (pkg: string) => boolean = () => true,
): void {
  for (const name of SHELL_SESSION_IMAGE_PACKAGES) installImageSessions(fs, name, true);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  for (const name of SHELL_SESSION_PACKAGES) {
    // A partial shell carries only its selected packages' activities.
    if (!includesPackage(name)) continue;
    // Activity helper programs (doom-activity, quake-data, ...) are lazy files
    // in SHELL_LAZY_BINARY_SPECS; only the session manifest is eager.
    const contract = readPackageRuntimeFileContract(root, name, "sessions.json");
    const bytes = new Uint8Array(readFileSync(resolveArtifact(`programs/${contract.mirrorPath}`, name)));
    const manifest = parsePackageSessions(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (manifest.package !== name || contract.guestPath !== `${PACKAGE_SESSIONS_DIR}/${name}.json` || contract.mode !== 0o644) {
      throw new Error(`Invalid package session installation contract for ${name}`);
    }
    ensureDirRecursive(fs, PACKAGE_SESSIONS_DIR);
    writeVfsBinary(fs, contract.guestPath, bytes, contract.mode);
  }
}
