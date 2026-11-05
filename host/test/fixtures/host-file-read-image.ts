import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { resolveBinary } from "../../src/binary-resolver";

export async function hostFileReadImage(directory: string, policy: "crc32c" | "sha256") {
  const repository = resolve(import.meta.dirname, "../../..");
  const filesystem = KandeloImageFs.createPositioned(new Uint8Array(readFileSync(join(repository,
    "local-binaries/kandelo_image_module_positioned32.wasm"))));
  const program = new Uint8Array(readFileSync(resolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm")));
  const value = Uint8Array.from({ length: 257 }, (_, index) => index % 251);
  const large = Uint8Array.from({ length: 2051 }, (_, index) => (index + 17) % 251);
  filesystem.setImageCapacity(64 * 1024 * 1024);
  filesystem.mkdir("/bin", 0o755);
  filesystem.mkdir("/proc", 0o755);
  filesystem.writeFile("/bin/probe", program, 0o755);
  filesystem.writeFile("/value", value);
  filesystem.writeFile("/large", large);
  filesystem.writeFile("/empty", new Uint8Array(0));
  filesystem.writeFile("/state", new TextEncoder().encode("abcdefgh"));
  filesystem.symlink("value", "/a");
  filesystem.symlink("large", "/blocked");
  const target = OverlayStorageFile.open(new HostFileSystem(directory), "/read-base.img");
  try {
    const image = await filesystem.exportPersistentImageTo(target, policy);
    return { path: join(directory, "read-base.img"), value, large, program,
      binding: { identitySha256: image.identitySha256, dataCachePages: 1, indexCachePages: 1 } };
  } finally {
    target.close();
    filesystem.reset();
  }
}
