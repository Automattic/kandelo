/**
 * Browser UI/lab init utilities - barrel export.
 *
 * Helpers shared across browser surfaces for VFS image construction and worker-side
 * setup. The legacy SystemInit orchestrator was removed once all demos
 * migrated to dinit as the first user process (see dinit-image-helpers.ts).
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

// Shell binary metadata
export { COREUTILS_NAMES } from "./shell-binaries";

// Service worker bridge
export { initServiceWorkerBridge } from "./service-worker-bridge";
