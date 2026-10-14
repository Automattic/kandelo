import { VFS_IMAGE_MAX_DECOMPRESSED_BYTES } from "../../../../../host/src/vfs/vfs-image-transport";
import type { OpfsImageIntegrity } from "../../../../../host/src/vfs/opfs-image-reader";
import { identityEncodedContentLength } from "../../../../../web-libs/kandelo-session/src/sized-download";

const CHUNK_BYTES = 1024 * 1024;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export interface StagedSourceImage {
  file: FileSystemFileHandle;
  integrity: OpfsImageIntegrity;
  remove(): Promise<void>;
}

export async function stageRawVfsSourceImage(
  response: Response,
  onProgress: (loadedBytes: number, totalBytes: number | undefined) => void,
  stagingDirectory?: FileSystemDirectoryHandle,
): Promise<StagedSourceImage | Uint8Array> {
  if (response.body === null) throw new Error("VFS image has no response body");
  const reader = response.body.getReader();
  const totalBytes = identityEncodedContentLength(response);
  const prefix: Uint8Array[] = [];
  let prefixLength = 0;
  try {
    while (prefixLength < 4) {
      const next = await reader.read();
      if (next.done) break;
      prefix.push(next.value);
      prefixLength += next.value.byteLength;
      onProgress(prefixLength, totalBytes);
    }
    const header = new Uint8Array(Math.min(4, prefixLength));
    let copied = 0;
    for (const bytes of prefix) {
      const count = Math.min(bytes.byteLength, header.byteLength - copied);
      header.set(bytes.subarray(0, count), copied);
      copied += count;
      if (copied === header.byteLength) break;
    }
    if (ZSTD_MAGIC.every((byte, index) => header[index] === byte)) {
      const chunks = [...prefix];
      let length = prefixLength;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        chunks.push(next.value);
        onProgress(length, totalBytes);
      }
      const imageBytes = new Uint8Array(length);
      let offset = 0;
      for (const bytes of chunks) {
        imageBytes.set(bytes, offset);
        offset += bytes.byteLength;
      }
      return imageBytes;
    }

    const directory = stagingDirectory ?? await (await navigator.storage.getDirectory()).getDirectoryHandle(
      "kandelo-persistent-overlay", { create: true },
    );
    const name = `source-${crypto.randomUUID()}.vfs`;
    const file = await directory.getFileHandle(name, { create: true });
    const remove = () => directory.removeEntry(name);
    let writable: FileSystemWritableFileStream | undefined;
    try {
      writable = await file.createWritable();
      const chunk = new Uint8Array(CHUNK_BYTES);
      const chunkSha256: string[] = [];
      let fill = 0;
      let length = 0;
      const write = async (bytes: Uint8Array) => {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const count = Math.min(CHUNK_BYTES - fill, bytes.byteLength - offset);
          chunk.set(bytes.subarray(offset, offset + count), fill);
          fill += count;
          offset += count;
          length += count;
          if (length > VFS_IMAGE_MAX_DECOMPRESSED_BYTES) {
            throw new Error("VFS image exceeds its decompressed byte bound");
          }
          if (fill === CHUNK_BYTES) {
            await writable!.write(chunk);
            const digest = await crypto.subtle.digest("SHA-256", chunk);
            chunkSha256.push(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
            fill = 0;
          }
        }
      };
      for (const bytes of prefix) await write(bytes);
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        await write(next.value);
        onProgress(length, totalBytes);
      }
      if (fill > 0) {
        const tail = chunk.slice(0, fill);
        await writable.write(tail);
        const digest = await crypto.subtle.digest("SHA-256", tail);
        chunkSha256.push(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
      }
      await writable.close();
      writable = undefined;
      return { file, integrity: { length, chunkBytes: CHUNK_BYTES, chunkSha256 }, remove };
    } catch (error) {
      await writable?.abort().catch(() => {});
      await remove().catch(() => {});
      throw error;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
