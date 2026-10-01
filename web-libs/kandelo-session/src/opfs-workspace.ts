// OPFS workspaces from the page — write a running machine's directory tree
// into one, and delete one.
//
// The kernel reaches a workspace through its proxy worker while the machine
// runs. Before a machine first boots on a workspace, and after its last boot,
// nobody holds the workspace, and the page reaches the same directory through
// the File System API to seed it or remove it. The page only ever touches a
// workspace no kernel has mounted: the same Web Lock the host takes for a
// boot guards these operations.

import type { VfsTreeEntry } from "./kernel-host";

/** Mirrors OPFS_WORKSPACE_CONTAINER in host/src/vfs/opfs-worker.ts. */
export const OPFS_WORKSPACE_CONTAINER = "kandelo-opfs";

/** Mirrors the lock `BrowserKernel` takes in host/src/browser-kernel-host.ts. */
export function opfsWorkspaceLockName(name: string): string {
  return `kandelo-opfs-workspace:${name}`;
}

export interface WorkspaceWritable {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
}

export interface WorkspaceFile {
  createWritable(): Promise<WorkspaceWritable>;
}

/** The part of `FileSystemDirectoryHandle` these operations use. */
export interface WorkspaceDirectory {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<WorkspaceDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WorkspaceFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface WorkspaceCopyReport {
  files: number;
  directories: number;
  /** Entries a workspace cannot hold: symlinks, devices, pipes, sockets. */
  skipped: Array<{ path: string; kind: Exclude<VfsTreeEntry["kind"], "directory" | "file"> }>;
}

/**
 * Write a tree read from a machine into `workspace`, regular files and
 * directories only. OPFS keeps no owner, mode, or timestamp, and cannot hold
 * a symlink, so what it cannot hold is reported rather than approximated.
 * Entries arrive depth first, so a directory is created before its children.
 */
export async function writeTreeIntoWorkspace(
  entries: readonly VfsTreeEntry[],
  workspace: WorkspaceDirectory,
): Promise<WorkspaceCopyReport> {
  const report: WorkspaceCopyReport = { files: 0, directories: 0, skipped: [] };
  const directories = new Map<string, WorkspaceDirectory>([["", workspace]]);
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf("/");
    const parent = directories.get(slash === -1 ? "" : entry.path.slice(0, slash));
    if (parent === undefined) {
      throw new Error(`tree entry ${entry.path} arrived before its directory`);
    }
    const name = entry.path.slice(slash + 1);
    if (entry.kind === "directory") {
      directories.set(entry.path, await parent.getDirectoryHandle(name, { create: true }));
      report.directories += 1;
      continue;
    }
    if (entry.kind !== "file") {
      report.skipped.push({ path: entry.path, kind: entry.kind });
      continue;
    }
    const file = await parent.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(new Uint8Array(entry.bytes));
    await writable.close();
    report.files += 1;
  }
  return report;
}

/** Delete the workspace `name`; a workspace already gone is not an error. */
export async function deleteWorkspace(
  container: WorkspaceDirectory,
  name: string,
): Promise<void> {
  try {
    await container.removeEntry(name, { recursive: true });
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError") return;
    throw error;
  }
}

/** The origin directory that holds every workspace, created on first use. */
export async function openWorkspaceContainer(): Promise<WorkspaceDirectory> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_WORKSPACE_CONTAINER, { create: true });
}

/**
 * Run `fn` while holding the workspace's boot lock, so no kernel in any tab
 * mounts it meanwhile. Refuses at once when a kernel already holds it.
 */
export async function withWorkspaceHeld<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return navigator.locks.request(
    opfsWorkspaceLockName(name),
    { ifAvailable: true },
    async (lock) => {
      if (lock === null) {
        throw new Error(
          `workspace ${name} is mounted by a running machine, in this tab or another`,
        );
      }
      return fn();
    },
  );
}
