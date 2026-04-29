/**
 * Browser demo init utilities — barrel export.
 *
 * Helpers shared across demos for VFS image construction and worker-side
 * setup. The legacy SystemInit orchestrator was removed once all demos
 * migrated to dinit-as-PID-1 (see scripts/dinit-image-helpers.ts).
 */

// Terminal panel UI component
export { TerminalPanel } from "../terminal-panel";

// VFS write utilities
export {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirs,
  ensureDirRecursive,
} from "./vfs-utils";

// Shell binary population
export {
  populateShellBinaries,
  COREUTILS_NAMES,
  type BinaryDef,
} from "./shell-binaries";

// Service worker bridge
export { initServiceWorkerBridge } from "./service-worker-bridge";

// MariaDB directory setup
export { populateMariadbDirs } from "./mariadb-config";
