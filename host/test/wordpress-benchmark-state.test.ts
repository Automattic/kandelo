import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPhpOpcacheArgs,
  createWordPressOpcacheRunDirectory,
  removeWordPressOpcacheRunDirectory,
  resetWordPressMeasurementState,
} from "../../benchmarks/suites/wordpress-state";

describe("WordPress benchmark measurement state", () => {
  it("clears every runtime database entry, the debug log, and the measurement cache", () => {
    const scratch = mkdtempSync(join(tmpdir(), "kandelo-wordpress-benchmark-state-"));
    try {
      const databaseDirectory = join(scratch, "wordpress/wp-content/database");
      const debugLogPath = join(scratch, "wordpress/wp-content/debug.log");
      const resultsDirectory = join(scratch, "benchmarks/results");
      const opcacheRunDirectory = createWordPressOpcacheRunDirectory(resultsDirectory);
      const opcacheCacheDirectory = join(opcacheRunDirectory, "cli");
      const state = { databaseDirectory, debugLogPath, opcacheCacheDirectory };

      resetWordPressMeasurementState(state);
      writeFileSync(join(databaseDirectory, ".htaccess"), "deny from all\n");
      writeFileSync(join(databaseDirectory, "index.php"), "<?php\n");
      writeFileSync(join(databaseDirectory, "wordpress.db"), "database");
      writeFileSync(join(databaseDirectory, "wordpress.db-wal"), "wal");
      writeFileSync(debugLogPath, "runtime warning\n");
      writeFileSync(join(opcacheCacheDirectory, "compiled-script.bin"), "cache");

      resetWordPressMeasurementState(state);

      expect(readdirSync(databaseDirectory)).toEqual([]);
      expect(existsSync(debugLogPath)).toBe(false);
      expect(readdirSync(opcacheCacheDirectory)).toEqual([]);
      expect(relative(resultsDirectory, opcacheRunDirectory)).not.toMatch(/^\.\./);

      removeWordPressOpcacheRunDirectory(opcacheRunDirectory);
      expect(existsSync(opcacheRunDirectory)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("points file-cache-only OPcache at the measurement directory", () => {
    const fileCachePath = "/benchmark-results/wordpress-opcache/http";
    const args = buildPhpOpcacheArgs("/artifacts/php/opcache.so", fileCachePath);

    expect(args).toContain(`opcache.file_cache=${fileCachePath}`);
    expect(args).toContain("opcache.file_cache_only=1");
    expect(args).toContain("opcache.validate_timestamps=0");
    expect(args).not.toContain("opcache.file_cache=/tmp");
  });
});
