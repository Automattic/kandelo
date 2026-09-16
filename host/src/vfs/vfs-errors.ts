/**
 * VFS error codes and the error type carried with them.
 *
 * # Why this module exists
 *
 * `sharedfs-vendor.ts` is a second implementation of the SFFS format that lane
 * V is deleting, and five files imported it **only** for these constants and
 * `SFSError` — not for any filesystem behaviour. Keeping them there meant the
 * implementation could not be removed until every consumer was rewritten.
 *
 * The values come from `ERRNO` in `../generated/abi`, generated from
 * `shared::Errno`. They used to be hand-written, which is how `exec-target.ts`
 * came to declare its own `EAGAIN`/`EFBIG`/`EIO`/`ENOEXEC` as well.
 *
 * # The sign convention, stated once
 *
 * POSIX and `shared::Errno` number errnos **positively** (`ENOENT` is 2). The
 * VFS returns them **negated** (`-2`), the way a kernel returns `-errno`.
 * The generated table keeps the POSIX sign; the negation happens here, once,
 * visibly — rather than being baked into a second generated table where a
 * reader would have to know which convention they were holding.
 */
import { ERRNO } from "../generated/abi";

export const ENOENT = -ERRNO.ENOENT;
export const EEXIST = -ERRNO.EEXIST;
export const ENOSPC = -ERRNO.ENOSPC;
export const EROFS = -ERRNO.EROFS;
export const EACCES = -ERRNO.EACCES;
export const EINVAL = -ERRNO.EINVAL;
export const EISDIR = -ERRNO.EISDIR;
export const ENOTDIR = -ERRNO.ENOTDIR;
export const ENOTEMPTY = -ERRNO.ENOTEMPTY;
export const EBADF = -ERRNO.EBADF;
export const ENAMETOOLONG = -ERRNO.ENAMETOOLONG;
export const ELOOP = -ERRNO.ELOOP;
export const EXDEV = -ERRNO.EXDEV;
export const EMFILE = -ERRNO.EMFILE;
export const EPERM = -ERRNO.EPERM;
export const EOVERFLOW = -ERRNO.EOVERFLOW;
export const EBUSY = -ERRNO.EBUSY;
export const EFBIG = -ERRNO.EFBIG;
export const EIO = -ERRNO.EIO;
export const ENOSYS = -ERRNO.ENOSYS;
export const ESPIPE = -ERRNO.ESPIPE;
export const ERANGE = -ERRNO.ERANGE;
export const EAGAIN = -ERRNO.EAGAIN;
export const ENOEXEC = -ERRNO.ENOEXEC;
export const EDOM = -ERRNO.EDOM;
export const ENODEV = -ERRNO.ENODEV;
export const ETIMEDOUT = -ERRNO.ETIMEDOUT;

/**
 * An error carrying a negated VFS errno in `code`.
 *
 * Callers compare `error.code === ENOENT` with the constants above, so the
 * negation is symmetric and never appears at a call site.
 */
const ERROR_MESSAGES: Record<number, string> = {
  [ENOENT]: "No such file or directory",
  [EIO]: "I/O error",
  [EBADF]: "Bad file descriptor",
  [EBUSY]: "Device or resource busy",
  [EEXIST]: "File exists",
  [ENOTDIR]: "Not a directory",
  [EISDIR]: "Is a directory",
  [EINVAL]: "Invalid argument",
  [EMFILE]: "Too many open files",
  [EFBIG]: "File too large",
  [ENOSPC]: "No space left on device",
  [EROFS]: "Read-only file system",
  [ENAMETOOLONG]: "File name too long",
  [ENOTEMPTY]: "Directory not empty",
  [ELOOP]: "Too many symbolic links",
  [EOVERFLOW]: "Value too large for data type",
};

export class SFSError extends Error {
  constructor(
    public code: number,
    message?: string,
  ) {
    super(message || ERROR_MESSAGES[code] || `Error ${code}`);
    this.name = "SFSError";
  }
}
