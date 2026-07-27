import * as fs from "node:fs";
import * as path from "node:path";

const LINUX_O_ACCMODE = 0o3;
const LINUX_O_WRONLY = 0o1;
const LINUX_O_RDWR = 0o2;
const LINUX_O_CREAT = 0o100;
const LINUX_O_EXCL = 0o200;
const LINUX_O_APPEND = 0o2000;
const LINUX_O_NOFOLLOW = 0o400000;
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
 * O_TRUNC, O_APPEND, and O_NOFOLLOW stay present in both operations. Ordinary
 * O_CREAT still follows a dangling final symlink by continuing the transaction
 * at its target; caller-requested O_EXCL or O_NOFOLLOW never takes that path.
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

function sameNativeFile(primary: number, candidate: number): boolean {
  const primaryStat = fs.fstatSync(primary, { bigint: true });
  const candidateStat = fs.fstatSync(candidate, { bigint: true });
  return (
    primaryStat.dev === candidateStat.dev
    && primaryStat.ino === candidateStat.ino
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
 * identity verification. If no exact companion can be established, open
 * fails honestly with EOPNOTSUPP instead of deferring a broken transition.
 */
export class NativePositionedWriteHandles {
  private readonly routes = new Map<number, NativeWriteRoutes>();

  register(primary: number, linuxFlags: number, nativePath: string): void {
    const access = nativeWriteAccess(linuxFlags);
    if (access === null) return;

    const primaryStat = fs.fstatSync(primary, { bigint: true });
    if (!primaryStat.isFile()) return;

    const primaryIsAppend = (linuxFlags & LINUX_O_APPEND) !== 0;
    const companionFlags = access
      | (primaryIsAppend ? 0 : fs.constants.O_APPEND);
    const candidates = process.platform === "linux"
      ? [`/proc/self/fd/${primary}`, nativePath]
      : [nativePath];
    let lastFailure: unknown;

    for (const candidatePath of candidates) {
      let companion: number;
      try {
        companion = fs.openSync(candidatePath, companionFlags);
      } catch (error) {
        lastFailure = error;
        continue;
      }

      try {
        if (!sameNativeFile(primary, companion)) {
          throw nativeWriteError(
            "EIO",
            "native write companion does not name the opened file",
          );
        }
      } catch (error) {
        try {
          fs.closeSync(companion);
        } catch {
          // Preserve the identity failure.
        }
        lastFailure = error;
        continue;
      }

      this.routes.set(primary, {
        companion,
        append: primaryIsAppend ? primary : companion,
        positioned: primaryIsAppend ? companion : primary,
      });
      return;
    }

    throw nativeWriteError(
      "EOPNOTSUPP",
      "cannot establish exact append and positioned routes for this file",
      lastFailure,
    );
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

    let closeError: unknown;
    if (route !== undefined) {
      try {
        fs.closeSync(route.companion);
      } catch (error) {
        closeError = error;
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
