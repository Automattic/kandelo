/**
 * Decode the RTFS boot manifest back into entries, mirroring
 * `rootfs::load_manifest` in `crates/runtime-core/src/rootfs.rs`, so the wire
 * format is asserted from the consumer side and drift is caught.
 *
 * Handles both v2 (no archive table) and v3 (kind-4 `archive_id`/`source_path`
 * fields plus the trailing archive table).
 *
 * This is the manifest the kernel actually consumes at boot, which makes it a
 * parity oracle for anything else that claims to describe the same tree — see
 * `host/test/vfs-image-kernel-lazy.test.ts`, which uses it to check that the
 * image's own binary lazy-linkage section carries exactly the lazy facts the
 * host-walked manifest carries.
 */

import { RTFS_MAGIC } from "../../src/vfs/rootfs-manifest";

export const RTFS_KIND_DIR = 1;
export const RTFS_KIND_FILE = 2;
export const RTFS_KIND_SYMLINK = 3;
export const RTFS_KIND_LAZY_FILE = 4;

export interface DecodedRootfsManifestEntry {
  kind: number;
  mode: number;
  uid: number;
  gid: number;
  ino: bigint;
  blobId: bigint;
  size: bigint;
  mtimeSec: bigint;
  mtimeNsec: number;
  path: string;
  target: string;
  archiveId?: number;
  sourcePath?: string;
}

export interface DecodedRootfsManifest {
  version: number;
  entries: DecodedRootfsManifestEntry[];
  archives: Array<{ archiveId: number; archiveSize: bigint }>;
}

export function decodeRootfsManifest(buf: Uint8Array): DecodedRootfsManifest {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const u8 = () => buf[p++];
  const u32 = () => {
    const v = dv.getUint32(p, true);
    p += 4;
    return v;
  };
  const u64 = () => {
    const v = dv.getBigUint64(p, true);
    p += 8;
    return v;
  };
  const dec = new TextDecoder();
  const str = (len: number) => {
    const s = dec.decode(buf.subarray(p, p + len));
    p += len;
    return s;
  };
  const magic = u32();
  if (magic !== RTFS_MAGIC) {
    throw new Error(
      `RTFS manifest: bad magic 0x${magic.toString(16)} (expected 0x${RTFS_MAGIC.toString(16)})`,
    );
  }
  const version = u32();
  const count = u32();
  const entries: DecodedRootfsManifestEntry[] = [];
  for (let i = 0; i < count; i++) {
    const kind = u8();
    const mode = u32();
    const uid = u32();
    const gid = u32();
    const ino = u64();
    const blobId = u64();
    const size = u64();
    const mtimeSec = u64();
    const mtimeNsec = u32();
    const path = str(u32());
    const target = str(u32());
    const entry: DecodedRootfsManifestEntry = {
      kind,
      mode,
      uid,
      gid,
      ino,
      blobId,
      size,
      mtimeSec,
      mtimeNsec,
      path,
      target,
    };
    if (kind === RTFS_KIND_LAZY_FILE) {
      entry.archiveId = u32();
      entry.sourcePath = str(u32());
    }
    entries.push(entry);
  }
  const archives: Array<{ archiveId: number; archiveSize: bigint }> = [];
  if (version >= 3) {
    const archiveCount = u32();
    for (let i = 0; i < archiveCount; i++) {
      const archiveId = u32();
      const archiveSize = u64();
      archives.push({ archiveId, archiveSize });
    }
  }
  if (p !== buf.length) {
    throw new Error(
      `RTFS manifest: ${buf.length - p} trailing bytes after the archive table`,
    );
  }
  return { version, entries, archives };
}
