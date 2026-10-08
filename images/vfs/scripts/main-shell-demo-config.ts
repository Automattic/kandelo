import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import {
  loadTrackedDemoConfig,
  writeTrackedDemoConfig,
  type LoadedTrackedDemoConfig,
} from "./tracked-demo-config";

export const MAIN_SHELL_DEMO_CONFIG_SOURCE =
  "packages/registry/shell/source-rootfs-shell-demo.json";

/**
 * Load the canonical lean main-shell presentation contract. Both the legacy
 * registry composer and the bottle-only composer consume these exact tracked
 * JSON bytes, while images that own optional programs must compose their own
 * explicitly reviewed profile layer.
 */
export function loadMainShellDemoConfig(
  repoRoot = findRepoRoot(),
): LoadedTrackedDemoConfig {
  return loadTrackedDemoConfig(MAIN_SHELL_DEMO_CONFIG_SOURCE, repoRoot);
}

export function writeMainShellDemoConfig(fs: VfsImageFilesystem): void {
  writeTrackedDemoConfig(fs, MAIN_SHELL_DEMO_CONFIG_SOURCE);
}
