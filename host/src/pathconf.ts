import { PATHCONF_NAMES } from "./generated/abi";
import type { PathconfValue } from "./types";

const { POSIX2_SYMLINKS, TIMESTAMP_RESOLUTION } = PATHCONF_NAMES;

/**
 * The two `pathconf` answers that belong to a JavaScript VFS backend rather
 * than to the kernel: whether this backend can create symbolic links, and the
 * resolution of the timestamps it reports. Neither is derivable from the
 * Kandelo namespace, so neither can be answered in Rust.
 */
export interface PathconfProfile {
  supportsSymlinks: boolean;
  timestampResolutionNs: number | null;
}

function notThisHostsAnswer(name: number): never {
  const error = new Error(
    `ENOSYS: pathconf name ${name} is not a value this host can source`,
  ) as Error & { code: string };
  error.code = "ENOSYS";
  throw error;
}

/**
 * Answer the `pathconf` names a backend genuinely owns, and refuse the rest.
 *
 * Every other name in `wasm_posix_shared::pathconf` is a property of the
 * Kandelo namespace (`_PC_NAME_MAX`, `_PC_PATH_MAX`, `_PC_NO_TRUNC`,
 * `_PC_CHOWN_RESTRICTED`) or of the file type (`_PC_PIPE_BUF`,
 * `_PC_ASYNC_IO`), and `filesystem_pathconf_value` in
 * `crates/runtime-core/src/syscalls.rs` is its single authority. This file used
 * to carry a second copy of that whole table, and the two had already drifted:
 * `_PC_PIPE_BUF` on a FIFO or directory answered -1 here and `EINVAL` in Rust,
 * so which one a guest saw depended only on whether its path happened to route
 * through `host_fpathconf`.
 *
 * `ENOSYS` is how a host says "not mine". The kernel then answers from its own
 * table (`host_pathconf_or_default`). A host that CAN query a real filesystem
 * answers everything instead — `crates/host-native` calls `fpathconf(3)` on the
 * live descriptor, so a host mount over ext4 or APFS reports that filesystem's
 * own limits rather than Kandelo's.
 */
export function backendPathconf(
  name: number,
  profile: PathconfProfile,
): PathconfValue {
  switch (name) {
    case POSIX2_SYMLINKS:
      return profile.supportsSymlinks ? 1 : null;
    case TIMESTAMP_RESOLUTION:
      return profile.timestampResolutionNs;
    default:
      return notThisHostsAnswer(name);
  }
}
