import type { HostFileOffset, StatResult } from "../../../host/src/types";

/**
 * The filesystem a VFS image builder recipe is handed.
 *
 * # Why this exists
 *
 * Builder recipes — which packages go in the LAMP image, how WordPress is
 * preinstalled — are product configuration and stay in TypeScript. What should
 * NOT stay is their dependence on a particular implementation of the SFFS
 * format. Eighteen of them took `MemoryFileSystem` purely as a parameter type
 * and never constructed one, so the coupling the budget counts was a type
 * import and nothing more.
 *
 * This is that type, stated as the operations recipes actually perform, so
 * `memory-fs.ts` can be deleted without every recipe being rewritten.
 *
 * # What it deliberately leaves out
 *
 * `saveImage`, `getLazyEntry`, `isPathDeferred`, `registerLazyArchiveFromEntries`
 * and `exportLazyArchiveEntries`. Five recipes use those, and they are not
 * included because including them would make this interface a second name for
 * `MemoryFileSystem` rather than a description of what a recipe needs — the
 * shape of every other measurement in this lane, where the lazy-archive and
 * save paths are the boundary. Those five stay on the concrete type until the
 * bridge grows an equivalent, and the plan records which they are.
 *
 * # What repointing here does NOT mean
 *
 * H-8: low coupling is not migratability. A recipe that takes this type still
 * receives a `MemoryFileSystem` today, because the callers that CONSTRUCT one
 * have not moved. The import count falling is what unblocks deleting the
 * implementation; it is not evidence that these recipes run against the Rust
 * writer.
 */
export interface VfsImageFilesystem {
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number): void;
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
  open(path: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  write(
    handle: number,
    buffer: Uint8Array,
    offset: HostFileOffset | null,
    length: number,
  ): number;
  unlink(path: string): void;
}
