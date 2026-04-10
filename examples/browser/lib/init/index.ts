/**
 * Browser demo init system — barrel export.
 *
 * Re-exports all public APIs from the init/ modules for convenient
 * single-import usage.
 */

// Service descriptor parser
export {
  parseServiceDescriptor,
  type ServiceDescriptor,
  type ReadyCondition,
} from "./service-descriptor";

// Terminal panel UI component
export { TerminalPanel } from "../terminal-panel";

// VFS write utilities
export {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirs,
  ensureDirRecursive,
  writeInitDescriptor,
} from "./vfs-utils";

// Shell binary population
export {
  populateShellBinaries,
  COREUTILS_NAMES,
  type BinaryDef,
} from "./shell-binaries";

// Service worker bridge
export { initServiceWorkerBridge } from "./service-worker-bridge";

// nginx config
export {
  populateNginxConfig,
  type NginxConfigOptions,
} from "./nginx-config";

// PHP-FPM config
export {
  populatePhpFpmConfig,
  type PhpFpmConfigOptions,
} from "./php-fpm-config";

// MariaDB directory setup
export { populateMariadbDirs } from "./mariadb-config";

// System init orchestrator
export { SystemInit, type SystemInitOptions } from "./system-init";
