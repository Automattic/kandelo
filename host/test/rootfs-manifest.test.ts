import { describe, it, expect } from "vitest";
import {
  emitRootfsManifest,
  createRootfsBlobProvider,
  RTFS_MAGIC,
  RTFS_VERSION,
} from "../src/vfs/rootfs-manifest";
import type { FileSystemBackend } from "../src/vfs/types";

const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;
const S_IFSOCK = 0xc000;

interface FakeNode {
  ino: number;
  mode: number; // includes S_IF* type bits
  uid: number;
  gid: number;
  data?: Uint8Array; // regular files
  target?: string; // symlinks
  children?: string[]; // directory child names
}

/** A tiny in-memory backend keyed by absolute path, exposing just the methods
 * the emitter and provider use. */
function makeFakeBackend(tree: Record<string, FakeNode>): FileSystemBackend {
  const dirIters = new Map<number, { dirPath: string; names: string[]; pos: number }>();
  const fileHandles = new Map<number, string>();
  let nextHandle = 1;

  const node = (path: string): FakeNode => {
    const n = tree[path];
    if (!n) throw new Error(`ENOENT ${path}`);
    return n;
  };

  const backend = {
    lstat(path: string) {
      const n = node(path);
      return {
        dev: 1,
        ino: n.ino,
        mode: n.mode,
        nlink: 1,
        uid: n.uid,
        gid: n.gid,
        size: n.data ? n.data.length : n.target ? n.target.length : 0,
        atimeMs: 0,
        // A distinct, verifiable mtime per inode (whole seconds; nsec 0).
        mtimeMs: n.ino * 1000,
        ctimeMs: 0,
      };
    },
    opendir(path: string) {
      const n = node(path);
      const h = nextHandle++;
      dirIters.set(h, { dirPath: path, names: [...(n.children ?? [])], pos: 0 });
      return h;
    },
    readdir(handle: number) {
      const it = dirIters.get(handle);
      if (!it || it.pos >= it.names.length) return null;
      const name = it.names[it.pos++];
      const abs = it.dirPath === "/" ? `/${name}` : `${it.dirPath}/${name}`;
      const cn = node(abs);
      return { name, type: cn.mode & 0xf000, ino: cn.ino };
    },
    closedir(handle: number) {
      dirIters.delete(handle);
    },
    readlink(path: string) {
      const n = node(path);
      if (n.target === undefined) throw new Error(`EINVAL ${path}`);
      return n.target;
    },
    open(path: string) {
      const n = node(path);
      if (n.data === undefined) throw new Error(`EISDIR ${path}`);
      const h = nextHandle++;
      fileHandles.set(h, path);
      return h;
    },
    read(handle: number, buffer: Uint8Array, offset: number | bigint | null) {
      const path = fileHandles.get(handle);
      if (path === undefined) return -9; // EBADF
      const data = node(path).data!;
      const start = Number(offset ?? 0);
      if (start >= data.length) return 0;
      const count = Math.min(buffer.length, data.length - start);
      buffer.set(data.subarray(start, start + count), 0);
      return count;
    },
    close(handle: number) {
      fileHandles.delete(handle);
      return 0;
    },
  };

  return backend as unknown as FileSystemBackend;
}

/** Decode the RTFS buffer back into entries (mirrors rootfs.rs load_manifest) so
 * the wire format is asserted from the consumer side, catching drift. */
function decode(buf: Uint8Array): {
  version: number;
  entries: Array<{
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
  }>;
} {
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
  expect(u32()).toBe(RTFS_MAGIC);
  const version = u32();
  const count = u32();
  const entries = [];
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
    entries.push({ kind, mode, uid, gid, ino, blobId, size, mtimeSec, mtimeNsec, path, target });
  }
  expect(p).toBe(buf.length); // no trailing bytes
  return { version, entries };
}

