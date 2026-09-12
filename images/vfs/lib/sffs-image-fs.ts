import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ERRNO } from "../../../host/src/generated/abi";

/**
 * Builder-facing filesystem backed by the Rust image module.
 *
 * # Why this exists
 *
 * Lane Y decouples the VFS image builders from `host/src/vfs/memory-fs.ts`, so
 * that the image FORMAT has one implementation (in Rust, shared with the
 * kernel) rather than two that agree by inspection. The recipes — which
 * packages go in the LAMP image, how WordPress is preinstalled — are product
 * configuration and are not touched. This is the seam they sit on.
 *
 * # The module imports nothing
 *
 * `WebAssembly.instantiate(bytes)` is called with NO import object, because
 * `crates/sffs-module` has no import section at all — not even `env.memory`.
 * That is verified on every build of the module rather than assumed here, and
 * it is what makes this a bridge to a self-contained component rather than a
 * new host surface: goal V4 counts what a new host must implement, and a host
 * implements nothing for this.
 */

/** Metadata a builder reads back, as `lstat` returns it. */
export interface SffsStat {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  ino: number;
  nlink: number;
}

interface ModuleExports {
  memory: WebAssembly.Memory;
  sm_alloc(len: number): number;
  sm_free(ptr: number, len: number): void;
  sm_reset(): void;
  sm_init_root(mode: number, uid: number, gid: number): number;
  sm_mkdir(p: number, pl: number, mode: number, uid: number, gid: number): number;
  sm_mkdir_parents(p: number, pl: number, mode: number, uid: number, gid: number): number;
  sm_symlink(t: number, tl: number, l: number, ll: number, uid: number, gid: number): number;
  sm_chmod(p: number, pl: number, mode: number): number;
  sm_chown(p: number, pl: number, uid: number, gid: number, clearSetid: number): number;
  sm_unlink(p: number, pl: number): number;
  sm_write_file(p: number, pl: number, mode: number, c: number, cl: number): number;
  sm_stat_size(): number;
  sm_lstat(p: number, pl: number, o: number, ol: number): number;
  sm_readlink(p: number, pl: number, o: number, ol: number): number;
  sm_read_file(p: number, pl: number, offset: bigint, o: number, ol: number): number;
  sm_read_dir(p: number, pl: number, o: number, ol: number): number;
  sm_register_lazy_file(
    p: number, pl: number, archiveId: number, s: number, sl: number,
    size: bigint, mode: number, uid: number, gid: number, ino: bigint,
    archiveBytes: bigint,
  ): number;
  sm_set_image_metadata(p: number, pl: number): number;
  sm_export_image_read(offset: bigint, o: number, ol: number): number;
}

/**
 * Errno number to name, derived from the GENERATED table.
 *
 * Not a hand-written map. ABI knowledge reaching TypeScript by hand beside a
 * generator is this campaign's most frequently rediscovered defect — L-D2, the
 * scratch pointer table; W-D1, syscall names; V-D1, the errno table that did
 * not exist until lane V generated one. This lane does not add a fourth.
 */
const ERRNO_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(ERRNO).map(([name, value]) => [value as number, name]),
);

export class SffsImageError extends Error {
  constructor(readonly errno: number, operation: string, path: string) {
    const name = ERRNO_NAMES.get(errno) ?? `errno ${errno}`;
    super(`${name}: ${operation} ${path}`);
    this.name = "SffsImageError";
  }
}

export class SffsImageFs {
  private constructor(private readonly exports: ModuleExports) {}

