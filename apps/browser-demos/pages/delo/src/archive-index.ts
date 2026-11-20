// The member list of a lazy archive, read with HTTP range requests: the
// central directory and each symlink member's target, never the other
// members' bytes, from the address the kernel downloads the archive from,
// and the archive's length, which bounds the kernel's download.

import { fetchByteRange } from "../../../../../host/src/networking/byte-range-fetch";
import { extractZipEntry, fetchZipCentralDirectory, type ZipEntry } from "../../../../../host/src/vfs/zip";

const LOCAL_HEADER_MAX_BYTES = 30 + 0xffff + 0xffff;
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function fetchArchiveIndex(url: string): Promise<{ entries: ZipEntry[]; symlinkTargets: Map<string, string>; bytes: number }> {
  const { entries, totalSize } = await fetchZipCentralDirectory(url);
  const symlinkTargets = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isSymlink) continue;
    symlinkTargets.set(entry.fileName, decoder.decode(await fetchMember(url, entry, totalSize)));
  }
  return { entries, symlinkTargets, bytes: totalSize };
}

async function fetchMember(url: string, entry: ZipEntry, totalSize: number): Promise<Uint8Array> {
  const start = entry.localHeaderOffset;
  const end = Math.min(totalSize, start + LOCAL_HEADER_MAX_BYTES + entry.compressedSize) - 1;
  const range = await fetchByteRange(url, { start, end });
  if (range.kind === "failed") throw new Error(`${url}: ${entry.fileName}: ${range.reason}`);
  if (range.kind === "whole-entity") return extractZipEntry(new Uint8Array(await range.response.arrayBuffer()), entry);
  return extractZipEntry(await range.bytes(), { ...entry, localHeaderOffset: 0 });
}
