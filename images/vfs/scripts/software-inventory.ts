import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { ensureDirRecursive } from "../../../host/src/vfs/image-helpers";
import { extractZipEntry, parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import { KandeloImageFs } from "../lib/kandelo-image-fs";

export const INSTALLED_SOFTWARE = "/var/lib/kandelo/packages/installed";
export type SoftwareFamily = "base-shell" | "web-stack" | "wordpress-family";
export interface SoftwareContract { programAbi: number; programDigest: string }

const softwareRoots = ["/bin", "/sbin", "/lib", "/usr", "/etc", "/var/www"];
const preservedRoots = [
  "/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow",
  "/etc/hosts", "/etc/hostname", "/etc/resolv.conf", "/etc/localtime",
  "/etc/machine-id", "/etc/kandelo/enabled-service", "/etc/kandelo/initial-service",
  "/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt",
  "/etc/kandelo/enabled-service.pending", "/etc/kandelo/wordpress-secrets.php",
  "/etc/kandelo/wordpress-backend",
  "/var/www/html/wp-config.php", "/var/www/html/wp-content/uploads",
  "/var/www/html/wp-content/database", "/var/www/html/wp-content/db.php",
];

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function ownsSoftwarePath(path: string, family: SoftwareFamily): boolean {
  if (preservedRoots.some(root => within(path, root))) return false;
  return softwareRoots.some(root => within(path, root)) ||
    (family === "web-stack" && path === "/var/lib/todo/server.rb");
}

export function currentSoftwareContract(): SoftwareContract {
  const tool = process.env.WASM_POSIX_XTASK_BIN;
  if (!tool) throw new Error("Software inventory requires the resolver's WASM_POSIX_XTASK_BIN");
  const programDigest = execFileSync(tool, ["abi-program-digest", resolve(import.meta.dirname, "../../../abi/snapshot.json")],
    { encoding: "utf8", maxBuffer: 4096 }).trim();
  if (!/^[0-9a-f]{64}$/.test(programDigest)) throw new Error("Invalid native program contract digest");
  return { programAbi: ABI_VERSION, programDigest };
}

export function softwarePaths(fs: KandeloImageFs, family: SoftwareFamily): string[] {
  const paths: string[] = [];
  const pending = ["/"];
  while (pending.length) {
    const path = pending.pop()!;
    if (preservedRoots.some(root => within(path, root))) continue;
    if (ownsSoftwarePath(path, family)) paths.push(path);
    if ((fs.lstat(path).mode & 0o170000) !== 0o040000) continue;
    const directory = fs.opendir(path);
    try {
      for (let entry = fs.readdir(directory); entry; entry = fs.readdir(directory)) {
        if (entry.name !== "." && entry.name !== "..") pending.push(`${path === "/" ? "" : path}/${entry.name}`);
      }
    } finally { fs.closedir(directory); }
  }
  return paths.sort();
}

export function archiveMemberDigests(
  fs: KandeloImageFs, archivePath: (uri: string) => string,
): Map<string, string> {
  const result = new Map<string, string>();
  const lazy = fs.lazyEntries();
  for (const archive of lazy.archives) {
    const members = lazy.files.filter(file => file.archiveId === archive.archiveId && file.digest.every(byte => byte === 0));
    if (members.length === 0) continue;
    const bytes = new Uint8Array(readFileSync(archivePath(archive.uri)));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== archive.bytes || sha256 !== Buffer.from(archive.digest).toString("hex")) {
      throw new Error(`Software archive does not match its image binding: ${archive.uri}`);
    }
    const entries = new Map(parseZipCentralDirectory(bytes).map(entry => [entry.fileName, entry]));
    for (const file of members) {
      const entry = entries.get(file.sourcePath);
      if (!entry || entry.isDirectory || entry.isSymlink || entry.uncompressedSize !== file.size) {
        throw new Error(`Software archive member mismatch: ${file.path}`);
      }
      result.set(file.path, createHash("sha256").update(extractZipEntry(bytes, entry)).digest("hex"));
    }
  }
  return result;
}

export function installSoftwareInventory(
  fs: KandeloImageFs, family: SoftwareFamily,
  options: { contract: SoftwareContract; parentInventory?: Uint8Array; deferredDigests?: ReadonlyMap<string, string> },
): Uint8Array {
  const inventory = fs.buildPackageInventory({
    ...options.contract, name: `kandelo-${family}`, version: "1",
    paths: softwarePaths(fs, family), parentInventory: options.parentInventory,
    deferredDigests: options.deferredDigests,
  });
  ensureDirRecursive(fs, "/var/lib/kandelo", 0o755);
  ensureDirRecursive(fs, "/var/lib/kandelo/packages", 0o700);
  fs.chown("/var/lib/kandelo/packages", 0, 0);
  fs.chmod("/var/lib/kandelo/packages", 0o700);
  fs.writeFile(INSTALLED_SOFTWARE, inventory, 0o600);
  fs.chown(INSTALLED_SOFTWARE, 0, 0);
  fs.chmod(INSTALLED_SOFTWARE, 0o600);
  return inventory;
}
