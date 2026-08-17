import * as fs from "node:fs";
import * as path from "node:path";
import { OPEN_FLAGS } from "./generated/abi";

const LINUX_O_ACCMODE = OPEN_FLAGS.O_ACCMODE;
const LINUX_O_WRONLY = OPEN_FLAGS.O_WRONLY;
const LINUX_O_RDWR = OPEN_FLAGS.O_RDWR;
const LINUX_O_CREAT = OPEN_FLAGS.O_CREAT;
const LINUX_O_EXCL = OPEN_FLAGS.O_EXCL;
const LINUX_O_APPEND = OPEN_FLAGS.O_APPEND;
const LINUX_O_NOFOLLOW = OPEN_FLAGS.O_NOFOLLOW;
const NATIVE_BACKING_MODE = 0o600;
const MAX_SYMLINK_TRAVERSALS = 40;

interface NativeWriteRoutes {
  companion: number;
  append: number;
  positioned: number;
}

function nativeWriteAccess(flags: number): number | null {
  switch (flags & LINUX_O_ACCMODE) {
    case LINUX_O_WRONLY:
      return fs.constants.O_WRONLY;
    case LINUX_O_RDWR:
      return fs.constants.O_RDWR;
    default:
      return null;
  }
}

function nativeBackingCreationMode(
  linuxFlags: number,
  requestedGuestMode: number,
): number {
  return (linuxFlags & LINUX_O_CREAT) !== 0
    ? NATIVE_BACKING_MODE
    : requestedGuestMode;
}

function prepareCreatedNativeBackingFile(primary: number): void {
  fs.fchmodSync(primary, NATIVE_BACKING_MODE);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code
  );
}

function tooManySymlinksError(nativePath: string): Error & { code: string } {
  const error = new Error(
    `ELOOP: too many symbolic links, open '${nativePath}'`,
  ) as Error & { code: string };
  error.code = "ELOOP";
  return error;
}

function danglingSymlinkTarget(nativePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(nativePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!stat.isSymbolicLink()) return null;

  const target = fs.readlinkSync(nativePath, "utf8");
  return path.isAbsolute(target)
    ? path.normalize(target)
    : path.resolve(path.dirname(nativePath), target);
}

export interface NativeBackingOpenResult {
  fd: number;
  created: boolean;
}

/**
 * Open a native backing file while retaining authoritative create provenance.
 *
 * Node's open API does not say whether a successful O_CREAT made the inode.
 * WHY: probing with existsSync before open is a time-of-check/time-of-use bug:
 * a racing creator's inode could then receive our fchmod and guest metadata.
 * Non-exclusive O_CREAT is therefore split into two unambiguous operations:
 * an atomic O_CREAT|O_EXCL attempt, then an existing-only attempt. ENOENT on
 * the second operation means the name raced away, so the transaction retries.
 *
 * Caller-selected native flags stay present in both operations. Ordinary
 * O_CREAT follows a dangling final symlink by continuing the transaction at
 * its target; caller-requested O_EXCL or O_NOFOLLOW never takes that path.
 * Native backends deliberately omit O_TRUNC here, finish fallible route and
 * metadata setup on the exact returned handle, then truncate that handle.
 */
