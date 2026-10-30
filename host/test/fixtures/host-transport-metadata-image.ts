import { createHash } from "node:crypto";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

export async function hostTransportMetadataImage(oversized: boolean): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create();
  filesystem.setImageCapacity(64 * 1024 * 1024);
  const digest = createHash("sha256").update(new Uint8Array([7])).digest("hex");
  for (let index = 0; index < (oversized ? 1400 : 1); index++) {
    filesystem.registerLazyFile(`/asset-${index}`,
      `https://metadata.invalid/${index}/${oversized ? "x".repeat(2048) : "small"}`,
      1, 0o444, digest);
  }
  return filesystem.saveImage();
}
