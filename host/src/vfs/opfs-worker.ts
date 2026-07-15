/// <reference path="./opfs-types.d.ts" />

import { joinSafeI64, splitSafeI64 } from "./i64";
import type { StatResult } from "../types";
import { writeOpfsStatResult } from "./opfs-stat";

/**
 * OPFS Proxy Worker — dedicated Web Worker that executes async OPFS
 * operations on behalf of the synchronous OpfsFileSystem.
 *
 * Communication: SharedArrayBuffer + Atomics (via OpfsChannel).
 *
 * Lifecycle:
 *   1. Main thread posts { type: "init", buffer: SharedArrayBuffer }
 *   2. Worker enters poll loop using Atomics.waitAsync()
 *   3. On each PENDING request: read opcode + args, execute OPFS op,
 *      write result, notify COMPLETE/ERROR
 */

// These must be kept in sync with opfs-channel.ts.
// We duplicate them here so the worker can be a standalone entry point
// without importing from the channel module (which uses const enum that
// gets inlined by TypeScript anyway).
const Status = {
  Idle: 0,
  Pending: 1,
  Complete: 2,
  Error: 3,
} as const;

const Opcode = {
  OPEN: 1,
  CLOSE: 2,
  READ: 3,
  WRITE: 4,
  SEEK: 5,
  FSTAT: 6,
  FTRUNCATE: 7,
  FSYNC: 8,
  STAT: 9,
  LSTAT: 10,
  MKDIR: 11,
  RMDIR: 12,
  UNLINK: 13,
  RENAME: 14,
  ACCESS: 15,
  OPENDIR: 16,
  READDIR: 17,
  CLOSEDIR: 18,
  STATFS: 19,
} as const;

// Errno values (negative, matching Linux)
const ENOENT = -2;
const EBADF = -9;
const EEXIST = -17;
const ENOTDIR = -20;
const EISDIR = -21;
const EINVAL = -22;
const ENOSPC = -28;
const ENOTEMPTY = -39;
const EOVERFLOW = -75;
const ENOTSUP = -95;

// Open flags (Linux values)
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const O_APPEND = 0x0400;
const O_DIRECTORY = 0x010000;

// Stat mode bits
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

// Seek whence
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

// DirEntry type constants
const DT_REG = 8;
const DT_DIR = 4;

const OPFS_SUPER_MAGIC = 0x4f504653; // "OPFS"
const STATFS_BLOCK_SIZE = 4096;
const STATFS_NAME_MAX = 255;
const OPFS_DEVICE_ID = 0n;
const MAX_U64 = (1n << 64n) - 1n;
const OPFS_ORPHAN_DIRECTORY = ".kandelo-opfs-unlinked-v1";

// --- Channel accessor helpers (offsets matching opfs-channel.ts) ---

const STATUS_OFFSET_I32 = 0; // byte 0 / 4
const OPCODE_OFFSET = 4;
const ARGS_OFFSET = 8;
const RESULT_OFFSET = 56;
const RESULT2_OFFSET = 60;
const DATA_OFFSET = 64;

class WorkerChannel {
  readonly i32: Int32Array;
  readonly view: DataView;
  readonly buffer: SharedArrayBuffer;

  constructor(buffer: SharedArrayBuffer) {
    this.buffer = buffer;
    this.i32 = new Int32Array(buffer);
    this.view = new DataView(buffer);
  }

  get opcode(): number {
    return this.view.getInt32(OPCODE_OFFSET, true);
  }

  getArg(index: number): number {
    return this.view.getInt32(ARGS_OFFSET + index * 4, true);
  }

  getI64Arg(index: number): number {
    return joinSafeI64(this.getArg(index), this.getArg(index + 1));
  }

  set result(value: number) {
    this.view.setInt32(RESULT_OFFSET, value, true);
  }

  set result2(value: number) {
    this.view.setInt32(RESULT2_OFFSET, value, true);
  }

  set i64Result(value: number) {
    const [low, high] = splitSafeI64(value);
    this.result = low;
    this.result2 = high;
  }

  get dataBuffer(): Uint8Array {
    return new Uint8Array(this.buffer, DATA_OFFSET);
  }

  readString(length: number): string {
    const bytes = new Uint8Array(this.buffer, DATA_OFFSET, length).slice();
    return new TextDecoder().decode(bytes);
  }

