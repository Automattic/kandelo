import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { ensureDirRecursive } from "../../../host/src/vfs/image-helpers";

export const MARIADB_UID = 101;
export const MARIADB_GID = 101;
export const MARIADB_DATA_MODE = 0o775;
export const MARIADB_DATA_DIRS = [
  "/data",
  "/data/mysql",
  "/data/tmp",
  "/data/test",
] as const;

/**
 * Create the writable filesystem state used by mariadbd after --user=mysql
 * drops the process to uid/gid 101. The group-writable 0775 mode keeps the
 * ownership contract explicit without making database state world-writable;
 * /tmp retains ordinary POSIX sticky-directory semantics.
 */
export function prepareMariadbWritableDirectories(fs: MemoryFileSystem): void {
  for (const dir of MARIADB_DATA_DIRS) {
    ensureDirRecursive(fs, dir);
    fs.chown(dir, MARIADB_UID, MARIADB_GID);
    fs.chmod(dir, MARIADB_DATA_MODE);
  }

  ensureDirRecursive(fs, "/tmp");
  fs.chmod("/tmp", 0o1777);
}
