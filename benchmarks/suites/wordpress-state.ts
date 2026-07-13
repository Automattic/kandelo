import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WordPressMeasurementState {
  databaseDirectory: string;
  debugLogPath: string;
  opcacheCacheDirectory: string;
}

/**
 * Give each suite round its own benchmark-owned OPcache root. Measurement
 * subdirectories are reset independently so the CLI and HTTP metrics cannot
 * reuse compiled scripts from each other or from another benchmark process.
 */
export function createWordPressOpcacheRunDirectory(resultsDirectory: string): string {
  mkdirSync(resultsDirectory, { recursive: true });
  return mkdtempSync(join(resultsDirectory, ".wordpress-opcache-run-"));
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
