import { createHash } from "node:crypto";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

export function wideDirectoryImage(): {
  image: Uint8Array;
  firstChildBlockOffset: number;
  rootEntries: number;
  samplePath: string;
  sha256: string;
} {
  const filesystem = KandeloImageFs.create();
  filesystem.setImageCapacity(512 * 1024 * 1024);
  filesystem.setExportTimestamp(0);
  const suffix = "n".repeat(200);
  for (let index = 1023; index >= 0; index--) {
    const path = `/d${index.toString().padStart(4, "0")}-${suffix}`;
    filesystem.mkdir(path, 0o751);
    filesystem.writeFile(`${path}/file`, new TextEncoder().encode("payload"), 0o640);
  }
  for (let index = 8191; index >= 0; index--) {
    filesystem.writeFile(`/f${index.toString().padStart(4, "0")}-${suffix}`, new Uint8Array(0));
  }
  const image = filesystem.exportImage();
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (view.getUint32(4, true) !== 1) throw new Error("directory fixture requires a v1 container");
  const table = 16 + view.getUint32(16 + 36, true) * 4096;
  const rootBlock = 16 + view.getUint32(table + 128 + 48, true) * 4096;
  let firstChildBlockOffset: number | undefined;
  for (let offset = rootBlock; offset < rootBlock + 4096;) {
    const inode = view.getUint32(offset, true);
    const recordLength = view.getUint16(offset + 4, true);
    const nameLength = view.getUint16(offset + 6, true);
    if (recordLength < 8) throw new Error("invalid directory fixture record");
    if (inode !== 0 && nameLength > 0 && image[offset + 8] === "d".charCodeAt(0)) {
      firstChildBlockOffset = 16 + view.getUint32(table + inode * 128 + 48, true) * 4096;
      break;
    }
    offset += recordLength;
  }
  if (firstChildBlockOffset === undefined) throw new Error("directory fixture has no child directory");
  return { image, firstChildBlockOffset, rootEntries: 9216, samplePath: `/d1023-${suffix}/file`,
    sha256: createHash("sha256").update(image).digest("hex") };
}
