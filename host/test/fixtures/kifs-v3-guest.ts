import { zipSync } from "fflate";
import { parseZipCentralDirectory } from "../../src/vfs/zip";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../../src/binary-resolver";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";

export const capacityProgram = resolve(import.meta.dirname, "../../../local-binaries/test-fixtures/wasm32/kifs-capacity.wasm");
export const kifsGuestPath = "/usr/libexec/kandelo/kifs-v3-guest";
export const kifsGuestSuccess = "KIFS v3 guest read passed";
const fixtureName = "guest.kifs";

export function buildKifsGuestFixture(directory: string) {
  const programPath = resolve(import.meta.dirname, "../../../local-binaries/test-fixtures/wasm32/kifs-v3-guest.wasm");
  const moduleBytes = Uint8Array.from(readFileSync(resolveBinary("kandelo_image_module_positioned32.wasm")));
  const filesystem = KandeloImageFs.createPositioned(moduleBytes);
  const identity = Buffer.alloc(32, 0x63);
  const target = OverlayStorageFile.open(new HostFileSystem(directory), `/${fixtureName}`);
  const body = new TextEncoder().encode("deferred KIFS guest file\n");
  const archive = zipSync({ "member": body }, { mtime: new Date(2025, 0, 1) });
  const asset = (name: string, bytes: Uint8Array) => ({
    url: `https://fixtures.invalid/kifs/${name}`, bytes, size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const standalone = asset("file", body);
  const zip = asset("archive.zip", archive);
  const rejected = asset("rejected", Uint8Array.from(body, byte => byte ^ 1));
  const assets = [standalone, zip, rejected];
  try {
    filesystem.ensureDirRecursive("/opt/kifs-guest/file");
    filesystem.writeFile("/opt/kifs-guest/file", new TextEncoder().encode("KIFS v3 guest fixture\n"), 0o644);
    filesystem.symlink("file", "/opt/kifs-guest/link");
    filesystem.registerLazyFile("/opt/deferred/file", standalone.url, body.length, 0o444, standalone.sha256);
    filesystem.registerLazyFile("/opt/deferred/rejected", rejected.url, body.length, 0o444, standalone.sha256);
    filesystem.registerLazyArchive({ url: zip.url, entries: parseZipCentralDirectory(archive), mountPrefix: "/opt/deferred",
      integrity: { sha256: zip.sha256, bytes: zip.size } });
    filesystem.ensureDirRecursive(kifsGuestPath);
    filesystem.writeFile(kifsGuestPath, readFileSync(programPath), 0o755);
    filesystem.stageKifsV3To(target, 256, identity);
  } finally {
    filesystem.reset();
    target.close();
  }
  const path = join(directory, fixtureName);
  const image = readFileSync(path);
  if (image.subarray(0, 4).toString() !== "KIFS" || image.readUInt32LE(4) !== 3) {
    throw new Error("The guest fixture builder did not produce KIFS v3");
  }
  return { path, image, assets, identity: identity.toString("hex"), sha256: createHash("sha256").update(image).digest("hex") };
}
