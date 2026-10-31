import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import type { PersistentImageReadBinding } from "../../src/vfs/image-integrity";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";
import { BROWSER_MITM_CA_BUNDLE_PATH } from "../../src/networking/browser-mitm-ca-env";

const repository = resolve(import.meta.dirname, "../../..");
const imageModule = join(repository, "local-binaries/kandelo_image_module_positioned32.wasm");
export const PERSISTENT_BOOTSTRAP_CERTIFICATE_URL = "https://example.invalid/old-platform-ca";

export function preparePersistentBaseFixtures(): void {
  if (!existsSync(imageModule)) throw new Error("Build the positioned image module with crates/kandelo-image-module/build-wasm.sh");
}

export function persistentColdPayloadRange(path: string, content: Uint8Array): { start: number; end: number } {
  if (content.length < 4 * 65536) throw new Error("physical-read fixture needs a contiguous cold payload");
  const position = readFileSync(path).indexOf(content.subarray(0, 4 * 65536));
  if (position < 0) throw new Error("could not locate a metadata-free payload span");
  return { start: position + 65536, end: position + 3 * 65536 };
}

export async function persistentBaseFixture(directory: string, policy: "crc32c" | "sha256", contentBytes = 512 * 1024 + 17,
  bootstrapSource?: "resident" | "deferred", capacityBytes?: number): Promise<{
  path: string; binding: PersistentImageReadBinding; content: Uint8Array;
}> {
  const filesystem = KandeloImageFs.createPositioned(new Uint8Array(readFileSync(imageModule)));
  if (capacityBytes !== undefined) filesystem.setImageCapacity(capacityBytes);
  filesystem.mkdir("/home", 0o755);
  filesystem.mkdirWithOwner("/home/maker", 0o755, 1000, 1000);
  filesystem.mkdir("/root", 0o700);
  filesystem.mkdir("/srv", 0o755);
  const content = new Uint8Array(contentBytes);
  for (let index = 0; index < content.length; index++) content[index] = index % 251;
  filesystem.writeFile("/state", new TextEncoder().encode("original"), 0o640);
  filesystem.writeFile("/large", content, 0o600);
  filesystem.symlink("/state", "/link");
  if (bootstrapSource !== undefined) {
    const old = new TextEncoder().encode("old image-owned certificate");
    filesystem.ensureDirRecursive(BROWSER_MITM_CA_BUNDLE_PATH);
    if (bootstrapSource === "resident") filesystem.writeFile(BROWSER_MITM_CA_BUNDLE_PATH, old, 0o444);
    else filesystem.registerLazyFile(BROWSER_MITM_CA_BUNDLE_PATH, PERSISTENT_BOOTSTRAP_CERTIFICATE_URL,
      old.length, 0o444, createHash("sha256").update(old).digest("hex"));
  }
  const path = join(directory, "persistent.img");
  const target = OverlayStorageFile.open(new HostFileSystem(directory), "/persistent.img");
  let result;
  try { result = await filesystem.exportPersistentImageTo(target, policy); }
  finally { target.close(); filesystem.reset(); }
  return { path, binding: { identitySha256: result.identitySha256, dataCachePages: 1, indexCachePages: 1 }, content };
}

export async function persistentReplacementBaseFixture(directory: string, policy: "crc32c" | "sha256") {
  const filesystem = KandeloImageFs.createPositioned(new Uint8Array(readFileSync(imageModule)));
  filesystem.setImageCapacity(512 * 1024 * 1024);
  const runtimeDirectories = ["/run", "/run/kandelo", "/run/kandelo/exchange"];
  for (const path of runtimeDirectories) filesystem.mkdir(path, 0o755);
  const count = 512 - 1 - runtimeDirectories.length;
  for (let index = 0; index < count; index++) {
    filesystem.writeFile(`/base-${String(index).padStart(4, "0")}`, new Uint8Array(), 0o644);
  }
  const path = join(directory, "persistent.img");
  const target = OverlayStorageFile.open(new HostFileSystem(directory), "/persistent.img");
  let result;
  try { result = await filesystem.exportPersistentImageTo(target, policy); }
  finally { target.close(); filesystem.reset(); }
  return { path, binding: { identitySha256: result.identitySha256, dataCachePages: 1, indexCachePages: 1 }, count };
}

export async function persistentNearlyFullBaseFixture(directory: string, policy: "crc32c" | "sha256") {
  const filesystem = KandeloImageFs.createPositioned(new Uint8Array(readFileSync(imageModule)));
  filesystem.setImageCapacity(1024 * 1024);
  filesystem.writeFile("/full", new Uint8Array(), 0o600);
  const free = filesystem.checkHeadroom(0, 0).freeBytes;
  if (free <= 12 * 4096 || free >= 1034 * 4096) throw new Error("full-disk fixture requires single-indirect geometry");
  filesystem.writeFile("/full", new Uint8Array(free - 4096).fill(65), 0o600);
  const headroom = filesystem.checkHeadroom(0, 0);
  const fillLimit = headroom.freeBytes / 4096 + 1;
  if (!Number.isInteger(fillLimit) || fillLimit > 128 || headroom.freeInodes < fillLimit + 8) {
    throw new Error("near-full fixture requires bounded data-block exhaustion before inode exhaustion");
  }
  const path = join(directory, "persistent.img");
  const target = OverlayStorageFile.open(new HostFileSystem(directory), "/persistent.img");
  let result;
  try { result = await filesystem.exportPersistentImageTo(target, policy); }
  finally { target.close(); filesystem.reset(); }
  return { path, binding: { identitySha256: result.identitySha256, dataCachePages: 1, indexCachePages: 1 }, fillLimit };
}
