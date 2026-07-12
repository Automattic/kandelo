import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  MARIADB_DATA_DIRS,
  MARIADB_DATA_MODE,
  MARIADB_GID,
  MARIADB_UID,
  prepareMariadbWritableDirectories,
} from "../../images/vfs/scripts/mariadb-image-helpers";

describe("MariaDB VFS image ownership", () => {
  it("round-trips writable mysql-owned data directories and sticky /tmp", async () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    prepareMariadbWritableDirectories(fs);

    const restored = MemoryFileSystem.fromImage(await fs.saveImage());

    for (const dir of MARIADB_DATA_DIRS) {
      expect(restored.stat(dir)).toMatchObject({
        uid: MARIADB_UID,
        gid: MARIADB_GID,
      });
      expect(restored.stat(dir).mode & 0o7777).toBe(MARIADB_DATA_MODE);
    }

    expect(restored.stat("/tmp")).toMatchObject({ uid: 0, gid: 0 });
    expect(restored.stat("/tmp").mode & 0o7777).toBe(0o1777);
  });
});