  readTwoStrings(totalLength: number): [string, string] {
    const data = new Uint8Array(this.buffer, DATA_OFFSET, totalLength).slice();
    const nullIdx = data.indexOf(0);
    const decoder = new TextDecoder();
    return [
      decoder.decode(data.subarray(0, nullIdx)),
      decoder.decode(data.subarray(nullIdx + 1)),
    ];
  }

  writeString(str: string): number {
    const bytes = new TextEncoder().encode(str);
    this.dataBuffer.set(bytes);
    return bytes.length;
  }

  writeStatResult(stat: StatResult): void {
    writeOpfsStatResult(this.buffer, DATA_OFFSET, stat);
  }

  writeStatfsResult(statfs: {
    type: number; bsize: number; blocks: number; bfree: number; bavail: number;
    files: number; ffree: number; fsid: number; namelen: number; frsize: number; flags: number;
  }): void {
    const f64 = new Float64Array(this.buffer, DATA_OFFSET, 11);
    f64[0] = statfs.type;
    f64[1] = statfs.bsize;
    f64[2] = statfs.blocks;
    f64[3] = statfs.bfree;
    f64[4] = statfs.bavail;
    f64[5] = statfs.files;
    f64[6] = statfs.ffree;
    f64[7] = statfs.fsid;
    f64[8] = statfs.namelen;
    f64[9] = statfs.frsize;
    f64[10] = statfs.flags;
  }

  notifyComplete(): void {
    Atomics.store(this.i32, STATUS_OFFSET_I32, Status.Complete);
    Atomics.notify(this.i32, STATUS_OFFSET_I32);
  }

  notifyError(errno: number): void {
    this.result = errno;
    Atomics.store(this.i32, STATUS_OFFSET_I32, Status.Error);
    Atomics.notify(this.i32, STATUS_OFFSET_I32);
  }
}

// --- OPFS handle management ---

interface OpfsInodeIdentity {
  ino: bigint;
  representative: FileSystemFileHandle;
  publicPath: string | null;
  orphanName: string | null;
  openReferences: number;
  accessHandle: FileSystemSyncAccessHandle | null;
}

interface OpfsFileEntry {
  identity: OpfsInodeIdentity | null;
  position: number;
  appendMode: boolean;
}

interface DirIterator {
  entries: { name: string; kind: "file" | "directory" }[];
  index: number;
}

let channel: WorkerChannel;
let opfsRoot: FileSystemDirectoryHandle;
let orphanDirectory: FileSystemDirectoryHandle;
let nextFileHandle = 1;
let nextDirHandle = 1;
let nextInode = 1n;
let nextOrphan = 1;
const orphanSessionId = crypto.randomUUID();
const fileHandles = new Map<number, OpfsFileEntry>();
const dirHandles = new Map<number, DirIterator>();
const identitiesByPath = new Map<string, OpfsInodeIdentity>();

class OpfsBoundaryError extends Error {
  constructor(readonly errno: number, message: string) {
    super(message);
  }
}

function removeIdentity(identity: OpfsInodeIdentity): void {
  if (
    identity.publicPath !== null &&
    identitiesByPath.get(identity.publicPath) === identity
  ) {
    identitiesByPath.delete(identity.publicPath);
  }
}

async function isSameEntry(
  handle: FileSystemFileHandle,
  other: FileSystemFileHandle,
): Promise<boolean> {
  if (typeof handle.isSameEntry !== "function") {
    throw new OpfsBoundaryError(
      ENOTSUP,
      "OPFS cannot provide stable file identity without isSameEntry()",
    );
  }
  return handle.isSameEntry(other);
}

async function identityFor(
  handle: FileSystemFileHandle,
  publicPath: string,
): Promise<OpfsInodeIdentity> {
  const existing = identitiesByPath.get(publicPath);
  if (existing !== undefined) {
    // isSameEntry() unifies separate handle objects for simultaneous opens.
    // The path map supplies the object generation that isSameEntry() itself
    // lacks after unlink/recreate.
    if (await isSameEntry(handle, existing.representative)) return existing;
    if (existing.openReferences > 0) {
      throw new OpfsBoundaryError(
        ENOTSUP,
        "OPFS file identity changed outside the active proxy session",
      );
    }
    removeIdentity(existing);
  }
  if (nextInode > MAX_U64) {
    throw new OpfsBoundaryError(EOVERFLOW, "OPFS inode identity exhausted");
  }
  const identity: OpfsInodeIdentity = {
    ino: nextInode++,
    representative: handle,
    publicPath,
    orphanName: null,
    openReferences: 0,
    accessHandle: null,
  };
  identitiesByPath.set(publicPath, identity);
  return identity;
}

