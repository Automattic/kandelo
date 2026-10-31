import { installImageSessions } from "./image-session-files";
/** Image composition selects capabilities; packages own their procedures. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPackageRuntimeFileContract } from "../../../scripts/package-runtime-file";
import { CREDENTIAL_REQUESTS_DIR, parseCredentialRequests } from "../../../host/src/credential-requests";
import { parsePackageSessions, PACKAGE_SESSIONS_DIR } from "../../../web-libs/kandelo-session/src/package-sessions";
import { ensureDirRecursive, writeVfsBinary } from "./vfs-image-helpers";
import type { KandeloImageFs } from "../lib/kandelo-image-fs";
import type { ShellLazyArchiveResolver } from "./shell-lazy-archives";

export const SHELL_SESSION_PACKAGES = ["fbdoom", "termchat", "tyrquake", "freeciv-browser-bundle", "netcat", "python-browser-bundle", "php"] as const;

export const SHELL_SESSION_IMAGE_PACKAGES = ["nginx-vfs", "nginx-php-vfs", "nginx-python-vfs", "wordpress", "lamp", "ruby-todo-vfs", "redis-vfs"] as const;

export const SHELL_SESSION_HELPERS: Record<string, string[]> = { fbdoom: ["doom-activity"], tyrquake: ["quake-data", "quake-activity"] };

/** Package-owned configuration the shell installs at each file's declared guest path. */
export const SHELL_PACKAGE_RUNTIME_FILES: Record<string, string[]> = { codex: ["config.toml", "credential-requests.json"] };

export function installPackageSessionFiles(fs: KandeloImageFs, resolveArtifact: ShellLazyArchiveResolver): void {
  for (const name of SHELL_SESSION_IMAGE_PACKAGES) installImageSessions(fs, name, true);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  for (const [name, artifacts] of Object.entries(SHELL_PACKAGE_RUNTIME_FILES)) {
    for (const artifact of artifacts) {
      const file = readPackageRuntimeFileContract(root, name, artifact);
      ensureDirRecursive(fs, file.guestPath.slice(0, file.guestPath.lastIndexOf("/")));
      const bytes = new Uint8Array(readFileSync(resolveArtifact(`programs/${file.mirrorPath}`, name)));
      // A malformed declaration must fail the image build, not the first launch.
      if (file.guestPath.startsWith(`${CREDENTIAL_REQUESTS_DIR}/`)) {
        parseCredentialRequests(new Map([[file.guestPath.slice(file.guestPath.lastIndexOf("/") + 1), bytes]]));
      }
      writeVfsBinary(fs, file.guestPath, bytes, file.mode);
    }
  }
  for (const name of SHELL_SESSION_PACKAGES) {
    for (const artifact of SHELL_SESSION_HELPERS[name] ?? []) {
      const file = readPackageRuntimeFileContract(root, name, artifact);
      ensureDirRecursive(fs, file.guestPath.slice(0, file.guestPath.lastIndexOf("/")));
      writeVfsBinary(fs, file.guestPath, new Uint8Array(readFileSync(resolveArtifact(`programs/${file.mirrorPath}`, name))), file.mode);
    }
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
