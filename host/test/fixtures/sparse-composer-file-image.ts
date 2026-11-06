import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

export function sparseComposerFileImage(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid sparse composer fixture length");
  const filesystem = KandeloImageFs.create();
  filesystem.setImageCapacity(128 * 1024 * 1024);
  filesystem.mkdir("/etc", 0o755);
  filesystem.writeFile("/etc/php.ini", new Uint8Array(0), 0o644);
  return withSparseFileLength(filesystem.exportImage(), "/etc/php.ini", length);
}

export function withSparseFileLength(source: Uint8Array, path: string, length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid sparse fixture length");
  const exported = KandeloImageFs.create();
  exported.loadImage(source);
  const inode = exported.stat(path).ino;
  const image = source.slice();
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (view.getUint32(4, true) !== 1) throw new Error("Sparse composer fixture requires a v1 container");
  const table = 16 + view.getUint32(16 + 36, true) * 4096;
  view.setUint32(16 + 4, 2, true);
  view.setBigUint64(table + inode * 128 + 16, BigInt(length), true);
  return image;
}
