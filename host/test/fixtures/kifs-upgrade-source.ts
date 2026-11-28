import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../../src/binary-resolver";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";

export async function writeCheckedUpgradeSource(directory: string) {
  const image = KandeloImageFs.createPositioned(readFileSync(resolveBinary("kandelo_image_module_positioned32.wasm")));
  const target = OverlayStorageFile.open(new HostFileSystem(directory), "/base.img");
  try {
    image.setImageCapacity(8 * 1024 * 1024);
    image.writeFile("/base-file", Uint8Array.of(9), 0o644);
    const { identitySha256 } = await image.exportPersistentImageTo(target, "sha256");
    return { identity: identitySha256, path: join(directory, "base.img") };
  } finally { target.close(); image.reset(); }
}
