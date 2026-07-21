import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import { ensureDirRecursive, writeVfsBinary } from "./vfs-image-helpers";

export const MAIN_SHELL_DEMO_CONFIG_SOURCE = "homebrew/main-shell-demo.json";

export interface LoadedMainShellDemoConfig {
  config: KandeloDemoConfig;
  source: Uint8Array;
}

/**
 * Load the one canonical main-shell presentation contract. Both the legacy
 * registry composer and the bottle-only composer consume these exact tracked
 * JSON bytes; this helper prevents the former from carrying a second inline
 * copy of the shell, Doom, and modeset metadata.
 */
export function loadMainShellDemoConfig(
  repoRoot = findRepoRoot(),
): LoadedMainShellDemoConfig {
  const path = join(repoRoot, MAIN_SHELL_DEMO_CONFIG_SOURCE);
  const source = new Uint8Array(readFileSync(path));
  if (source.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error(
      `${MAIN_SHELL_DEMO_CONFIG_SOURCE} exceeds ${MAX_KANDELO_DEMO_CONFIG_BYTES} bytes`,
    );
  }
  const config = parseKandeloDemoConfig(
    new TextDecoder("utf-8", { fatal: true }).decode(source),
  );
  if (config === null) {
    throw new Error(`${MAIN_SHELL_DEMO_CONFIG_SOURCE} has an unsupported version`);
  }
  validateKandeloDemoConfig(config);
  return { config, source };
}

export function writeMainShellDemoConfig(fs: MemoryFileSystem): void {
  const { source } = loadMainShellDemoConfig();
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsBinary(fs, KANDELO_DEMO_CONFIG_PATH, source, 0o644);
}