describe("rootfs manifest emitter", () => {
  const tree: Record<string, FakeNode> = {
    "/": { ino: 1, mode: S_IFDIR | 0o755, uid: 0, gid: 0, children: ["usr", "etc"] },
    "/usr": { ino: 2, mode: S_IFDIR | 0o755, uid: 0, gid: 0, children: ["bin"] },
    "/usr/bin": { ino: 3, mode: S_IFDIR | 0o755, uid: 0, gid: 0, children: ["hello", "hi"] },
    "/usr/bin/hello": {
      ino: 4,
      mode: S_IFREG | 0o755,
      uid: 0,
      gid: 0,
      data: new TextEncoder().encode("hello world"),
    },
    "/usr/bin/hi": { ino: 5, mode: S_IFLNK | 0o777, uid: 0, gid: 0, target: "hello" },
    "/etc": { ino: 6, mode: S_IFDIR | 0o755, uid: 0, gid: 0, children: ["issue"] },
    "/etc/issue": {
      ino: 7,
      mode: S_IFREG | 0o644,
      uid: 1,
      gid: 2,
      data: new TextEncoder().encode("Kandelo\n"),
    },
  };

  it("emits a parent-first tree with blob_id = inode and stable order", () => {
    const backend = makeFakeBackend(tree);
    const { buffer, blobPaths, entryCount, skipped } = emitRootfsManifest(
      backend,
      (p) => p, // identity: fake backend keys by absolute path
    );
    expect(skipped).toEqual([]);
    expect(entryCount).toBe(7);

    const { version, entries } = decode(buffer);
    expect(version).toBe(RTFS_VERSION);
    expect(entries.map((e) => e.path)).toEqual([
      "/",
      "/etc",
      "/etc/issue",
      "/usr",
      "/usr/bin",
      "/usr/bin/hello",
      "/usr/bin/hi",
    ]);

    const hello = entries.find((e) => e.path === "/usr/bin/hello")!;
    expect(hello.kind).toBe(2); // file
    expect(hello.ino).toBe(4n);
    expect(hello.blobId).toBe(4n); // blob_id = inode
    expect(hello.size).toBe(11n);
    expect(hello.mode).toBe(0o755);
    // mtime preserved: fake backend returns ino*1000 ms => 4000 ms => 4 s.
    expect(hello.mtimeSec).toBe(4n);
    expect(hello.mtimeNsec).toBe(0);

    const link = entries.find((e) => e.path === "/usr/bin/hi")!;
    expect(link.kind).toBe(3); // symlink
    expect(link.target).toBe("hello");

    const issue = entries.find((e) => e.path === "/etc/issue")!;
    expect(issue.uid).toBe(1);
    expect(issue.gid).toBe(2);

    // blobPaths covers exactly the regular files, keyed by inode.
    expect(new Set(blobPaths.keys())).toEqual(new Set([4, 7]));
    expect(blobPaths.get(4)).toBe("/usr/bin/hello");
  });

  it("provider reads bytes by blob id and reports ENOENT for unknown ids", () => {
    const backend = makeFakeBackend(tree);
    const { blobPaths } = emitRootfsManifest(backend, (p) => p);
    const provider = createRootfsBlobProvider(backend, blobPaths);

    const dest = new Uint8Array(11);
    expect(provider(4n, 0n, dest)).toBe(11);
    expect(new TextDecoder().decode(dest)).toBe("hello world");

    const tail = new Uint8Array(5);
    expect(provider(4n, 6n, tail)).toBe(5);
    expect(new TextDecoder().decode(tail)).toBe("world");

    // Past EOF -> 0.
    expect(provider(4n, 11n, dest)).toBe(0);

    // Unknown blob id -> ENOENT.
    expect(provider(999n, 0n, dest)).toBe(-2);
  });

  it("surfaces (does not hide) a non-portable node in a `/` image", () => {
    const withSock: Record<string, FakeNode> = {
      "/": { ino: 1, mode: S_IFDIR | 0o755, uid: 0, gid: 0, children: ["s"] },
      "/s": { ino: 2, mode: S_IFSOCK | 0o755, uid: 0, gid: 0 },
    };
    const { entryCount, skipped } = emitRootfsManifest(
      makeFakeBackend(withSock),
      (p) => p,
    );
    expect(entryCount).toBe(1); // just the root dir
    expect(skipped).toEqual(["/s"]);
  });
});
