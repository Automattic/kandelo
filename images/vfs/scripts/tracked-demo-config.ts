/**
 * Load a tracked demo-config source and bake it into an image VERBATIM.
 *
 * The tracked file IS the artifact: `/etc/kandelo/demo.json` inside the
 * image is a byte-for-byte copy, never a re-serialization. That is what lets
 * the gallery aggregate machine metadata from tracked sources without any
 * image having been built, and what lets a check assert the baked bytes match
 * the reviewed ones.
 *
 * Generalizes main-shell-demo-config.ts, which established this pattern for
 * the source-rootfs shell image.
 */
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

export interface LoadedTrackedDemoConfig {
  config: KandeloDemoConfig;
  source: Uint8Array;
}

export function loadTrackedDemoConfig(
  relPath: string,
  repoRoot = findRepoRoot(),
): LoadedTrackedDemoConfig {
  const source = new Uint8Array(readFileSync(join(repoRoot, relPath)));
  if (source.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error(
      `${relPath} exceeds ${MAX_KANDELO_DEMO_CONFIG_BYTES} bytes`,
    );
  }
  const config = parseKandeloDemoConfig(
    new TextDecoder("utf-8", { fatal: true }).decode(source),
  );
  if (config === null) {
    throw new Error(`${relPath} has an unsupported version`);
  }
  validateKandeloDemoConfig(config);
  return { config, source };
}

export function writeTrackedDemoConfig(
  fs: MemoryFileSystem,
  relPath: string,
  repoRoot = findRepoRoot(),
): void {
  const { source } = loadTrackedDemoConfig(relPath, repoRoot);
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsBinary(fs, KANDELO_DEMO_CONFIG_PATH, source, 0o644);
}

/**
 * Every tracked demo-config source, one per image that ships machine
 * metadata. The gallery aggregates these without building any image, and the
 * baked-equals-tracked check walks this list.
 */
export const TRACKED_DEMO_CONFIG_SOURCES = [
  "packages/registry/shell/source-rootfs-shell-demo.json",
  "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
  "packages/registry/node/node-demo.json",
  "packages/registry/nginx/nginx-demo.json",
  "packages/registry/nginx/nginx-php-demo.json",
  "packages/registry/wordpress/wordpress-demo.json",
  "packages/registry/wordpress/lamp-demo.json",
  "packages/registry/ruby/ruby-todo-demo.json",
  "packages/registry/python-vfs/python-demo.json",
] as const;
