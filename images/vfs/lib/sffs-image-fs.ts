
import { maybeDecompressImage } from "../../../host/src/vfs/vfs-image-transport";
import { ERRNO, OPEN_FLAGS } from "../../../host/src/generated/abi";
import type { VfsImageMetadata } from "../../../host/src/vfs/vfs-image-filesystem";
import type { ZipEntry } from "../../../host/src/vfs/zip";
import { planLazyArchiveEntries } from "../../../host/src/vfs/lazy-archive-paths";

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
  /** The file's REAL length, whether or not its bytes are in the image. */
  size: number;
  ino: number;
  nlink: number;
  /** True when the image describes these bytes but does not contain them. */
  deferred: boolean;
  /** The archive backing a deferred file, or 0 when it is fetched standalone. */
  archiveId: number;
}

interface ModuleExports {
  memory: WebAssembly.Memory;
  sm_alloc(len: number): number;
  sm_free(ptr: number, len: number): void;
  sm_reset(rootMode: number, uid: number, gid: number): number;
  sm_image_metadata(out: number, outLen: number): number;
  sm_mkdir(p: number, pl: number, mode: number, uid: number, gid: number): number;
  sm_mkdir_parents(p: number, pl: number, mode: number, uid: number, gid: number): number;
  sm_symlink(t: number, tl: number, l: number, ll: number, uid: number, gid: number): number;
  sm_chmod(p: number, pl: number, mode: number): number;
  sm_chown(p: number, pl: number, uid: number, gid: number, clearSetid: number): number;
  sm_unlink(p: number, pl: number): number;
  sm_write_file(p: number, pl: number, mode: number, c: number, cl: number): number;
  sm_load_image(ptr: number, len: number): number;
  sm_lstat(p: number, pl: number, o: number, ol: number): number;
  sm_readlink(p: number, pl: number, o: number, ol: number): number;
  sm_read_file(p: number, pl: number, offset: bigint, o: number, ol: number): number;
  sm_read_dir(p: number, pl: number, o: number, ol: number): number;
  sm_register_lazy_file(
    p: number, pl: number, archiveId: number, s: number, sl: number,
    size: bigint, mode: number, uid: number, gid: number, ino: bigint,
    archiveBytes: bigint,
    archivePayload: number, archivePayloadLen: number,
    cohortId: number, cohortIdLen: number,
    cohortMember: number, cohortMemberLen: number,
    cohortExpectedCount: number,
  ): number;
  sm_set_image_options(
    capacityBytes: bigint, p: number, pl: number,
    normalizeTimestampsMs: bigint,
  ): number;
  sm_check_headroom(minBytes: bigint, minInodes: bigint, o: number, ol: number): number;
  sm_lazy_entries(o: number, ol: number): number;
  sm_export_image_read(offset: bigint, o: number, ol: number): number;
  sm_image_read(offset: bigint, o: number, ol: number): number;
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
    //
    // `moduleBytes.buffer` rather than the view: since TypeScript 5.7 a
    // `Uint8Array<ArrayBufferLike>` is not assignable to `BufferSource`, and
    // `WebAssembly.Module` wants the buffer. Caught the first time anything
    // type-checked this directory.
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(
        moduleBytes.buffer.slice(
          moduleBytes.byteOffset,
          moduleBytes.byteOffset + moduleBytes.byteLength,
        ) as ArrayBuffer,
      ),
    );
    const fs = new SffsImageFs(instance.exports as unknown as ModuleExports);
    fs.check(fs.exports.sm_reset(rootMode, 0, 0), "reset", "/");
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
    // One call: creating the root is part of the same transition, and a
    // filesystem with no root fails every path operation, so the state between
    // the two old calls was never one anything wanted.
    this.check(this.exports.sm_reset(rootMode, 0, 0), "reset", "/");
    this.lastMetadata = null;
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

  /**
   * Create a file owned by `uid`/`gid`, the way the image builders do.
   *
   * `MemoryFileSystem.createFileWithOwner` re-applies the mode after the
   * chown, and this does not. **That is a real difference between the two
   * filesystems, not a simplification:** measured, `MemoryFileSystem.chown`
   * clears set-user-ID unconditionally — `0o4755` becomes `0o755` — while the
   * module leaves it, because `sm_chown` takes the POSIX clearing as an
   * explicit flag and this bridge does not set it. So the incumbent NEEDS the
   * re-chmod to end up where it meant to, and here it would be dead code.
   *
   * Written the incumbent's way first, with the re-chmod, a perturbation that
   * swapped chown and chmod survived — which is how the divergence was found
   * rather than assumed.
   */
  createFileWithOwner(
    path: string,
    mode: number,
    uid: number,
    gid: number,
    content: Uint8Array,
  ): void {
    this.writeFile(path, content, mode);
    this.chown(path, uid, gid);
  }

  /** The directory peer of {@link createFileWithOwner}. */
  mkdirWithOwner(path: string, mode: number, uid: number, gid: number): void {
    this.mkdir(path, mode, uid, gid);
  }

  lstat(path: string): SffsStat {
    // `out_len === 0` is the module's one size-probe convention, shared with
    // `sm_read_dir` and `sm_check_headroom`. Queried rather than hardcoded, so
    // nothing here bakes in a record length the module could change.
    const size = this.exports.sm_lstat(0, 0, 0, 0);
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
        deferred: field(STAT_FIELD.DEFERRED) !== 0,
        archiveId: field(STAT_FIELD.ARCHIVE_ID),
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

  private readonly openFiles = new Map<
    number,
    { path: string; offset: number; mode: number }
  >();
  private readonly openDirs = new Map<number, { names: string[]; index: number }>();
  private nextHandle = 1;

  /** Open for reading. `flags` and `mode` are accepted and ignored: the
   * builders only ever open to read back what they wrote, and silently
   * accepting a write flag while not honouring it would be worse than the
   * narrow surface. */
  /**
   * Open a path and get a handle.
   *
   * The flags were ignored here until the builder recipes needed `write`, and
   * ignoring them was not harmless: every recipe opens with
   * `O_WRONLY|O_CREAT|O_TRUNC`, so a second build writing over an existing file
   * would have SPLICED into the old bytes instead of replacing them. A shorter
   * new file would have kept the old file's tail, which is the kind of wrong
   * that produces a working image containing something nobody wrote.
   *
   * Handles are the bridge's own: a path plus a cursor. The module addresses
   * files by path, so there is no kernel fd to mirror and no state to leak if a
   * caller forgets to close one.
   */
  open(path: string, flags = 0, mode = 0o644): number {
    const create = (flags & OPEN_FLAGS.O_CREAT) !== 0;
    const truncate = (flags & OPEN_FLAGS.O_TRUNC) !== 0;
    let exists = true;
    try {
      this.lstat(path);
    } catch (error) {
      if (!create) throw error; // ENOENT, before a handle is issued.
      exists = false;
    }
    if (!exists || truncate) this.writeFile(path, new Uint8Array(0), mode);
    const handle = this.nextHandle++;
    this.openFiles.set(handle, { path, offset: 0, mode });
    return handle;
  }

  /**
   * Follow symlinks and stat what they point at.
   *
   * The module answers `lstat` only, because the kernel's own `rootfs::lstat`
   * is what it wraps. Resolving here rather than adding a following variant to
   * the module keeps the resolution in one place: a builder that wants the link
   * itself already has `lstat`, and a module entry point that differed only by
   * a boolean would be a second spelling of the same question.
   */
  stat(path: string): SffsStat {
    // POSIX requires a bounded chain; forty is far above any real tree and far
    // below anything that could hang a build on a symlink cycle.
    let current = path;
    for (let hop = 0; hop < 40; hop += 1) {
      const st = this.lstat(current);
      if ((st.mode & 0o170000) !== 0o120000) return st;
      const target = this.readlink(current);
      current = target.startsWith("/")
        ? target
        : `${current.slice(0, current.lastIndexOf("/") + 1)}${target}`;
    }
    throw new SffsImageError(ERRNO.ELOOP, "stat", path);
  }

  /**
   * Write into an open handle at `position`, or at the handle's own cursor.
   *
   * Read-modify-write, because the module addresses whole files. That is not
   * the quadratic cost it looks like: `writeVfsBinary` hands over the entire
   * remaining buffer in one call, so a binary is written in a single pass. A
   * caller that dribbled bytes in would pay for it, and no builder does.
   *
   * A write past the end zero-fills the gap, which is what a POSIX write to a
   * position beyond EOF does. Silently dropping the gap would produce a file
   * whose length disagreed with where its bytes are.
   */
  write(
    handle: number,
    buffer: Uint8Array,
    position: number | null,
    length = buffer.byteLength,
  ): number {
    const open = this.openFiles.get(handle);
    if (!open) throw new Error(`sffs-module: bad file handle ${handle}`);
    const at = position ?? open.offset;
    const incoming = buffer.subarray(0, Math.min(length, buffer.byteLength));

    const existing = this.readFile(open.path);
    const end = Math.max(existing.byteLength, at + incoming.byteLength);
    const next = new Uint8Array(end);
    next.set(existing, 0);
    next.set(incoming, at);
    this.writeFile(open.path, next, open.mode);

    if (position === null) open.offset = at + incoming.byteLength;
    return incoming.byteLength;
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
  /**
   * Register a file fetched STANDALONE: no archive behind it, and `url` is the
   * whole of what says where its bytes are.
   *
   * This positional form is what builder recipes call —
   * `build-perl-vfs-image.ts` and `source-rootfs-shell-overlay.ts` both do, and
   * `MemoryFileSystem` has had the same shape all along. The object form below
   * registers an ARCHIVE MEMBER, which is a different operation that wore this
   * same name until now.
   */
  registerLazyFile(path: string, url: string, size: number, mode = 0o755): number {
    this.registerArchiveMember({
      path,
      archiveId: 0,
      sourcePath: "",
      size,
      mode,
      ino: this.nextStandaloneIno(),
      archiveBytes: 0,
      archiveDescriptor: encoder.encode(url),
    });
    return 0;
  }

  /**
   * Inode numbers for standalone registrations, which the positional
   * `registerLazyFile` does not take one for — `MemoryFileSystem` assigns them
   * itself, so a bridge that demanded one would not be answering the same call.
   *
   * Counts UP from a high value so it cannot collide with the inodes a
   * builder assigns explicitly through {@link registerArchiveMember}, which are
   * small and come from a manifest. (The comment said "down" while the code
   * incremented; the behaviour was always safe and the words were not.)
   */
  private standaloneIno = 0x7fff_0000;
  private nextStandaloneIno(): number {
    this.standaloneIno += 1;
    return this.standaloneIno;
  }

  /**
   * Register a whole lazy archive: every member of a zip, mounted under a
   * prefix, backed by one archive the fetcher will pull on first touch.
   *
   * **Every member is planned before any is created.** `planLazyArchiveEntries`
   * is the same validator `MemoryFileSystem` uses — shared rather than copied,
   * because it is what stops a member called `../../etc/passwd` from landing
   * wherever path resolution takes it — and running it over the whole archive
   * first means a member rejected halfway cannot leave a partial tree behind.
   * A half-registered archive would be worse than a refused one: the image
   * would build, and be missing exactly the files nobody checked for.
   *
   * Returns the archive id assigned, which the caller needs for nothing today
   * and is returned because a second archive must not silently reuse the first
   * one's id.
   */
  registerLazyArchive(args: {
    url: string;
    entries: ZipEntry[];
    mountPrefix: string;
    symlinkTargets?: Map<string, string>;
    integrity?: { sha256: string; bytes: number };
  }): number {
    const planned = planLazyArchiveEntries(
      args.url,
      args.entries,
      args.mountPrefix,
      args.symlinkTargets,
    );
    const archiveId = ++this.lastArchiveId;
    // The archive's own fetch description. Opaque to the kernel, which carries
    // it and never parses it; whoever fetches decides whether the URL may be
    // fetched and validates the digest.
    //
    // `mountPrefix` and `bytes` are here because the CONSUMER needs them and
    // the kernel does not read this. Rebuilding the kernel's lazy manifest
    // from an image requires the mount prefix — it is encoded into the manifest
    // record — and the module's own metadata does not carry one. Writing it in
    // the descriptor keeps the reconstruction exact instead of inferring a
    // prefix from member paths, which would be inventing data and would be
    // wrong for any archive whose members do not share one.
    const descriptor = encoder.encode(JSON.stringify({
      url: args.url,
      mountPrefix: args.mountPrefix,
      ...(args.integrity
        ? { sha256: args.integrity.sha256, bytes: args.integrity.bytes }
        : {}),
    }));
    const archiveBytes = args.integrity?.bytes ?? 0;

    // Directories first, so a member never arrives before its parent.
    //
    // `ensureDirRecursive` makes a path's PARENTS, not the path itself — it is
    // `mkdir -p` of the containing directory, which is what every other caller
    // wants and reads wrong here. So a directory ENTRY needs both: its parents,
    // then itself with its own mode.
    for (const { entry, vfsPath } of planned) {
      if (!entry.isDirectory) continue;
      this.ensureDirRecursive(vfsPath);
      try {
        this.mkdir(vfsPath, entry.mode & 0o7777);
      } catch (error) {
        // An archive may name a directory its own members already implied.
        if ((error as { errno?: number }).errno !== ERRNO.EEXIST) throw error;
      }
    }
    for (const { entry, vfsPath, archivePath } of planned) {
      if (entry.isDirectory) continue;
      // The file's own path: its parents are exactly the directories it needs.
      this.ensureDirRecursive(vfsPath);
      if (entry.isSymlink) {
        const target = args.symlinkTargets?.get(entry.fileName);
        if (target === undefined) {
          throw new Error(`lazy archive symlink target missing: ${entry.fileName}`);
        }
        this.symlink(target, vfsPath, 0, 0);
        continue;
      }
      this.registerArchiveMember({
        path: vfsPath,
        archiveId,
        sourcePath: archivePath,
        size: entry.uncompressedSize,
        mode: entry.mode & 0o7777,
        ino: this.nextStandaloneIno(),
        archiveBytes,
        archiveDescriptor: descriptor,
      });
    }
    return archiveId;
  }

  /** Archive ids are assigned here; 0 means "no archive" to the module. */
  private lastArchiveId = 0;

  registerArchiveMember(args: {
    path: string;
    archiveId: number;
    sourcePath: string;
    size: number;
    mode: number;
    uid?: number;
    gid?: number;
    ino: number;
    /**
     * The archive's total length. Pass `0` with `archiveId: 0` for a file
     * fetched standalone — there is no archive to bound a read of.
     */
    archiveBytes: number;
    /**
     * The archive's own fetch description — URL, transport, integrity digest.
     * Carried opaquely and never parsed. Optional here because whether a
     * producer must supply one is a policy question this bridge does not
     * answer; an image whose archives carry none is a real state, and a
     * visible one.
     */
    /**
     * With an archive, this describes the ARCHIVE. Without one
     * (`archiveId: 0`), it describes this FILE — and is then the only thing
     * that says where its bytes are, which is where a digest for a
     * URL-backed setuid binary belongs.
     */
    archiveDescriptor?: Uint8Array;
    /**
     * The activation cohort this ARCHIVE belongs to, if any.
     *
     * A cohort activates atomically: either every archive in it is fetched or
     * none is. Declared here rather than through a call of its own because a
     * cohort member IS an archive, and this is where an archive is named --
     * the same reasoning that puts `archiveBytes` here.
     *
     * Declared, not computed. The cohort's digest covers every member, so it
     * cannot be known while the first member is being registered; the module
     * completes the seal when the image is exported. A builder that names the
     * cohort on every member of an archive is doing the ordinary thing, and
     * repeating the same membership is a no-op.
     *
     * `expectedCount` is how many ARCHIVES the cohort holds. It is declared
     * rather than counted because a count taken from the archives that were
     * registered cannot notice the one that was not.
     */
    cohort?: { id: string; member: string; expectedCount: number };
  }): void {
    const descriptor = args.archiveDescriptor ?? new Uint8Array(0);
    const cohortId = args.cohort?.id ?? "";
    const cohortMember = args.cohort?.member ?? "";
    this.withPath(args.path, (p, pl) =>
      this.withPath(args.sourcePath, (s, sl) =>
        this.withBytes(descriptor, (d, dl) =>
          this.withPath(cohortId, (c, cl) =>
            this.withPath(cohortMember, (m, ml) =>
              this.check(
                this.exports.sm_register_lazy_file(
                  p, pl, args.archiveId, s, sl,
                  BigInt(args.size), args.mode, args.uid ?? 0, args.gid ?? 0, BigInt(args.ino),
                  BigInt(args.archiveBytes),
                  dl === 0 ? 0 : d, dl,
                  cl === 0 ? 0 : c, cl,
                  ml === 0 ? 0 : m, ml,
                  args.cohort?.expectedCount ?? 0,
                ),
                "registerLazyFile",
                args.path,
              ))))));
  }

  /**
   * Whether `path`'s bytes are in the image.
   *
   * Replaces the two questions builder recipes asked the TypeScript filesystem
   * — `isPathDeferred` and `getLazyEntry(...) !== null` — which are real
   * product assertions ("dinit must be resident before service boot", "the
   * login program must be eager") and were the only reason those recipes
   * needed the implementation rather than an interface.
   *
   * Read from the stat record rather than a call of its own: whether a file's
   * bytes are present is metadata about the file, and `size` there is already
   * its real length whether or not it is deferred.
   *
   * The fetch URL is deliberately absent. Nothing reads one through this path,
   * and it lives in the deferred payload the kernel carries without reading.
   */
  /**
   * Free space and free inodes in the image this tree would export, judged
   * against a profile.
   *
   * Returns the four numbers whether or not the profile is met, because a
   * caller that only learns "no" cannot say by how much — and the message a
   * build script wants to print is not one a `no_std` policy should own.
   *
   * The arithmetic lives in Rust: this is a VERDICT, not a `statfs`. Exposing
   * the primitive would have moved a syscall and left the multiplication, the
   * comparison and the judgement on this side.
   */
  checkHeadroom(minimumFreeBytes: number, minimumFreeInodes: number): {
    met: boolean;
    freeBytes: number;
    requiredBytes: number;
    freeInodes: number;
    requiredInodes: number;
  } {
    const { capacityBytes: _ignored, ...verdict } =
      this.exportImageFacts(minimumFreeBytes, minimumFreeInodes);
    return verdict;
  }

  /**
   * Everything the module can say about the image this tree would export: the
   * headroom verdict, the numbers behind it, and the growth ceiling.
   *
   * One crossing rather than one per assertion — a second entry point for
   * capacity was written and the surface budget refused it, which was the right
   * answer: the builders assert several things about one artifact.
   */
  private exportImageFacts(minimumFreeBytes = 0, minimumFreeInodes = 0): {
    met: boolean;
    freeBytes: number;
    requiredBytes: number;
    freeInodes: number;
    requiredInodes: number;
    capacityBytes: number;
  } {
    const size = this.exports.sm_check_headroom(0n, 0n, 0, 0);
    const ptr = this.exports.sm_alloc(size);
    if (ptr === 0) throw new Error("sffs-module: allocation failed");
    try {
      const rc = this.exports.sm_check_headroom(
        BigInt(minimumFreeBytes), BigInt(minimumFreeInodes), ptr, size,
      );
      const view = new DataView(this.exports.memory.buffer, ptr, size);
      const at = (i: number) => Number(view.getBigUint64(i * 8, true));
      // A breach is a VERDICT, not a failure to compute: the numbers under it
      // are the reason, and throwing would discard them. Anything else is a
      // real error.
      if (rc !== 0 && rc !== -ERRNO.EDOM) {
        throw new SffsImageError(-rc, "checkHeadroom", "");
      }
      return {
        met: rc === 0,
        freeBytes: at(0),
        requiredBytes: at(1),
        freeInodes: at(2),
        requiredInodes: at(3),
        capacityBytes: at(4),
      };
    } finally {
      this.exports.sm_free(ptr, size);
    }
  }

  /**
   * The growth ceiling the exported image will declare.
   *
   * Asked of the producer rather than parsed out of the finished bytes: the
   * ceiling lives in the container header and the SFFS superblock, and reading
   * it here would put format parsing back on this side over an artifact the
   * module just produced.
   */
  exportCapacityBytes(): number {
    // From the same record as the headroom verdict: the builders make several
    // assertions about one artifact, and each is a separate ABI crossing only
    // if the module is asked one question at a time.
    return this.exportImageFacts().capacityBytes;
  }

  /**
   * Are the bytes this path REFERS TO absent from the image?
   *
   * Follows symlinks, and answers `false` for a path that does not exist.
   * Both matter, and both were wrong when this used `lstat` and threw:
   *
   * * A symlink is never itself deferred, so `lstat` answered about the LINK
   *   and said "not deferred" for every alias of a lazy binary. The shell
   *   composer skips a binary that is already lazy, so it re-registered
   *   `/bin/coreutils` and failed on an undeclared dependency — a product
   *   build, not a test. The filesystem this replaces resolved the path, and
   *   this is the faithful port of it.
   * A path that does not exist answers `false`, matching the filesystem this
   * replaces. I first made it THROW, reasoning that a caller asking about a
   * path it got wrong should hear about the typo — and a real caller settled
   * it the other way: `residentDinitBinaryState` treats "missing" as one of
   * its own outcomes and distinguishes it with `stat` a few lines later, so a
   * throw here meant that branch could never be reached. The speculative typo
   * lost to the concrete caller.
   *
   * The honest reading agrees: a path that is not there is not a DEFERRED
   * file, and callers that care whether it exists ask that question directly.
   * Only `ENOENT` is absorbed, so a broken tree still surfaces.
   */
  isPathDeferred(path: string): boolean {
    try {
      return this.stat(path).deferred;
    } catch (error) {
      if ((error as { errno?: number }).errno === ERRNO.ENOENT) return false;
      throw error;
    }
  }

  /**
   * Always `null`: this filesystem has one notion of deferred, not two.
   *
   * `MemoryFileSystem` splits the question across a per-inode lazy registry
   * and a lazy archive backing, so its callers compute the union by hand. Here
   * a deferred file is a deferred file whether an archive or a URL stands
   * behind it, and `isPathDeferred` already reports both — so the union those
   * callers compute comes out identical against this implementation.
   */
  /**
   * The per-inode lazy registration for a path, or null when there is none.
   *
   * **This returned `null` unconditionally**, which was a stub wearing the
   * shape of an answer. Recipes ask `getLazyEntry(p) !== null` as one HALF of
   * "are these bytes here?" — it covers a URL-backed SINGLE lazy file, while
   * `isPathDeferred` covers an archive or tree backing — and the assertions
   * built on the pair are "dinit must be resident before service boot" and
   * "the login program must be eager". A half that always says "no
   * registration" turns those into the other half alone, which drops exactly
   * the URL-backed case.
   *
   * No repointed recipe called it yet, so nothing shipped weakened. It is
   * implemented now rather than later because the next file to repoint DOES
   * call it, and a stub that answers plausibly is worse than one that throws.
   *
   * A URL-backed single is `deferred` with no archive behind it — which is the
   * same distinction `sm_lstat` already reports, so this needs no new module
   * surface.
   */
  getLazyEntry(path: string): { size: number; deferred: true } | null {
    let st;
    try {
      // Resolved, for the reason `isPathDeferred` gives: an alias of a lazy
      // binary is a symlink, and `lstat` answers about the link.
      st = this.stat(path);
    } catch {
      return null; // No such path is not a lazy registration.
    }
    return st.deferred && st.archiveId === 0
      ? { size: st.size, deferred: true }
      : null;
  }

  /**
   * The finished image's bytes, under the name the builders already call.
   *
   * Async to match what a recipe is handed today, not because anything here
   * waits: `exportImage()` is synchronous, and a bridge that pretended
   * otherwise would be inventing a difference. The signature exists so
   * `VfsImageFilesystem` can describe both implementations without either
   * having to change shape at the call sites.
   *
   * `materializeAll` and `normalizeTimestampsMs` are accepted and ignored.
   * Neither has meaning here — nothing in this filesystem is unmaterialised in
   * the sense the TypeScript one means, and its timestamps are already the
   * ones the builder set. Accepting and ignoring them is honest where
   * rejecting them would break a caller that passes a default it does not
   * depend on; a caller that DEPENDS on either is asking for behaviour this
   * filesystem does not have, and that is a gap to close rather than fake.
   */
  async saveImage(options?: {
    materializeAll?: boolean;
    metadata?: unknown;
    normalizeTimestampsMs?: number;
  }): Promise<Uint8Array> {
    if (options?.metadata !== undefined) {
      this.setImageMetadata(options.metadata);
    }
    if (options?.normalizeTimestampsMs !== undefined) {
      this.setExportTimestamp(options.normalizeTimestampsMs);
    }
    if (options?.materializeAll) {
      // Accepting an option and ignoring it is worse than not offering it: the
      // caller believes the artifact is what it asked for. `materializeAll`
      // means "fetch every deferred file and write its bytes in", and this
      // module has no fetcher -- the transports are the host's. Saying so is
      // the truthful answer; silently exporting a tree still full of deferred
      // stubs, under a name that promised otherwise, is not.
      throw new Error(
        "sffs-module: materializeAll is not supported — the module carries " +
          "deferred descriptions and does not fetch them",
      );
    }
    return this.exportImage();
  }

  /**
   * Stamp this millisecond on every inode the next export emits.
   *
   * A build that produces the same tree from the same inputs must produce the
   * same BYTES, or every downstream cache keys on the wall clock. Only the
   * detached artifact is normalised: the live tree keeps truthful timestamps
   * while it is being worked on.
   */
  setExportTimestamp(ms: number | null): void {
    this.normalizeTimestampsMs = ms;
    this.setImageMetadata(this.lastMetadata);
  }

  private normalizeTimestampsMs: number | null = null;

  /**
   * Metadata the exported image will declare: the builder's statements about
   * its own artifact (`version`, `kernelAbi`, `createdBy`).
   *
   * Passed as bytes and never parsed by the kernel. Pass `null` to clear.
   */
  /**
   * The capacity the exported image should declare — a FLOOR on its growth
   * ceiling, not a size.
   *
   * A product declares this (`expectedMaxByteLength`) and its publication gate
   * checks the artifact against it. Without it the export sizes to its own
   * tree, so the image meets no declared capacity and has no runtime growth
   * room at all.
   *
   * Held here and sent with the metadata because both are statements about the
   * artifact rather than operations on the tree, and one export carries both.
   */
  private requestedCapacityBytes = 0;

  setImageCapacity(bytes: number): void {
    this.requestedCapacityBytes = bytes;
    this.setImageMetadata(this.lastMetadata);
  }

  private lastMetadata: unknown | null = null;

  /**
   * The image metadata this filesystem carries, or null when it carries none.
   *
   * **Read from the module, never from `lastMetadata`.** After a load the
   * KERNEL holds what the image declared and this bridge sent nothing, so the
   * replay buffer would answer confidently and wrongly — which is precisely
   * the derived-build case every caller of this is guarding.
   */
  getImageMetadata(): VfsImageMetadata | null {
    const size = this.check(
      this.exports.sm_image_metadata(0, 0),
      "getImageMetadata",
      "",
    );
    if (size === 0) return null;
    const buf = this.exports.sm_alloc(size);
    if (buf === 0) throw new Error("sffs-module: allocation failed");
    try {
      const n = this.check(
        this.exports.sm_image_metadata(buf, size),
        "getImageMetadata",
        "",
      );
      return JSON.parse(decoder.decode(this.mem.subarray(buf, buf + n))) as
        VfsImageMetadata;
    } finally {
      this.exports.sm_free(buf, size);
    }
  }

  setImageMetadata(metadata: unknown | null): void {
    this.lastMetadata = metadata;
    const bytes = metadata === null
      ? new Uint8Array(0)
      : encoder.encode(JSON.stringify(metadata));
    this.withBytes(bytes, (p, pl) =>
      this.check(
        this.exports.sm_set_image_options(
          BigInt(this.requestedCapacityBytes),
          bytes.byteLength === 0 ? 0 : p,
          pl,
          // Negative means "each inode keeps its own times". There is no such
          // instant, so the whole negative range is free to mean unset without
          // stealing a representable value.
          BigInt(this.normalizeTimestampsMs ?? -1),
        ),
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
  /**
   * Read the metadata an image declares, without keeping the image.
   *
   * The static form `MemoryFileSystem.readImageMetadata` has, for callers that
   * hold image BYTES and want to know what they say about themselves — a
   * publication gate checking an artifact's ABI, for instance — rather than
   * callers building a tree.
   *
   * It loads the image to read it, because the metadata lives inside the
   * container and the loader is what knows the layout. That is heavier than
   * parsing the header host-side, and deliberately so: a second reader of the
   * container format in TypeScript is exactly what gap 11 warns about, and this
   * runs at build time where the cost is a few milliseconds.
   */
  static readImageMetadata(image: Uint8Array): VfsImageMetadata | null {
    // `loadImage` decompresses, so this reads a `.vfs.zst` too.
    const fs = SffsImageFs.create();
    fs.loadImage(image);
    return fs.getImageMetadata();
  }

  /**
   * The growth ceiling an image declares, without keeping the image.
   *
   * A CEILING and not an allocation: the image says how far it may grow, and a
   * loader restoring it costs the inode table its share rather than the
   * declared room. That is the whole reason a builder can ask this of a 256 MiB
   * base without paying 256 MiB to find out.
   */
  static readImageCapacity(image: Uint8Array): { maxByteLength: number } {
    const fs = SffsImageFs.create();
    fs.loadImage(image);
    return { maxByteLength: fs.exportCapacityBytes() };
  }

  /**
   * Load a VFS image as the base layer, replacing whatever tree is present.
   * Returns the number of entries the kernel inserted.
   *
   * This is what a DERIVED build starts from: the kernel mounts the image,
   * walks it, and adopts its deferred linkage, so files the recipe never
   * touches keep their real sizes and their lazy backing.
   *
   * **Ownership transfers on success and only on success.** The module keeps
   * the buffer — a loaded image hands out nodes that are promises the kernel
   * can come back for those bytes later, so freeing after the load would make
   * every base file unreadable. It is not copied because `lamp.vfs` is 249 MiB
   * and a copy would mean both resident at once in a 32-bit address space. On
   * failure the module has not adopted it and this frees it, which is why the
   * free lives in a `catch` rather than a `finally`.
   */
  loadImage(
    compressedOrPlain: Uint8Array,
    options: { maxDecompressedBytes?: number } = {},
  ): number {
    // Shipped images are `.vfs.zst`. The module reads IMAGES, not archives, so
    // a compressed one reached it as `EINVAL` -- a truthful refusal of the
    // wrong question. Decompression is transport, and it happens here for the
    // same reason it happened inside the filesystem this bridge replaces:
    // callers should not have to know whether the bytes they were handed came
    // from a `.vfs` or a `.vfs.zst`. The bound is the caller's, and the frame
    // walk that enforces it runs before a byte is decompressed.
    const image = maybeDecompressImage(
      compressedOrPlain,
      options.maxDecompressedBytes,
    );
    const ptr = this.exports.sm_alloc(image.byteLength);
    if (ptr === 0) throw new Error("sffs-module: allocation failed");
    try {
      this.mem.set(image, ptr);
      const entries = this.check(
        this.exports.sm_load_image(ptr, image.byteLength),
        "loadImage",
        "",
      );
      // GAP 17. `sm_set_image_options` carries capacity and metadata together,
      // so `setImageCapacity` re-sends the metadata from `lastMetadata` — which
      // is correct only while this bridge is the metadata's only author. A load
      // makes the KERNEL an author: it restores what the image declared, and
      // this bridge still remembers null. Sizing a derived image after loading
      // its base would then clear the base's declared ABI, which is exactly the
      // sequence the shell and php-test builders perform. Refreshed here
      // because this is the only moment it can change behind the bridge's back.
      this.lastMetadata = this.getImageMetadata();
      // GAP 24, and the same defect as gap 17 on the OTHER field the one entry
      // point carries. `sm_set_image_options` sends capacity AND metadata
      // together, so each has to survive a load that the kernel authored --
      // and only the metadata was refreshed here.
      //
      // A load restores the image's declared capacity inside the module; this
      // bridge went on remembering 0, so the next `setImageMetadata` sent 0
      // and CLEARED it. The shell composer does exactly that: load a 256 MiB
      // base, write files, then save with metadata. The image came out
      // declaring 143 MiB -- sized to its own tree -- and failed its product
      // profile at the publication gate.
      //
      // `sm_check_headroom` answers this without building an export, so a load
      // pays one ABI crossing rather than a plan for a 250 MiB image.
      this.requestedCapacityBytes = this.exportCapacityBytes();
      return entries;
    } catch (error) {
      this.exports.sm_free(ptr, image.byteLength);
      throw error;
    }
  }

  /**
   * Every deferred file and declared archive in the tree.
   *
   * What a builder compares when it asserts that a step disturbed nothing. The
   * identity of a deferred file is its path, inode, real size and backing
   * archive; an archive's is its id, length and fetch description.
   *
   * The descriptions are returned as BYTES and not parsed here. They are the
   * fetcher's to read -- a URL, a transport, a digest -- and this bridge
   * carries them for the same reason the kernel does: whoever fetches decides
   * whether a URL may be fetched, and carrying the bytes authorises nothing.
   */
  lazyEntries(): {
    files: {
      path: string;
      ino: bigint;
      size: number;
      archiveId: number;
      sourcePath: string;
      descriptor: Uint8Array;
    }[];
    archives: { archiveId: number; bytes: number; descriptor: Uint8Array }[];
  } {
    const required = this.check(this.exports.sm_lazy_entries(0, 0), "lazyEntries", "");
    const ptr = this.exports.sm_alloc(Math.max(required, 1));
    if (ptr === 0) throw new Error("sffs-module: allocation failed");
    try {
      this.check(this.exports.sm_lazy_entries(ptr, required), "lazyEntries", "");
      const bytes = this.mem.slice(ptr, ptr + required);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let at = 0;
      const u32 = () => {
        const value = view.getUint32(at, true);
        at += 4;
        return value;
      };
      const u64 = () => {
        const value = view.getBigUint64(at, true);
        at += 8;
        return value;
      };
      const blob = () => {
        const len = u32();
        const value = bytes.subarray(at, at + len);
        at += len;
        return value;
      };
      const text = () => decoder.decode(blob());
      const fileCount = u32();
      const archiveCount = u32();
      const files = [];
      for (let i = 0; i < fileCount; i++) {
        files.push({
          path: text(),
          ino: u64(),
          size: Number(u64()),
          archiveId: u32(),
          sourcePath: text(),
          descriptor: blob(),
        });
      }
      const archives = [];
      for (let i = 0; i < archiveCount; i++) {
        archives.push({ archiveId: u32(), bytes: Number(u64()), descriptor: blob() });
      }
      if (at !== required) {
        // Every byte the module wrote must be accounted for. Trailing bytes
        // mean this reader and that writer disagree about the record set, and
        // a reader that stops early would silently drop whatever came after.
        throw new Error(
          `sffs-module: lazy entry record set has ${required - at} trailing bytes`,
        );
      }
      return { files, archives };
    } finally {
      this.exports.sm_free(ptr, Math.max(required, 1));
    }
  }

  /**
   * Read the LOADED image's bytes at `offset` into `dest`, returning the
   * number copied and `0` at or past the end.
   *
   * This is the window the in-kernel rootfs overlay reads base-file content
   * through for the life of a session, which `MemoryFileSystem.imageBodyBytes`
   * serves today by handing out a view of its SharedArrayBuffer. It is NOT
   * `exportImage`: that one builds an image from the current tree and streams
   * it in order, so using it here would rebuild the whole image on every
   * base-file read — and, because the export seals cohorts at offset 0, would
   * make a read mutate the tree it is reading.
   */
  imageRead(offset: bigint, dest: Uint8Array): number {
    const ptr = this.exports.sm_alloc(dest.length);
    if (ptr === 0) throw new Error("sffs-module: allocation failed");
    try {
      const n = this.check(
        this.exports.sm_image_read(offset, ptr, dest.length),
        "imageRead",
        "",
      );
      if (n > 0) {
        // A fresh view: the module may have grown its memory since `sm_alloc`,
        // which detaches any view taken before it.
        dest.set(this.mem.subarray(ptr, ptr + n));
      }
      return n;
    } finally {
      this.exports.sm_free(ptr, dest.length);
    }
  }

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
 * Field order of the module's stat record: eight little-endian `u64`s.
 *
 * The module documents this layout and answers its length when called with
 * `out_len === 0`, so nothing here hardcodes a byte count.
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
  DEFERRED: 6,
  ARCHIVE_ID: 7,
} as const;

/**
 * The module bytes a Node caller gets when it passes none.
 *
 * Reached through `process.getBuiltinModule` rather than a top-level
 * `import ... from "node:fs"`, and that is not a style choice. This file is
 * imported INSIDE THE BROWSER — the demo specs load it in the page, and the
 * worker entries will — so a static Node-builtin import puts one in the
 * browser's module graph. That exact defect took 103 of 184 fast specs down
 * earlier in this campaign, and
 * `host/test/browser-worker-node-globals.test.ts` exists to catch it.
 *
 * `getBuiltinModule` is synchronous, needs no import, and takes a runtime
 * string a bundler cannot follow. A browser reaching here gets a clear
 * instruction instead of a missing-module crash three frames deeper.
 */
function defaultModuleBytes(): Uint8Array {
  const runtime = (globalThis as {
    process?: { getBuiltinModule?: (id: string) => unknown };
  }).process;
  const nodeFs = runtime?.getBuiltinModule?.("node:" + "fs") as
    | { readFileSync(path: string): Uint8Array }
    | undefined;
  if (nodeFs === undefined) {
    throw new Error(
      "SffsImageFs.create() cannot read sffs_module32.wasm outside Node. "
        + "Pass the module bytes explicitly: SffsImageFs.create(moduleBytes).",
    );
  }
  const root = `${import.meta.dirname}/../../..`;
  return new Uint8Array(nodeFs.readFileSync(`${root}/local-binaries/sffs_module32.wasm`));
}
