/**
 * `@kandelo/web` — the browser distribution of the Kandelo POSIX kernel
 * runtime. A downstream browser project (e.g. a web IDE) installs this package
 * instead of vendoring `host/src` or carrying a git submodule.
 *
 * The package ships:
 *   - {@link BrowserKernel}: the main-thread proxy that drives the dedicated
 *     kernel worker (the worker owns the Wasm instance and all process
 *     lifecycle — fork/exec/clone/exit). Boots from a VFS image and runs
 *     binaries already present in the VFS via `spawnFromVfs`.
 *   - A synchronous, host-side VFS reachable from the main thread
 *     (`BrowserKernel.hostFs`) plus the VFS backends needed to build images.
 *   - The kernel/process **worker entries** (code), referenced by default — no
 *     `?worker&url` wiring required in a Vite consumer.
 *   - A **binaries loader** (`fetchKandeloBinaries` / `fetchKandeloPackage`).
 *     The package ships NO Wasm artifacts; the kernel wasm, `rootfs.vfs`, and
 *     program binaries (`php.wasm`, ...) are fetched at runtime from a Kandelo
 *     binaries release — the canonical one matching this build's ABI, a fork's
 *     release, or any URL you host yourself.
 *
 * ## Host-side filesystem: sync vs. async
 *
 * The runtime filesystem lives inside the kernel worker, but it is backed by a
 * `SharedArrayBuffer`. Pass `exposeHostFs: true` and the worker reports that SAB
 * to the main thread at boot, so `BrowserKernel.hostFs` operates on the *same
 * bytes* the running processes see — **synchronously, with no message
 * round-trip**. Kandelo already requires cross-origin isolation (COOP/COEP) for
 * `SharedArrayBuffer` + `Atomics`, so this synchronous path is always available;
 * there is no async-message API to fall back to. This is the one capability a
 * consumer cannot build for itself, and it is intended to be wrapped in the
 * consumer's own ergonomic FS facade.
 *
 * It is opt-in because holding the SAB makes the main thread a co-owner of the
 * VFS, which on WebKit defers reclamation from `Worker.terminate()` to page GC.
 *
 * @packageDocumentation
 */

// ── Kernel + option/boot types ──
export { BrowserKernel } from "../../../host/src/browser-kernel-host";
export type {
  BrowserKernelOptions,
  BrowserKernelBootOptions,
  BrowserKernelAssets,
  HttpRequest,
  HttpResponse,
} from "../../../host/src/browser-kernel-host";

// ── Process / trace types surfaced by BrowserKernel methods ──
export type { ProcessSnapshot, SyscallTraceEvent } from "../../../host/src/kernel-worker";
export type { StatResult, StatfsResult } from "../../../host/src/types";

// ── VFS backends + the host-side filesystem contract ──
//
// `BrowserKernel.hostFs` returns a `MemoryFileSystem`, which implements the
// full `FileSystemBackend` surface (open/read/write/close/seek/fstat/stat/
// lstat/mkdir/rmdir/unlink/rename/readlink/symlink/chmod/chown plus
// opendir/readdir/closedir). The backends and image helpers below let a
// consumer build the VFS image it boots from.
export { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
export { DeviceFileSystem } from "../../../host/src/vfs/device-fs";
export { OpfsFileSystem } from "../../../host/src/vfs/opfs";
export { VirtualPlatformIO } from "../../../host/src/vfs/vfs";
export { loadVfsImage } from "../../../host/src/vfs/load-image";
export {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirRecursive,
  symlink as vfsSymlink,
} from "../../../host/src/vfs/image-helpers";
export {
  DEFAULT_MOUNT_SPEC,
  resolveForBrowser,
} from "../../../host/src/vfs/default-mounts";
export type {
  FileSystemBackend,
  DirEntry,
  MountConfig,
  TimeProvider,
} from "../../../host/src/vfs/types";
export type {
  LazyDownloadEvent,
  LazyDownloadKind,
  LazyDownloadListener,
  LazyDownloadStatus,
  LazyFileEntry,
  VfsImageMetadata,
  VfsImageOptions,
} from "../../../host/src/vfs/memory-fs";

// ── Default asset URLs ──
//
// In the published package this carries only the bundled worker-entry URLs;
// `kernelWasmUrl`/`rootfsVfsUrl` are empty because the package ships no Wasm —
// obtain those from `fetchKandeloBinaries()`. Exposed as an escape hatch for
// custom worker hosting.
export { BROWSER_KERNEL_ASSETS } from "../../../host/src/browser-kernel-assets";

// ── Binaries loader (fetch kernel/rootfs/programs from a release) ──
export {
  fetchKandeloIndex,
  fetchKandeloPackage,
  fetchKandeloBinaries,
} from "./fetch-binaries";
export type {
  KandeloBinarySource,
  KandeloFetchOptions,
  KandeloArch,
  KandeloIndexEntry,
  KandeloReleaseIndex,
  KandeloPackageArtifacts,
  KandeloBinaries,
} from "./fetch-binaries";

// ── Binaries ABI version ──
//
// Downstream projects fetch matching Wasm binaries from the Kandelo release
// tagged `binaries-abi-v<ABI_VERSION>`. These constants let a consumer compute
// the right tag / index URL without hardcoding the number. They derive from
// the generated `ABI_VERSION`, so a kernel ABI bump cannot leave them stale.
import { ABI_VERSION } from "../../../host/src/generated/abi";

/** The kernel ABI version this build of `@kandelo/web` speaks. */
export { ABI_VERSION };

/** Alias of {@link ABI_VERSION}, named for the binaries-fetch use case. */
export const BINARIES_ABI_VERSION: number = ABI_VERSION;

/** The GitHub release tag that holds ABI-matched binaries: `binaries-abi-v<N>`. */
export const BINARIES_RELEASE_TAG = `binaries-abi-v${ABI_VERSION}` as const;

/**
 * URL of the binary index for the ABI this package speaks. Mirrors the
 * `index_url` template in each package's `build.toml`. `repo` defaults to the
 * canonical upstream; override it to point at a fork's releases.
 */
export function binariesIndexUrl(repo = "Automattic/kandelo"): string {
  return `https://github.com/${repo}/releases/download/${BINARIES_RELEASE_TAG}/index.toml`;
}
