import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBenchmarkScratchDirectory } from "./scratch.js";

export interface WordPressMeasurementState {
  databaseDirectory: string;
  debugLogPath: string;
  opcacheCacheDirectory: string;
}

/** The copy of WordPress one suite run measures. */
export interface WordPressStage {
  root: string;
  wpDir: string;
  routerScript: string;
  databaseDirectory: string;
  debugLogPath: string;
}

/**
 * Copy the WordPress tree and router into checkout-independent scratch
 * (see scratch.ts for why path depth matters). Symlinks are dereferenced:
 * setup.sh links the SQLite plugin in by absolute path, and db.php
 * realpath()s it, which would lead the guest straight back into the
 * checkout.
 */
export function stageWordPress(
  sourceWpDir: string,
  sourceRouterScript: string,
  scratchParent?: string,
): WordPressStage {
  const root = createBenchmarkScratchDirectory("wordpress", scratchParent);
  const wpDir = join(root, "wordpress");
  copyTreeFollowingLinks(sourceWpDir, wpDir);
  // router.php finds WordPress at dirname(__DIR__)/wordpress, so it keeps
  // its checkout layout: <root>/demo/router.php beside <root>/wordpress.
  const routerScript = join(root, "demo", "router.php");
  mkdirSync(dirname(routerScript));
  copyFileSync(sourceRouterScript, routerScript);
  return {
    root,
    wpDir,
    routerScript,
    databaseDirectory: join(wpDir, "wp-content/database"),
    debugLogPath: join(wpDir, "wp-content/debug.log"),
  };
}

/**
 * Copy a tree, replacing every symlink with what it points at. Not
 * cpSync's `dereference`: that follows only the top-level source, and
 * copies nested links (the SQLite plugin link) as links. The WordPress
 * tree has no link cycles; a cycle here would recurse until the path is
 * too long, failing loudly rather than staging a wrong tree.
 */
function copyTreeFollowingLinks(source: string, destination: string): void {
  if (statSync(source).isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyTreeFollowingLinks(join(source, entry), join(destination, entry));
    }
  } else {
    copyFileSync(source, destination);
  }
}

export function removeWordPressStage(stage: WordPressStage): void {
  rmSync(stage.root, { recursive: true, force: true });
}

/**
 * Give each suite round its own benchmark-owned OPcache root, inside the
 * run's stage. Measurement subdirectories are reset independently so the
 * CLI and HTTP metrics cannot reuse compiled scripts from each other or
 * from another benchmark process.
 */
export function createWordPressOpcacheRunDirectory(stageRoot: string): string {
  mkdirSync(stageRoot, { recursive: true });
  return mkdtempSync(join(stageRoot, ".wordpress-opcache-run-"));
}

/** Restore the WordPress setup state and an empty file cache. */
export function resetWordPressMeasurementState(state: WordPressMeasurementState): void {
  rmSync(state.databaseDirectory, { recursive: true, force: true });
  mkdirSync(state.databaseDirectory, { recursive: true });
  rmSync(state.debugLogPath, { force: true });

  rmSync(state.opcacheCacheDirectory, { recursive: true, force: true });
  mkdirSync(state.opcacheCacheDirectory, { recursive: true });
}

export function removeWordPressOpcacheRunDirectory(runDirectory: string): void {
  rmSync(runDirectory, { recursive: true, force: true });
}

export function buildPhpOpcacheArgs(
  opcacheExtensionPath: string,
  fileCachePath: string,
): string[] {
  return [
    "-d", `extension_dir=${dirname(opcacheExtensionPath)}`,
    "-d", "zend_extension=opcache",
    "-d", "opcache.enable=1",
    "-d", "opcache.enable_cli=1",
    "-d", `opcache.file_cache=${fileCachePath}`,
    "-d", "opcache.file_cache_only=1",
    "-d", "opcache.memory_consumption=128",
    "-d", "opcache.validate_timestamps=0",
  ];
}
