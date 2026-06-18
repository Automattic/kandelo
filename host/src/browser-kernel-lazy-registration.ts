import type { MemoryFileSystem } from "./vfs/memory-fs";
import type {
  RegisterLazyArchivesMessage,
  RegisterLazyFilesMessage,
} from "./browser-kernel-protocol";

export type LazyVfsRegistrationMessage =
  | Omit<RegisterLazyFilesMessage, "requestId">
  | Omit<RegisterLazyArchivesMessage, "requestId">;

export type LazyVfsRegistrationSender = (
  message: LazyVfsRegistrationMessage,
) => Promise<void>;

/**
 * Forward lazy VFS metadata from a main-thread MemoryFileSystem to the browser
 * kernel worker, waiting for each acknowledgement before init() resolves.
 */
export async function registerLazyVfsMetadata(
  memfs: MemoryFileSystem,
  send: LazyVfsRegistrationSender,
): Promise<void> {
  const lazyEntries = memfs.exportLazyEntries();
  if (lazyEntries.length > 0) {
    await send({
      type: "register_lazy_files",
      entries: lazyEntries,
    });
  }

  const archiveEntries = memfs.exportLazyArchiveEntries();
  if (archiveEntries.length > 0) {
    await send({
      type: "register_lazy_archives",
      entries: archiveEntries,
    });
  }
}
