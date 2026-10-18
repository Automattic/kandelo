import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPhpOpcacheArgs,
  createWordPressOpcacheRunDirectory,
  removeWordPressOpcacheRunDirectory,
  removeWordPressStage,
  resetWordPressMeasurementState,
  stageWordPress,
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

  it("stages WordPress at the same paths whichever checkout it comes from", () => {
    // opcache mirrors each script's absolute path, so a checkout one
    // directory deeper used to cost an extra mkdir per cached script.
    const scratch = mkdtempSync(join(tmpdir(), "kandelo-wordpress-benchmark-stage-"));
    try {
      const makeCheckout = (relativeRoot: string) => {
        const root = join(scratch, relativeRoot);
        const wpDir = join(root, "wordpress");
        const plugin = join(root, "sqlite-database-integration");
        mkdirSync(join(wpDir, "wp-content/plugins"), { recursive: true });
        mkdirSync(plugin, { recursive: true });
        writeFileSync(join(wpDir, "wp-settings.php"), "<?php\n");
        writeFileSync(join(plugin, "load.php"), "<?php // plugin\n");
        // setup.sh links the plugin in by absolute path.
        symlinkSync(plugin, join(wpDir, "wp-content/plugins/sqlite-database-integration"));
        const router = join(root, "router.php");
        writeFileSync(router, "<?php // router\n");
        return { wpDir, router };
      };
      const shallow = makeCheckout("a");
      const deep = makeCheckout("a/much/deeper/checkout");
      const stageParent = join(scratch, "stages");
      mkdirSync(stageParent);

      const fromShallow = stageWordPress(shallow.wpDir, shallow.router, stageParent);
      const fromDeep = stageWordPress(deep.wpDir, deep.router, stageParent);
      try {
        for (const stage of [fromShallow, fromDeep]) {
          expect(relative(stageParent, stage.root)).not.toMatch(/^\.\./);
          const stagedPlugin = join(stage.wpDir, "wp-content/plugins/sqlite-database-integration");
          // A real directory: db.php's realpath() must not lead back into
          // the checkout.
          expect(lstatSync(stagedPlugin).isSymbolicLink()).toBe(false);
          expect(readFileSync(join(stagedPlugin, "load.php"), "utf8")).toContain("plugin");
          expect(readFileSync(stage.routerScript, "utf8")).toContain("router");
          // router.php finds WordPress at dirname(__DIR__)/wordpress.
          expect(join(dirname(dirname(stage.routerScript)), "wordpress")).toBe(stage.wpDir);
          expect(stage.databaseDirectory).toBe(join(stage.wpDir, "wp-content/database"));
        }
        expect(fromDeep.wpDir.length).toBe(fromShallow.wpDir.length);
        expect(fromDeep.wpDir.split("/").length).toBe(fromShallow.wpDir.split("/").length);
      } finally {
        removeWordPressStage(fromShallow);
        removeWordPressStage(fromDeep);
      }
      expect(existsSync(fromShallow.root)).toBe(false);
      expect(existsSync(fromDeep.root)).toBe(false);
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
