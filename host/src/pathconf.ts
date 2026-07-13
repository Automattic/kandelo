import { PATHCONF_NAMES } from "./generated/abi";
import type { PathconfValue, StatResult } from "./types";

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
    case PATHCONF_NAMES.LINK_MAX:
      return null; // no backend currently enforces an authoritative maximum
    case PATHCONF_NAMES.NAME_MAX:
      return 255; // enforced in bytes by the common namespace resolver
    case PATHCONF_NAMES.PATH_MAX:
      return 4096; // enforced in bytes by the common namespace resolver
    case PATHCONF_NAMES.CHOWN_RESTRICTED:
      // The kernel enforces chown authorization before every backend call,
      // including backends without persistent ownership metadata.
      return 1;
    case PATHCONF_NAMES.NO_TRUNC:
      return 1; // the common resolver rejects overlong byte components
    case PATHCONF_NAMES.ASYNC_IO:
      // musl implements AIO with guest pthreads over pread/pwrite/fsync.
      return (stat.mode & 0o170000) === 0o100000
        ? 1
        : invalidAssociation(name);
    case PATHCONF_NAMES.SYNC_IO:
    case PATHCONF_NAMES.PRIO_IO:
    case PATHCONF_NAMES.FILESIZEBITS:
    case PATHCONF_NAMES.REC_INCR_XFER_SIZE:
    case PATHCONF_NAMES.REC_MAX_XFER_SIZE:
    case PATHCONF_NAMES.REC_MIN_XFER_SIZE:
    case PATHCONF_NAMES.REC_XFER_ALIGN:
    case PATHCONF_NAMES.ALLOC_SIZE_MIN:
    case PATHCONF_NAMES.SYMLINK_MAX:
    case PATHCONF_NAMES.FALLOC:
      return null;
    case PATHCONF_NAMES.POSIX2_SYMLINKS:
      return profile.supportsSymlinks ? 1 : null;
    case PATHCONF_NAMES.TEXTDOMAIN_MAX:
      return 255;
    case PATHCONF_NAMES.TIMESTAMP_RESOLUTION:
      return profile.timestampResolutionNs;
    case PATHCONF_NAMES.PIPE_BUF: {
      const fileType = stat.mode & 0o170000;
      // Named FIFO support and host atomicity are not uniform yet. Preserve
      // the valid association without fabricating a numeric guarantee. For a
      // directory the value applies to FIFOs created within that directory.
      return fileType === 0o010000 || fileType === 0o040000
        ? null
        : invalidAssociation(name);
    }
    case PATHCONF_NAMES.MAX_CANON:
    case PATHCONF_NAMES.MAX_INPUT:
    case PATHCONF_NAMES.VDISABLE:
    case PATHCONF_NAMES.SOCK_MAXBUF:
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