export function openNativeBackingFile(
  nativePath: string,
  nativeFlags: number,
  linuxFlags: number,
  requestedGuestMode: number,
): NativeBackingOpenResult {
  const creationMode = nativeBackingCreationMode(
    linuxFlags,
    requestedGuestMode,
  );

  if ((linuxFlags & LINUX_O_CREAT) === 0) {
    return {
      fd: fs.openSync(nativePath, nativeFlags, creationMode),
      created: false,
    };
  }

  const finishCreatedOpen = (fd: number): NativeBackingOpenResult => {
    try {
      // WHY: guest permissions live in NativeMetadataOverlay, while the native
      // inode must remain owner-accessible for later opens even when this first
      // descriptor is read-only and the requested guest mode is 0000. fchmod
      // restores owner-only access after a restrictive umask.
      prepareCreatedNativeBackingFile(fd);
      return { fd, created: true };
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the permission-establishment failure.
      }
      throw error;
    }
  };

  if ((linuxFlags & LINUX_O_EXCL) !== 0) {
    return finishCreatedOpen(
      fs.openSync(nativePath, nativeFlags, creationMode),
    );
  }

  const exclusiveCreateFlags =
    nativeFlags | fs.constants.O_CREAT | fs.constants.O_EXCL;
  const existingOnlyFlags =
    nativeFlags & ~fs.constants.O_CREAT & ~fs.constants.O_EXCL;
  let transactionPath = nativePath;
  let symlinkTraversals = 0;

  for (;;) {
    let createdFd: number;
    try {
      createdFd = fs.openSync(
        transactionPath,
        exclusiveCreateFlags,
        creationMode,
      );
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      createdFd = -1;
    }
    if (createdFd >= 0) {
      return finishCreatedOpen(createdFd);
    }

    try {
      return {
        fd: fs.openSync(transactionPath, existingOnlyFlags, creationMode),
        created: false,
      };
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;

      const target = danglingSymlinkTarget(transactionPath);
      if (target === null) continue;
      if ((linuxFlags & LINUX_O_NOFOLLOW) !== 0) throw error;
      if (++symlinkTraversals > MAX_SYMLINK_TRAVERSALS) {
        throw tooManySymlinksError(nativePath);
      }
      transactionPath = target;
    }
  }
}

function nativeWriteError(
  code: "EIO" | "EOPNOTSUPP",
  message: string,
  cause?: unknown,
): Error & { code: string; cause?: unknown } {
  const error = new Error(`${code}: ${message}`) as Error & {
    code: string;
    cause?: unknown;
  };
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function nativeErrorCode(error: unknown): string | null {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z][A-Z0-9_]*$/.test(error.code)
  ) {
    return error.code;
  }
  return null;
}

function nativeCompanionError(
  error: unknown,
  purpose: string,
): Error & { code: string } {
  const code = nativeErrorCode(error) ?? "EIO";
  const wrapped = new Error(
    `${code}: cannot establish exact native ${purpose} companion`,
  ) as Error & { code: string };
  wrapped.code = code;
  return wrapped;
}

const NATIVE_COMPANION_FALLBACK_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "ENODEV",
  "ENOSYS",
  "EOPNOTSUPP",
  "ENOTSUP",
]);

function nativeCompanionStrategyUnavailable(error: unknown): boolean {
  const code = nativeErrorCode(error);
  return code !== null && NATIVE_COMPANION_FALLBACK_CODES.has(code);
}

function sameNativeFile(primary: number, candidate: number): boolean {
  const primaryStat = fs.fstatSync(primary, { bigint: true });
  const candidateStat = fs.fstatSync(candidate, { bigint: true });
  return (
    primaryStat.dev === candidateStat.dev
    && primaryStat.ino === candidateStat.ino
  );
}

function openExactNativeCompanion(
  primary: number,
  nativePath: string,
  nativeFlags: number,
  purpose: string,
): number {
  const candidates = process.platform === "linux"
    ? [
        { path: `/proc/self/fd/${primary}`, mayFallback: true },
        { path: nativePath, mayFallback: false },
      ]
    : [{ path: nativePath, mayFallback: false }];

  for (const candidate of candidates) {
    let companion: number;
    try {
      companion = fs.openSync(candidate.path, nativeFlags);
    } catch (error) {
      if (candidate.mayFallback && nativeCompanionStrategyUnavailable(error)) {
        continue;
      }
      throw nativeCompanionError(error, purpose);
    }

    try {
      if (!sameNativeFile(primary, companion)) {
        throw nativeWriteError(
          "EIO",
          `native ${purpose} companion does not name the opened file`,
        );
      }
      return companion;
    } catch (error) {
      try {
        fs.closeSync(companion);
      } catch {
        // Preserve the identity failure.
      }
      throw nativeCompanionError(error, purpose);
    }
  }

  throw nativeWriteError(
    "EOPNOTSUPP",
    `no native ${purpose} companion strategy is available`,
  );
}

