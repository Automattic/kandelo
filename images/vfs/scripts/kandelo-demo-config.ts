import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  KANDELO_DEMO_CONFIG_PATH,
  type DemoAssetConfig,
  type DemoPresentationConfig,
  type KandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import {
  ensureDirRecursive,
  writeVfsFile,
} from "./vfs-image-helpers";

export function terminalPresentation(): DemoPresentationConfig {
  return {
    bootPrimary: "syslog",
    runningPrimary: ["terminal", "syslog"],
    terminalAccess: "primary",
    internalsAccess: "drawer",
  };
}

export function webPresentation(): DemoPresentationConfig {
  return {
    bootPrimary: "syslog",
    runningPrimary: ["web", "terminal", "syslog"],
    terminalAccess: "drawer",
    internalsAccess: "drawer",
  };
}

export function framebufferPresentation(autoCommand?: string): DemoPresentationConfig {
  return {
    bootPrimary: "syslog",
    runningPrimary: ["framebuffer", "terminal", "syslog"],
    terminalAccess: "drawer",
    internalsAccess: "drawer",
    ...(autoCommand ? { autoCommand } : {}),
  };
}

export function externalAsset(config: DemoAssetConfig): DemoAssetConfig {
  return config;
}

export function writeKandeloDemoConfig(
  fs: MemoryFileSystem,
  config: KandeloDemoConfig,
): void {
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsFile(
    fs,
    KANDELO_DEMO_CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    0o644,
  );
}
