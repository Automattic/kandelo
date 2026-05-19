import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../src/vfs/image-helpers";
import { tryResolveBinary } from "../src/binary-resolver";
import { prewarmOpcache } from "../../examples/browser/scripts/opcache-prewarm";

const opcachePath = tryResolveBinary("programs/php/opcache.so");
const OPCACHE_AVAILABLE = !!opcachePath && existsSync(opcachePath);

describe.skipIf(!OPCACHE_AVAILABLE)("opcache prewarmer", () => {
  it("splits compile groups that contain duplicate declarations", async () => {
    const previousSkip = process.env.KANDELO_NO_OPCACHE_PREWARM;
    delete process.env.KANDELO_NO_OPCACHE_PREWARM;

    try {
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(64 * 1024 * 1024));
      for (const dir of [
        "/tmp",
        "/var/www",
        "/var/cache",
        "/usr/lib/php/extensions",
      ]) {
        ensureDirRecursive(fs, dir);
      }

      writeVfsBinary(
        fs,
        "/usr/lib/php/extensions/opcache.so",
        readFileSync(opcachePath!),
        0o755,
      );
      writeVfsFile(
        fs,
        "/var/www/a.php",
        "<?php function duplicate_for_prewarm_test() { return 1; }\n",
      );
      writeVfsFile(
        fs,
        "/var/www/b.php",
        "<?php function duplicate_for_prewarm_test() { return 2; }\n",
      );

      const written = await prewarmOpcache(fs, {
        sourceRoots: ["/var/www"],
        label: "duplicate-declarations-test",
      });
      expect(written).toBeGreaterThanOrEqual(2);
    } finally {
      if (previousSkip === undefined) {
        delete process.env.KANDELO_NO_OPCACHE_PREWARM;
      } else {
        process.env.KANDELO_NO_OPCACHE_PREWARM = previousSkip;
      }
    }
  }, 60_000);
});