function closeIdentityAccess(identity: OpfsInodeIdentity): void {
  if (identity.accessHandle === null) return;
  const accessHandle = identity.accessHandle;
  try {
    accessHandle.flush();
  } finally {
    try {
      accessHandle.close();
    } finally {
      identity.accessHandle = null;
    }
  }
}

async function reopenIdentityAccess(
  identity: OpfsInodeIdentity,
): Promise<void> {
  if (identity.openReferences > 0) {
    identity.accessHandle =
      await identity.representative.createSyncAccessHandle();
  }
}

async function moveIdentityToOrphan(
  identity: OpfsInodeIdentity,
): Promise<void> {
  const publicPath = identity.publicPath;
  if (publicPath === null) return;
  if (typeof identity.representative.move !== "function") {
    throw new OpfsBoundaryError(
      ENOTSUP,
      "OPFS cannot preserve an open unlinked file without move()",
    );
  }

  const hadAccessHandle = identity.accessHandle !== null;
  if (hadAccessHandle) closeIdentityAccess(identity);
  const orphanName = `${orphanSessionId}-${identity.ino}-${nextOrphan++}`;
  try {
    await identity.representative.move(orphanDirectory, orphanName);
  } catch (error) {
    if (hadAccessHandle) {
      try {
        await reopenIdentityAccess(identity);
      } catch {
        throw new OpfsBoundaryError(
          ENOTSUP,
          "OPFS could not restore an open file after failed unlink",
        );
      }
    }
    throw error;
  }

  if (identitiesByPath.get(publicPath) === identity) {
    identitiesByPath.delete(publicPath);
  }
  identity.publicPath = null;
  identity.orphanName = orphanName;
  await reopenIdentityAccess(identity);
}

async function moveIdentityToPublicPath(
  identity: OpfsInodeIdentity,
  destination: FileSystemDirectoryHandle,
  name: string,
  publicPath: string,
): Promise<void> {
  if (typeof identity.representative.move !== "function") {
    throw new OpfsBoundaryError(
      ENOTSUP,
      "OPFS cannot preserve file identity without move()",
    );
  }

  const previousPublicPath = identity.publicPath;
  const hadAccessHandle = identity.accessHandle !== null;
  if (hadAccessHandle) closeIdentityAccess(identity);
  try {
    await identity.representative.move(destination, name);
  } catch (error) {
    if (hadAccessHandle) {
      try {
        await reopenIdentityAccess(identity);
      } catch {
        throw new OpfsBoundaryError(
          ENOTSUP,
          "OPFS could not restore an open file after failed rename",
        );
      }
    }
    throw error;
  }

  if (
    previousPublicPath !== null &&
    identitiesByPath.get(previousPublicPath) === identity
  ) {
    identitiesByPath.delete(previousPublicPath);
  }
  identity.publicPath = publicPath;
  identity.orphanName = null;
  identitiesByPath.set(publicPath, identity);

  const movedHandle = await destination.getFileHandle(name);
  if (!(await isSameEntry(identity.representative, movedHandle))) {
    throw new OpfsBoundaryError(
      ENOTSUP,
      "OPFS move did not preserve file identity",
    );
  }
  await reopenIdentityAccess(identity);
}

async function removeOrphan(identity: OpfsInodeIdentity): Promise<void> {
  const orphanName = identity.orphanName;
  if (orphanName !== null) {
    await orphanDirectory.removeEntry(orphanName);
    identity.orphanName = null;
  }
  removeIdentity(identity);
}

/**
 * A proxy owns OPFS namespace mutation for its session. If the preceding
 * proxy was terminated while an unlinked file was open, no live handle can
 * ever refer to its private orphan again; clear those unreachable objects
 * before accepting requests for the new session.
 */
async function removeStaleOrphans(): Promise<void> {
  for await (const [name] of (orphanDirectory as any).entries()) {
    await orphanDirectory.removeEntry(name, { recursive: true });
  }
}

function accessHandleFor(entry: OpfsFileEntry): FileSystemSyncAccessHandle | null {
  return entry.identity?.accessHandle ?? null;
}