/**
 * Own both native routes required by one writable regular-file handle.
 *
 * Rust, not the backend descriptor, owns the live O_APPEND bit. Every open
 * therefore establishes an O_APPEND route and a non-append positioned route
 * before returning. Later F_SETFL operations only select a route; they never
 * mutate a persistent native flag, and both routes survive rename/unlink.
 *
 * Linux `/proc/self/fd` acquires the companion from the live inode. Other
 * hosts reopen the pathname immediately and accept it only after dev+ino
 * identity verification. A missing live-fd strategy may fall back to the
 * path; authoritative permission, filesystem, and resource errors retain
 * their native errno instead of being mislabeled as unsupported.
 */
export class NativePositionedWriteHandles {
  private readonly routes = new Map<number, NativeWriteRoutes>();
  private readonly readOnlyTruncates = new Map<number, number>();

  register(primary: number, linuxFlags: number, nativePath: string): void {
    const access = nativeWriteAccess(linuxFlags);
    if (access === null) return;

    const primaryStat = fs.fstatSync(primary, { bigint: true });
    if (!primaryStat.isFile()) return;

    const primaryIsAppend = (linuxFlags & LINUX_O_APPEND) !== 0;
    const companionFlags = access
      | (primaryIsAppend ? 0 : fs.constants.O_APPEND);
    const companion = openExactNativeCompanion(
      primary,
      nativePath,
      companionFlags,
      "write-route",
    );
    this.routes.set(primary, {
      companion,
      append: primaryIsAppend ? primary : companion,
      positioned: primaryIsAppend ? companion : primary,
    });
  }

  /**
   * Return an exact writable handle for deferred O_TRUNC.
   *
   * WHY: Linux accepts O_RDONLY | O_TRUNC, but the read-only descriptor cannot
   * be passed to ftruncate after native O_TRUNC is deferred. Keep the primary
   * descriptor read-only and retain a verified companion until close, so all
   * fallible route setup precedes mutation and no pathname race can select a
   * different inode for truncation.
   */
  forTruncate(primary: number, linuxFlags: number, nativePath: string): number {
    if (nativeWriteAccess(linuxFlags) !== null) return primary;

    const existing = this.readOnlyTruncates.get(primary);
    if (existing !== undefined) return existing;
    if (!fs.fstatSync(primary, { bigint: true }).isFile()) return primary;

    const companion = openExactNativeCompanion(
      primary,
      nativePath,
      fs.constants.O_WRONLY,
      "read-only truncate",
    );
    this.readOnlyTruncates.set(primary, companion);
    return companion;
  }

  forWrite(primary: number, positioned: boolean): number {
    if (!positioned) return primary;
    const route = this.routes.get(primary);
    if (route !== undefined) return route.positioned;

    // Non-regular descriptors retain their native positioned-write behavior.
    // A writable regular descriptor, however, must have established both
    // routes during open. Falling back to a possibly O_APPEND primary would
    // silently turn pwrite into append.
    if (fs.fstatSync(primary, { bigint: true }).isFile()) {
      throw nativeWriteError(
        "EOPNOTSUPP",
        "positioned write route is unavailable for this regular file",
      );
    }
    return primary;
  }

  forAppend(primary: number): number {
    const route = this.routes.get(primary);
    if (route === undefined) {
      throw nativeWriteError(
        "EOPNOTSUPP",
        "atomic append route is unavailable for this handle",
      );
    }
    return route.append;
  }

  close(primary: number): void {
    const route = this.routes.get(primary);
    this.routes.delete(primary);
    const truncateCompanion = this.readOnlyTruncates.get(primary);
    this.readOnlyTruncates.delete(primary);

    let closeError: unknown;
    if (route !== undefined) {
      try {
        fs.closeSync(route.companion);
      } catch (error) {
        closeError = error;
      }
    }
    if (truncateCompanion !== undefined) {
      try {
        fs.closeSync(truncateCompanion);
      } catch (error) {
        closeError ??= error;
      }
    }
    try {
      fs.closeSync(primary);
    } catch (error) {
      closeError ??= error;
    }
    if (closeError !== undefined) throw closeError;
  }
}
