/**
 * MariaDB directory setup for the wasm-posix-kernel browser environment.
 *
 * Creates the data directory structure MariaDB needs for bootstrap and
 * server operation.
 */
import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { ensureDir } from "./vfs-utils";

/**
 * Create the MariaDB data directory structure.
 *
 * Directories:
 *   /data         — main data directory (--datadir)
 *   /data/mysql   — system tables
 *   /data/tmp     — temporary files (--tmpdir)
 *   /data/test    — default test database
 */
export function populateMariadbDirs(fs: MemoryFileSystem): void {
  ensureDir(fs, "/data");
  ensureDir(fs, "/data/mysql");
  ensureDir(fs, "/data/tmp");
  ensureDir(fs, "/data/test");
}