// --- Path resolution ---

function normalizePublicPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  if (normalized.split("/")[0] === OPFS_ORPHAN_DIRECTORY) {
    throw new OpfsBoundaryError(ENOENT, "OPFS internal path is not visible");
  }
  return normalized;
}

/** Split a path into directory components and final name. */
function splitPath(path: string): {
  dirParts: string[];
  name: string;
  normalized: string;
} {
  const normalized = normalizePublicPath(path);
  if (!normalized) return { dirParts: [], name: "", normalized };
  const parts = normalized.split("/");
  const name = parts.pop()!;
  return { dirParts: parts, name, normalized };
}

/** Walk directory handles from OPFS root to reach the parent directory. */
async function resolveParentDir(
  dirParts: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = opfsRoot;
  for (const part of dirParts) {
    dir = await dir.getDirectoryHandle(part);
  }
  return dir;
}

/** Resolve a full path to its parent directory handle and final name. */
async function resolvePath(
  path: string,
): Promise<{
  dir: FileSystemDirectoryHandle;
  name: string;
  normalized: string;
}> {
  const { dirParts, name, normalized } = splitPath(path);
  const dir = await resolveParentDir(dirParts);
  return { dir, name, normalized };
}

/** Resolve a path to a directory handle (the path itself is a directory). */
async function resolveDir(path: string): Promise<FileSystemDirectoryHandle> {
  const normalized = normalizePublicPath(path);
  if (!normalized) return opfsRoot;
  const parts = normalized.split("/");
  let dir = opfsRoot;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  return dir;
}

async function ensurePathExists(path: string): Promise<void> {
  const normalized = normalizePublicPath(path);
  if (!normalized) return;

  const { dir, name } = await resolvePath(path);
  try {
    await dir.getDirectoryHandle(name);
    return;
  } catch {
    await dir.getFileHandle(name);
  }
}

// --- DOMException → errno mapping ---

function mapError(err: unknown): number {
  if (err instanceof OpfsBoundaryError) return err.errno;
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotFoundError":
        return ENOENT;
      case "TypeMismatchError":
        // e.g. getFileHandle on a directory
        return EISDIR;
      case "InvalidModificationError":
        return ENOTEMPTY;
      case "QuotaExceededError":
        return ENOSPC;
      case "NoModificationAllowedError":
        return ENOTSUP;
      case "NotAllowedError":
        return ENOENT; // OPFS: usually means file doesn't exist in this context
      default:
        return EINVAL;
    }
  }
  if (err instanceof TypeError) {
    return EINVAL;
  }
  return EINVAL;
}

// --- Opcode handlers ---

async function handleOpen(): Promise<void> {
  const flags = channel.getArg(0);
  const _mode = channel.getArg(1);
  const pathLen = channel.getArg(2);
  const path = channel.readString(pathLen);

  let identity: OpfsInodeIdentity | null = null;
  let openedAccess = false;
  try {
    if (flags & O_DIRECTORY) {
      // Opening a directory — just verify it exists
      await resolveDir(path);
      const handle = nextFileHandle++;
      // Store a sentinel for directory handles opened via open()
      fileHandles.set(handle, {
        identity: null,
        position: 0,
        appendMode: false,
      });
      channel.result = handle;
      channel.notifyComplete();
      return;
    }

    const { dir, name, normalized } = await resolvePath(path);
    const create = !!(flags & O_CREAT);
    const fileHandle = await dir.getFileHandle(name, { create });
    identity = await identityFor(fileHandle, normalized);
    let syncHandle = identity.accessHandle;
    if (syncHandle === null) {
      syncHandle = await fileHandle.createSyncAccessHandle();
      identity.accessHandle = syncHandle;
      identity.representative = fileHandle;
      openedAccess = true;
    }

    if (flags & O_TRUNC) {
      syncHandle.truncate(0);
    }

    const id = nextFileHandle++;
    let position = 0;
    if (flags & O_APPEND) {
      position = syncHandle.getSize();
    }
    fileHandles.set(id, {
      identity,
      position,
      appendMode: !!(flags & O_APPEND),
    });
    identity.openReferences++;
    channel.result = id;
    channel.notifyComplete();
  } catch (err) {
    if (openedAccess && identity?.openReferences === 0) {
      try {
        identity.accessHandle?.close();
      } catch {
        // Preserve the original open failure.
      }
      identity.accessHandle = null;
    }
    channel.notifyError(mapError(err));
  }
}

