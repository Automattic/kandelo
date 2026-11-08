import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

export function oversizedDeferredMetadataImage(): { prefix: Uint8Array; length: number } {
  const filesystem = KandeloImageFs.create();
  filesystem.setImageCapacity(128 * 1024 * 1024);
  const image = filesystem.exportImage();
  const container = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (container.getUint32(4, true) !== 1) throw new Error("metadata fixture requires a v1 container");
  const prefix = image.slice(0, 16 + container.getUint32(12, true));
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const bodyLength = 96 * 1024 * 1024;
  const inodeTable = 16 + view.getUint32(16 + 36, true) * 4096;
  const metadataInode = view.getUint32(16 + 76, true);
  if (metadataInode === 0 || prefix.length >= bodyLength) throw new Error("invalid metadata fixture geometry");
  view.setUint32(8, 0, true);
  view.setUint32(12, bodyLength, true);
  view.setBigUint64(inodeTable + metadataInode * 128 + 16, BigInt(bodyLength), true);
  return { prefix, length: 16 + bodyLength + 4 };
}