  /**
   * Instantiate the module and create an empty image tree.
   *
   * Synchronous instantiation is deliberate: builders are synchronous
   * top-to-bottom scripts, and a promise here would make every recipe async
   * for no benefit. `WebAssembly.Module` from bytes is fine at build time;
   * the size limit that makes it a problem in a browser does not apply.
   */
  static create(
    moduleBytes: Uint8Array = defaultModuleBytes(),
    rootMode = 0o755,
  ): SffsImageFs {
    // No import object: the module has no import section.
    const instance = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes));
    const fs = new SffsImageFs(instance.exports as unknown as ModuleExports);
    fs.exports.sm_reset();
    fs.check(fs.exports.sm_init_root(rootMode, 0, 0), "init root", "/");
    return fs;
  }

  /**
   * A view over the module's memory, taken FRESH on every access.
   *
   * `sm_alloc` can grow the module's linear memory, which detaches every
   * previously created `ArrayBuffer` view. Caching one is the classic wasm
   * bridge bug: it works until the first allocation that grows memory, then
   * reads zeroes or throws, depending on the engine's mood.
   */
  private get mem(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer);
  }

  private check(rc: number, operation: string, path: string): number {
    if (rc < 0) throw new SffsImageError(-rc, operation, path);
    return rc;
  }

  /** Copy bytes into the module and run `fn` with the pointer, always freeing. */
  private withBytes<T>(bytes: Uint8Array, fn: (ptr: number, len: number) => T): T {
    const ptr = this.exports.sm_alloc(bytes.byteLength);
    if (ptr === 0) throw new Error("sffs-module: allocation failed");
    try {
      this.mem.set(bytes, ptr);
      return fn(ptr, bytes.byteLength);
    } finally {
      this.exports.sm_free(ptr, bytes.byteLength);
    }
  }

  private withPath<T>(path: string, fn: (ptr: number, len: number) => T): T {
    return this.withBytes(encoder.encode(path), fn);
  }

  /** Discard the tree. The release half of release-before-create. */
  reset(rootMode = 0o755): void {
    this.exports.sm_reset();
    this.check(this.exports.sm_init_root(rootMode, 0, 0), "init root", "/");
  }

  mkdir(path: string, mode: number, uid = 0, gid = 0): void {
    this.withPath(path, (p, pl) =>
      this.check(this.exports.sm_mkdir(p, pl, mode, uid, gid), "mkdir", path));
  }

  /** Create missing parents. Returns how many were created. */
  ensureDirRecursive(path: string, mode = 0o755, uid = 0, gid = 0): number {
    return this.withPath(path, (p, pl) =>
      this.exports.sm_mkdir_parents(p, pl, mode, uid, gid));
  }

  symlink(target: string, linkPath: string, uid = 0, gid = 0): void {
    this.withPath(target, (t, tl) =>
      this.withPath(linkPath, (l, ll) =>
        this.check(this.exports.sm_symlink(t, tl, l, ll, uid, gid), "symlink", linkPath)));
  }

  chmod(path: string, mode: number): void {
    this.withPath(path, (p, pl) =>
      this.check(this.exports.sm_chmod(p, pl, mode), "chmod", path));
  }

  /**
   * `-1` leaves a field unchanged, as POSIX chown does.
   *
   * The explicit mapping to `0xffff_ffff` is BEHAVIOURALLY REDUNDANT and kept
   * on purpose. Passing `-1` to a wasm `u32` parameter already yields the same
   * bit pattern, because JavaScript coerces arguments with ToInt32 — so a
   * mutation removing this mapping survives every test, and provably would.
   *
   * It stays because the equivalence is a property of the calling convention
   * rather than of this code: a future signature change to `i32`, or a caller
   * passing a BigInt, breaks the coincidence silently. Writing the sentinel
   * makes the intent legible to a reader who should not have to know ToInt32
   * to understand what `-1` means here.
   *
   * Recorded as an accepted surviving mutant, alongside the two in
   * `crates/sffs-module/src/lib.rs`, so it is an explained result rather than
   * an unexplained red that teaches people to ignore the gate.
   */
  chown(path: string, uid: number, gid: number, clearSetid = false): void {
    const u = uid < 0 ? 0xffff_ffff : uid;
    const g = gid < 0 ? 0xffff_ffff : gid;
    this.withPath(path, (p, pl) =>
      this.check(this.exports.sm_chown(p, pl, u, g, clearSetid ? 1 : 0), "chown", path));
  }

  unlink(path: string): void {
    this.withPath(path, (p, pl) =>
      this.check(this.exports.sm_unlink(p, pl), "unlink", path));
  }

  writeFile(path: string, content: Uint8Array, mode = 0o644): void {
    this.withPath(path, (p, pl) =>
      this.withBytes(content, (c, cl) =>
        this.check(this.exports.sm_write_file(p, pl, mode, c, cl), "write", path)));
  }

  lstat(path: string): SffsStat {
    const size = this.exports.sm_stat_size();
    const out = this.exports.sm_alloc(size);
    if (out === 0) throw new Error("sffs-module: allocation failed");
    try {
      this.withPath(path, (p, pl) =>
        this.check(this.exports.sm_lstat(p, pl, out, size), "lstat", path));
      const view = new DataView(this.exports.memory.buffer, out, size);
      const field = (index: number) => Number(view.getBigUint64(index * 8, true));
      return {
        ino: field(STAT_FIELD.INO),
        mode: field(STAT_FIELD.MODE),
        nlink: field(STAT_FIELD.NLINK),
        uid: field(STAT_FIELD.UID),
        gid: field(STAT_FIELD.GID),
        size: field(STAT_FIELD.SIZE),
      };
    } finally {
      this.exports.sm_free(out, size);
    }
  }

  readlink(path: string): string {
    const cap = 4096;
    const out = this.exports.sm_alloc(cap);
    if (out === 0) throw new Error("sffs-module: allocation failed");
    try {
      const n = this.withPath(path, (p, pl) =>
        this.check(this.exports.sm_readlink(p, pl, out, cap), "readlink", path));
      return decoder.decode(this.mem.subarray(out, out + n));
    } finally {
      this.exports.sm_free(out, cap);
    }
  }

  readFile(path: string): Uint8Array {
    const { size } = this.lstat(path);
    if (size === 0) return new Uint8Array(0);
    const out = this.exports.sm_alloc(size);
    if (out === 0) throw new Error("sffs-module: allocation failed");
    try {
      const n = this.withPath(path, (p, pl) =>
        this.check(this.exports.sm_read_file(p, pl, 0n, out, size), "read", path));
      return this.mem.slice(out, out + n);
    } finally {
      this.exports.sm_free(out, size);
    }
  }

  /**
   * Directory entry names for a path.
   *
   * Two calls: the module reports the bytes required, then fills them. Safe
   * here because nothing mutates the tree between them — a build is
   * single-threaded and this is not a general-purpose filesystem API.
   *
   * The builders do not call this directly; they use the POSIX-shaped
   * `opendir`/`readdir`/`closedir` below, which this backs.
   */
  readDirNames(path: string): string[] {
    const required = this.withPath(path, (p, pl) =>
      this.check(this.exports.sm_read_dir(p, pl, 0, 0), "readdir", path));
    if (required === 0) return [];
    const out = this.exports.sm_alloc(required);
    if (out === 0) throw new Error("sffs-module: allocation failed");
    try {
      const n = this.withPath(path, (p, pl) =>
        this.check(this.exports.sm_read_dir(p, pl, out, required), "readdir", path));
      const bytes = this.mem.subarray(out, out + n);
      const names: string[] = [];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let at = 0;
      while (at + 4 <= bytes.byteLength) {
        const len = view.getUint32(at, true);
        at += 4;
        names.push(decoder.decode(bytes.subarray(at, at + len)));
        at += len;
      }
      return names;
    } finally {
      this.exports.sm_free(out, required);
    }
  }

  // ---------------------------------------------------------------------
  // POSIX-shaped handle APIs.
  //
  // The builders and their helpers call open/read/close and
  // opendir/readdir/closedir, so the bridge presents exactly that. Lane Y's
  // premise is that the RECIPES are not touched, which means the seam adapts
  // to them rather than the other way round.
  //
  // The handles live HERE, in TypeScript, over the module's path-addressed
  // entry points — no iterator or descriptor lifetime crosses the wasm
  // boundary, so a builder that throws mid-loop cannot leak one inside the
  // module. It is the same choice `sm_read_dir` made by returning a snapshot.
  // ---------------------------------------------------------------------

  private readonly openFiles = new Map<number, { path: string; offset: number }>();
  private readonly openDirs = new Map<number, { names: string[]; index: number }>();
  private nextHandle = 1;

  /** Open for reading. `flags` and `mode` are accepted and ignored: the
   * builders only ever open to read back what they wrote, and silently
   * accepting a write flag while not honouring it would be worse than the
   * narrow surface. */
  open(path: string, _flags = 0, _mode = 0): number {
    this.lstat(path); // Throws ENOENT before a handle is issued.
    const handle = this.nextHandle++;
    this.openFiles.set(handle, { path, offset: 0 });
    return handle;
  }

  /**
   * Read into `buf`. `position` of `null` means "from the handle's cursor",
   * matching the callers in `vfs-image-helpers.ts`.
   */
  read(handle: number, buf: Uint8Array, position: number | null, length: number): number {
    const open = this.openFiles.get(handle);
    if (!open) throw new Error(`sffs-module: bad file handle ${handle}`);
    const at = position ?? open.offset;
    const want = Math.min(length, buf.byteLength);
    if (want === 0) return 0;

    const out = this.exports.sm_alloc(want);
    if (out === 0) throw new Error("sffs-module: allocation failed");
    try {
      const n = this.check(
        this.exports.sm_read_file(
          ...this.pathArgs(open.path), BigInt(at), out, want,
        ) as number,
        "read",
        open.path,
      );
      buf.set(this.mem.subarray(out, out + n), 0);
      if (position === null) open.offset += n;
      return n;
    } finally {
      this.exports.sm_free(out, want);
    }
  }

  close(handle: number): void {
    if (!this.openFiles.delete(handle)) {
      throw new Error(`sffs-module: bad file handle ${handle}`);
    }
  }

  opendir(path: string): number {
    const names = this.readDirNames(path);
    const handle = this.nextHandle++;
    this.openDirs.set(handle, { names, index: 0 });
    return handle;
  }

  /** One entry, or `null` at the end — the shape the helpers' loops expect. */
  readdir(handle: number): { name: string } | null {
    const dir = this.openDirs.get(handle);
    if (!dir) throw new Error(`sffs-module: bad directory handle ${handle}`);
    if (dir.index >= dir.names.length) return null;
    return { name: dir.names[dir.index++] };
  }

  closedir(handle: number): void {
    if (!this.openDirs.delete(handle)) {
      throw new Error(`sffs-module: bad directory handle ${handle}`);
    }
  }

  /**
   * Copy a path into module memory and return its (ptr, len).
   *
   * Callers must free it. Used where a path and another buffer are live at
   * once and the nested `withPath` shape would read badly.
   */
  private pathArgs(path: string): [number, number] {
    const bytes = encoder.encode(path);
    const ptr = this.exports.sm_alloc(bytes.byteLength);
    if (ptr === 0) throw new Error("sffs-module: allocation failed");
    this.mem.set(bytes, ptr);
    return [ptr, bytes.byteLength];
  }

  /**
   * Register a file whose bytes live in a lazy archive.
   *
   * `archiveBytes` is the archive's TOTAL length, not the member's. Fetching
   * one member means fetching the archive, and the kernel bounds that read, so
   * a member cannot be registered without it. Declaring the same archive twice
   * with the same length is a no-op; a different length is an error.
   */
  registerLazyFile(args: {
    path: string;
    archiveId: number;
    sourcePath: string;
    size: number;
    mode: number;
    uid?: number;
    gid?: number;
    ino: number;
    archiveBytes: number;
  }): void {
    this.withPath(args.path, (p, pl) =>
      this.withPath(args.sourcePath, (s, sl) =>
        this.check(
          this.exports.sm_register_lazy_file(
            p, pl, args.archiveId, s, sl,
            BigInt(args.size), args.mode, args.uid ?? 0, args.gid ?? 0, BigInt(args.ino),
            BigInt(args.archiveBytes),
          ),
          "registerLazyFile",
          args.path,
        )));
  }

  /**
   * Metadata the exported image will declare: the builder's statements about
   * its own artifact (`version`, `kernelAbi`, `createdBy`).
   *
   * Passed as bytes and never parsed by the kernel. Pass `null` to clear.
   */
  setImageMetadata(metadata: unknown | null): void {
    const bytes = metadata === null
      ? new Uint8Array(0)
      : encoder.encode(JSON.stringify(metadata));
    this.withBytes(bytes, (p, pl) =>
      this.check(
        this.exports.sm_set_image_metadata(bytes.byteLength === 0 ? 0 : p, pl),
        "setImageMetadata",
        "",
      ));
  }

  /**
   * The finished image: a whole VFSI container, ready to compress and write.
   *
   * Streamed out of the module a chunk at a time rather than materialised
   * inside it, because the module's linear memory is not where a 249 MiB image
   * should live — and because the export is offset-addressable for exactly
   * this. Compression and the file write stay here: those are host facilities,
   * and the floor this lane is reducing toward is host facilities only.
   */
  exportImage(chunkBytes = 1 << 20): Uint8Array {
    const ptr = this.exports.sm_alloc(chunkBytes);
    if (ptr === 0) throw new Error("sffs-module: allocation failed");
    try {
      const parts: Uint8Array[] = [];
      let total = 0;
      let offset = 0n;
      for (;;) {
        const n = this.check(
          this.exports.sm_export_image_read(offset, ptr, chunkBytes),
          "exportImage",
          "",
        );
        if (n === 0) break;
        // A fresh view per chunk: the module may have grown its memory while
        // building the image, which detaches any view taken before.
        parts.push(this.mem.slice(ptr, ptr + n));
        total += n;
        offset += BigInt(n);
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
      }
      return out;
    } finally {
      this.exports.sm_free(ptr, chunkBytes);
    }
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Field order of the module's stat record: six little-endian `u64`s.
 *
 * The module documents this layout and `sm_stat_size()` reports its length, so
 * nothing here hardcodes a byte count.
 *
 * **This is deliberately not the generated ABI stat layout.** The obvious move
 * is to decode `process_layout::stat`, the record the syscall wire uses — one
 * authority, no second spelling. It cannot work: `host/src/generated/abi.ts`
 * carries `STRUCT_SIZE_WASM_STAT = 88` and no field offsets for it, so this
 * file would have to hand-copy them, which is the hand-maintained-ABI-knowledge
 * defect (L-D2, W-D1, V-D1) lane Y has been careful not to add a fourth
 * instance of. Six fields in a fixed order is a contract two files can hold
 * correctly; 88 bytes of copied kernel layout is not. If the generator later
 * emits those offsets to TypeScript, switching is right.
 */
const STAT_FIELD = {
  INO: 0,
  MODE: 1,
  NLINK: 2,
  UID: 3,
  GID: 4,
  SIZE: 5,
} as const;

function defaultModuleBytes(): Uint8Array {
  const root = join(import.meta.dirname, "..", "..", "..");
  return new Uint8Array(readFileSync(join(root, "local-binaries", "sffs_module32.wasm")));
}