async function handleClose(): Promise<void> {
  const handle = channel.getArg(0);
  const entry = fileHandles.get(handle);
  if (!entry) {
    channel.notifyError(EBADF);
    return;
  }
  fileHandles.delete(handle);
  try {
    const identity = entry.identity;
    if (identity !== null) {
      identity.openReferences--;
      if (identity.openReferences === 0) {
        closeIdentityAccess(identity);
        if (identity.publicPath === null) await removeOrphan(identity);
      }
    }
    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleRead(): Promise<void> {
  const handle = channel.getArg(0);
  const length = channel.getArg(1);
  const offsetLo = channel.getArg(2);
  const offsetHi = channel.getArg(3);
  const hasOffset = channel.getArg(4);

  const entry = fileHandles.get(handle);
  const accessHandle = entry && accessHandleFor(entry);
  if (!entry || !accessHandle) {
    channel.notifyError(EBADF);
    return;
  }

  try {
    let readAt: number;
    if (hasOffset) {
      try {
        readAt = joinSafeI64(offsetLo, offsetHi);
      } catch (error) {
        if (error instanceof RangeError) {
          channel.notifyError(EOVERFLOW);
          return;
        }
        throw error;
      }
    } else {
      readAt = entry.position;
    }

    const data = channel.dataBuffer;
    const target = data.subarray(0, length);
    const bytesRead = accessHandle.read(target, { at: readAt });

    if (!hasOffset) {
      entry.position += bytesRead;
    }

    channel.result = bytesRead;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleWrite(): Promise<void> {
  const handle = channel.getArg(0);
  const length = channel.getArg(1);
  const offsetLo = channel.getArg(2);
  const offsetHi = channel.getArg(3);
  const hasOffset = channel.getArg(4);

  const entry = fileHandles.get(handle);
  const accessHandle = entry && accessHandleFor(entry);
  if (!entry || !accessHandle) {
    channel.notifyError(EBADF);
    return;
  }

  try {
    let writeAt: number;
    if (hasOffset) {
      try {
        writeAt = joinSafeI64(offsetLo, offsetHi);
      } catch (error) {
        if (error instanceof RangeError) {
          channel.notifyError(EOVERFLOW);
          return;
        }
        throw error;
      }
    } else if (entry.appendMode) {
      writeAt = accessHandle.getSize();
    } else {
      writeAt = entry.position;
    }

    const data = channel.dataBuffer.slice(0, length);
    const bytesWritten = accessHandle.write(data, { at: writeAt });

    if (!hasOffset) {
      if (entry.appendMode) {
        entry.position = accessHandle.getSize();
      } else {
        entry.position += bytesWritten;
      }
    }

    channel.result = bytesWritten;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleSeek(): Promise<void> {
  const handle = channel.getArg(0);
  const offsetLo = channel.getArg(1);
  const offsetHi = channel.getArg(2);
  const whence = channel.getArg(3);

  const entry = fileHandles.get(handle);
  const accessHandle = entry && accessHandleFor(entry);
  if (!entry || !accessHandle) {
    channel.notifyError(EBADF);
    return;
  }

  try {
    let offset: number;
    try {
      offset = joinSafeI64(offsetLo, offsetHi);
    } catch (error) {
      if (error instanceof RangeError) {
        channel.notifyError(EOVERFLOW);
        return;
      }
      throw error;
    }
    let newPos: number;

    switch (whence) {
      case SEEK_SET:
        newPos = offset;
        break;
      case SEEK_CUR:
        newPos = entry.position + offset;
        break;
      case SEEK_END:
        newPos = accessHandle.getSize() + offset;
        break;
      default:
        channel.notifyError(EINVAL);
        return;
    }

    if (!Number.isSafeInteger(newPos)) {
      channel.notifyError(EOVERFLOW);
      return;
    }
    if (newPos < 0) {
      channel.notifyError(EINVAL);
      return;
    }

    entry.position = newPos;
    channel.i64Result = newPos;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleFstat(): Promise<void> {
  const handle = channel.getArg(0);
  const entry = fileHandles.get(handle);
  if (!entry) {
    channel.notifyError(EBADF);
    return;
  }

  try {
    const identity = entry.identity;
    const accessHandle = identity?.accessHandle ?? null;
    if (identity === null) {
      // Directory opened via open(O_DIRECTORY)
      const now = Date.now();
      channel.writeStatResult({
        dev: OPFS_DEVICE_ID, ino: 0n, mode: S_IFDIR | 0o755, nlink: 1,
        uid: 0, gid: 0, size: 0,
        atimeMs: now, mtimeMs: now, ctimeMs: now,
      });
    } else if (accessHandle !== null) {
      const size = accessHandle.getSize();
      const now = Date.now();
      channel.writeStatResult({
        dev: OPFS_DEVICE_ID,
        ino: identity.ino,
        mode: S_IFREG | 0o644,
        nlink: identity.publicPath === null ? 0 : 1,
        uid: 0, gid: 0, size,
        atimeMs: now, mtimeMs: now, ctimeMs: now,
      });
    } else {
      channel.notifyError(EBADF);
      return;
    }
    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleFtruncate(): Promise<void> {
  const handle = channel.getArg(0);
  const entry = fileHandles.get(handle);
  const accessHandle = entry && accessHandleFor(entry);
  if (!entry || !accessHandle) {
    channel.notifyError(EBADF);
    return;
  }

  try {
    let length: number;
    try {
      length = channel.getI64Arg(1);
    } catch (error) {
      if (error instanceof RangeError) {
        channel.notifyError(EOVERFLOW);
        return;
      }
      throw error;
    }
    accessHandle.truncate(length);
    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleFsync(): Promise<void> {
  const handle = channel.getArg(0);
  const entry = fileHandles.get(handle);
  const accessHandle = entry && accessHandleFor(entry);
  if (!entry || !accessHandle) {
    channel.notifyError(EBADF);
    return;
  }

  try {
    accessHandle.flush();
    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleStat(isLstat: boolean): Promise<void> {
  const pathLen = channel.getArg(0);
  const path = channel.readString(pathLen);

  try {
    const normalized = normalizePublicPath(path);

    if (!normalized) {
      // Root directory
      const now = Date.now();
      channel.writeStatResult({
        dev: OPFS_DEVICE_ID, ino: 0n, mode: S_IFDIR | 0o755, nlink: 1,
        uid: 0, gid: 0, size: 0,
        atimeMs: now, mtimeMs: now, ctimeMs: now,
      });
      channel.result = 0;
      channel.notifyComplete();
      return;
    }

    // Try as directory first, then as file
    const { dir, name } = await resolvePath(path);

    // Try directory
    try {
      await dir.getDirectoryHandle(name);
      const now = Date.now();
      channel.writeStatResult({
        dev: OPFS_DEVICE_ID, ino: 0n, mode: S_IFDIR | 0o755, nlink: 1,
        uid: 0, gid: 0, size: 0,
        atimeMs: now, mtimeMs: now, ctimeMs: now,
      });
      channel.result = 0;
      channel.notifyComplete();
      return;
    } catch {
      // Not a directory, try as file
    }

    // Try file
    const fileHandle = await dir.getFileHandle(name);
    const identity = await identityFor(fileHandle, normalized);
    // A file may already have a live synchronous access handle. OPFS permits
    // only one such handle per file, so stat must use the snapshot API rather
    // than attempting to acquire a second handle just to read the size.
    const file = await fileHandle.getFile();
    const size = file.size;

    const now = Date.now();
    channel.writeStatResult({
      dev: OPFS_DEVICE_ID,
      ino: identity.ino,
      mode: S_IFREG | 0o644,
      nlink: 1,
      uid: 0, gid: 0, size,
      atimeMs: now, mtimeMs: now, ctimeMs: now,
    });
    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleStatfs(): Promise<void> {
  const pathLen = channel.getArg(0);
  const path = channel.readString(pathLen);

  try {
    await ensurePathExists(path);
    const estimate = await navigator.storage?.estimate?.();
    const quota = Math.max(0, Math.floor(estimate?.quota ?? 0));
    const usage = Math.max(0, Math.floor(estimate?.usage ?? 0));
    const totalBytes = Math.max(quota, usage);
    const freeBytes = Math.max(0, totalBytes - usage);
    const blocks = Math.ceil(totalBytes / STATFS_BLOCK_SIZE);
    const freeBlocks = Math.floor(freeBytes / STATFS_BLOCK_SIZE);
    channel.writeStatfsResult({
      type: OPFS_SUPER_MAGIC,
      bsize: STATFS_BLOCK_SIZE,
      blocks,
      bfree: freeBlocks,
      bavail: freeBlocks,
      files: 0,
      ffree: 0,
      fsid: 0,
      namelen: STATFS_NAME_MAX,
      frsize: STATFS_BLOCK_SIZE,
      flags: 0,
    });
    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleMkdir(): Promise<void> {
  const _mode = channel.getArg(0);
  const pathLen = channel.getArg(1);
  const path = channel.readString(pathLen);

  try {
    const { dir, name } = await resolvePath(path);

    // Check if it already exists
    try {
      await dir.getDirectoryHandle(name);
      channel.notifyError(EEXIST);
      return;
    } catch {
      // Good, doesn't exist
    }

    await dir.getDirectoryHandle(name, { create: true });
    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleRmdir(): Promise<void> {
  const pathLen = channel.getArg(0);
  const path = channel.readString(pathLen);

  try {
    const { dir, name } = await resolvePath(path);
    await dir.removeEntry(name);
    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleUnlink(): Promise<void> {
  const pathLen = channel.getArg(0);
  const path = channel.readString(pathLen);

  try {
    const { dir, name, normalized } = await resolvePath(path);
    const fileHandle = await dir.getFileHandle(name);
    const identity = await identityFor(fileHandle, normalized);
    if (identity.openReferences > 0) {
      // Chromium will not remove a file while its synchronous access handle
      // is open. A native move to a private namespace preserves the object
      // for live descriptors while detaching the public pathname.
      await moveIdentityToOrphan(identity);
    } else {
      await dir.removeEntry(name);
      removeIdentity(identity);
    }
    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleRename(): Promise<void> {
  const totalLen = channel.getArg(0);
  const [oldPath, newPath] = channel.readTwoStrings(totalLen);

  try {
    const oldResolved = await resolvePath(oldPath);
    const newResolved = await resolvePath(newPath);
    if (oldResolved.normalized === newResolved.normalized) {
      channel.result = 0;
      channel.notifyComplete();
      return;
    }

    let sourceHandle: FileSystemFileHandle;
    try {
      sourceHandle = await oldResolved.dir.getFileHandle(oldResolved.name);
    } catch (error) {
      if (error instanceof DOMException && error.name === "TypeMismatchError") {
        throw new OpfsBoundaryError(
          ENOTSUP,
          "OPFS directory rename is not supported",
        );
      }
      throw error;
    }

    const sourceIdentity = await identityFor(
      sourceHandle,
      oldResolved.normalized,
    );
    let destinationIdentity: OpfsInodeIdentity | null = null;
    try {
      const destinationHandle = await newResolved.dir.getFileHandle(
        newResolved.name,
      );
      if (await isSameEntry(sourceHandle, destinationHandle)) {
        channel.result = 0;
        channel.notifyComplete();
        return;
      }
      destinationIdentity = await identityFor(
        destinationHandle,
        newResolved.normalized,
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) {
        throw error;
      }
    }

    // Native move cannot replace a destination that has a live synchronous
    // access handle. Preserve that old object for its descriptors first.
    const preservedDestination =
      destinationIdentity !== null && destinationIdentity.openReferences > 0;
    if (preservedDestination && destinationIdentity !== null) {
      await moveIdentityToOrphan(destinationIdentity);
    }

    try {
      await moveIdentityToPublicPath(
        sourceIdentity,
        newResolved.dir,
        newResolved.name,
        newResolved.normalized,
      );
    } catch (error) {
      if (preservedDestination && destinationIdentity !== null) {
        try {
          await moveIdentityToPublicPath(
            destinationIdentity,
            newResolved.dir,
            newResolved.name,
            newResolved.normalized,
          );
        } catch {
          throw new OpfsBoundaryError(
            ENOTSUP,
            "OPFS could not restore the destination after failed rename",
          );
        }
      }
      throw error;
    }

    if (destinationIdentity !== null && !preservedDestination) {
      removeIdentity(destinationIdentity);
    }

    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleAccess(): Promise<void> {
  const amode = channel.getArg(0);
  const pathLen = channel.getArg(1);
  const path = channel.readString(pathLen);

  try {
    const normalized = normalizePublicPath(path);
    if (!normalized) {
      // Root always exists
      channel.result = 0;
      channel.notifyComplete();
      return;
    }

    const { dir, name } = await resolvePath(path);

    // Try directory first, then file
    try {
      await dir.getDirectoryHandle(name);
    } catch {
      await dir.getFileHandle(name);
    }

    channel.result = 0;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleOpendir(): Promise<void> {
  const pathLen = channel.getArg(0);
  const path = channel.readString(pathLen);

  try {
    const normalized = normalizePublicPath(path);
    const dirHandle = await resolveDir(path);

    // Collect all entries
    const entries: { name: string; kind: "file" | "directory" }[] = [];
    for await (const [name, handle] of (dirHandle as any).entries()) {
      if (!normalized && name === OPFS_ORPHAN_DIRECTORY) continue;
      entries.push({ name, kind: handle.kind });
    }

    const id = nextDirHandle++;
    dirHandles.set(id, { entries, index: 0 });
    channel.result = id;
    channel.notifyComplete();
  } catch (err) {
    channel.notifyError(mapError(err));
  }
}

async function handleReaddir(): Promise<void> {
  const handle = channel.getArg(0);
  const iter = dirHandles.get(handle);
  if (!iter) {
    channel.notifyError(EBADF);
    return;
  }

  if (iter.index >= iter.entries.length) {
    // End of directory
    channel.result = 1;
    channel.notifyComplete();
    return;
  }

  const entry = iter.entries[iter.index++];
  const nameBytes = new TextEncoder().encode(entry.name);
  const data = channel.dataBuffer;
  data.set(nameBytes);
  data[nameBytes.length] = entry.kind === "directory" ? DT_DIR : DT_REG;
  channel.result = 0;
  channel.result2 = nameBytes.length;
  channel.notifyComplete();
}

async function handleClosedir(): Promise<void> {
  const handle = channel.getArg(0);
  if (!dirHandles.delete(handle)) {
    channel.notifyError(EBADF);
    return;
  }
  channel.result = 0;
  channel.notifyComplete();
}

// --- Main dispatch ---

async function dispatch(): Promise<void> {
  const op = channel.opcode;
  switch (op) {
    case Opcode.OPEN: return handleOpen();
    case Opcode.CLOSE: return handleClose();
    case Opcode.READ: return handleRead();
    case Opcode.WRITE: return handleWrite();
    case Opcode.SEEK: return handleSeek();
    case Opcode.FSTAT: return handleFstat();
    case Opcode.FTRUNCATE: return handleFtruncate();
    case Opcode.FSYNC: return handleFsync();
    case Opcode.STAT: return handleStat(false);
    case Opcode.LSTAT: return handleStat(true);
    case Opcode.MKDIR: return handleMkdir();
    case Opcode.RMDIR: return handleRmdir();
    case Opcode.UNLINK: return handleUnlink();
    case Opcode.RENAME: return handleRename();
    case Opcode.ACCESS: return handleAccess();
    case Opcode.OPENDIR: return handleOpendir();
    case Opcode.READDIR: return handleReaddir();
    case Opcode.CLOSEDIR: return handleClosedir();
    case Opcode.STATFS: return handleStatfs();
    default:
      channel.notifyError(ENOTSUP);
  }
}

// --- Poll loop ---

async function pollLoop(): Promise<void> {
  while (true) {
    // Wait for status to become Pending
    const result = Atomics.waitAsync(
      channel.i32,
      STATUS_OFFSET_I32,
      Status.Idle,
    );

    if (result.async) {
      await result.value;
    }

    // Check if actually Pending (could be spurious wake)
    const status = Atomics.load(channel.i32, STATUS_OFFSET_I32);
    if (status !== Status.Pending) {
      continue;
    }

    await dispatch();
    // The caller resets Complete/Error to Idle only after consuming the
    // result, so the proxy cannot race the synchronous waiter here.
  }
}

// --- Worker message handler ---

self.onmessage = async (event: MessageEvent) => {
  const { type, buffer } = event.data;
  if (type !== "init") return;

  channel = new WorkerChannel(buffer);
  opfsRoot = await navigator.storage.getDirectory();
  orphanDirectory = await opfsRoot.getDirectoryHandle(OPFS_ORPHAN_DIRECTORY, {
    create: true,
  });
  await removeStaleOrphans();

  // Signal ready
  self.postMessage({ type: "ready" });

  // Enter the poll loop
  pollLoop();
};
