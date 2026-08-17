import {
  FILE_MODES,
  PATHCONF_NAMES,
  POSIX_PATH_MAX_BYTES,
} from "./generated/abi";
import type { PathconfValue, StatResult } from "./types";

const {
  ALLOC_SIZE_MIN,
  ASYNC_IO,
  CHOWN_RESTRICTED,
  FALLOC,
  FILESIZEBITS,
  LINK_MAX,
  MAX_CANON,
  MAX_INPUT,
  NAME_MAX,
  NO_TRUNC,
  PATH_MAX,
  PIPE_BUF,
  POSIX2_SYMLINKS,
  PRIO_IO,
  REC_INCR_XFER_SIZE,
  REC_MAX_XFER_SIZE,
  REC_MIN_XFER_SIZE,
  REC_XFER_ALIGN,
  SOCK_MAXBUF,
  SYMLINK_MAX,
  SYNC_IO,
  TEXTDOMAIN_MAX,
  TIMESTAMP_RESOLUTION,
  VDISABLE,
} = PATHCONF_NAMES;
const { S_IFDIR, S_IFIFO, S_IFMT, S_IFREG } = FILE_MODES;

export interface PathconfProfile {
  supportsSymlinks: boolean;
  timestampResolutionNs: number | null;
}

function invalidAssociation(name: number): never {
  const error = new Error(
    `EINVAL: pathconf name ${name} is not associated with this object`,
  ) as Error & { code: string };
  error.code = "EINVAL";
  throw error;
}

/**
 * Answer filesystem-backed pathconf names after the owning backend has
 * validated the path or live handle. Kernel-owned pipes, sockets, and PTYs
 * are handled in Rust instead.
 */
export function filesystemPathconf(
  stat: StatResult,
  name: number,
  profile: PathconfProfile,
): PathconfValue {
  switch (name) {
    case LINK_MAX:
      return null; // no backend currently enforces an authoritative maximum
    case NAME_MAX:
      return 255; // enforced in bytes by the common namespace resolver
    case PATH_MAX:
      return POSIX_PATH_MAX_BYTES; // enforced by the common namespace resolver
    case CHOWN_RESTRICTED:
      // The kernel enforces chown authorization before every backend call,
      // including backends without persistent ownership metadata.
      return 1;
    case NO_TRUNC:
      return 1; // the common resolver rejects overlong byte components
    case ASYNC_IO:
      // musl implements AIO with guest pthreads over pread/pwrite/fsync.
      return (stat.mode & S_IFMT) === S_IFREG
        ? 1
        : invalidAssociation(name);
    case SYNC_IO:
    case PRIO_IO:
    case FILESIZEBITS:
    case REC_INCR_XFER_SIZE:
    case REC_MAX_XFER_SIZE:
    case REC_MIN_XFER_SIZE:
    case REC_XFER_ALIGN:
    case ALLOC_SIZE_MIN:
    case SYMLINK_MAX:
    case FALLOC:
      return null;
    case POSIX2_SYMLINKS:
      return profile.supportsSymlinks ? 1 : null;
    case TEXTDOMAIN_MAX:
      return 255;
    case TIMESTAMP_RESOLUTION:
      return profile.timestampResolutionNs;
    case PIPE_BUF: {
      const fileType = stat.mode & S_IFMT;
      // Named FIFO support and host atomicity are not uniform yet. Preserve
      // the valid association without fabricating a numeric guarantee. For a
      // directory the value applies to FIFOs created within that directory.
      if (fileType === S_IFIFO || fileType === S_IFDIR) return null;
      return invalidAssociation(name);
    }
    case MAX_CANON:
    case MAX_INPUT:
    case VDISABLE:
    case SOCK_MAXBUF:
      return invalidAssociation(name);
    default: {
      const error = new Error(`EINVAL: invalid pathconf name ${name}`) as Error & {
        code: string;
      };
      error.code = "EINVAL";
      throw error;
    }
  }
}
