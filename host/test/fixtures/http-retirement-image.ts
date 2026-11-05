import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";

export async function httpRetirementImage(directory: string) {
  const filesystem = KandeloImageFs.createPositioned(new Uint8Array(readFileSync(resolve(import.meta.dirname,
    "../../../local-binaries/kandelo_image_module_positioned32.wasm"))));
  let storage: OverlayStorageFile | undefined;
  let failure: { error: unknown } | undefined;
  try {
    filesystem.setImageCapacity(16 * 1024 * 1024);
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile("/bin/http-retirement", readFileSync(resolve(import.meta.dirname,
      "../../../local-binaries/test-fixtures/wasm32/http-retirement-server.wasm")), 0o755);
    storage = OverlayStorageFile.open(new HostFileSystem(directory), "/base.img");
    const image = await filesystem.exportPersistentImageTo(storage, "crc32c");
    return { path: resolve(directory, "base.img"), binding: { identitySha256: image.identitySha256,
      dataCachePages: 1, indexCachePages: 1 } };
  } catch (error) { failure = { error }; throw error; }
  finally {
    const failures: unknown[] = [];
    try { filesystem.reset(); } catch (error) { failures.push(error); }
    try { storage?.close(); } catch (error) { failures.push(error); }
    if (failures.length !== 0) throw Object.assign(new AggregateError(
      failure === undefined ? failures : [failure.error, ...failures], "HTTP fixture cleanup is unproven"), { retainTarget: true });
  }
}
