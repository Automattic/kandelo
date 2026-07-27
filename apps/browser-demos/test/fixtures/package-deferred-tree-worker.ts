import { resolveLazyUrl } from "../../../../host/src/vfs/lazy-url";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";

interface InspectPackageTreeRequest {
  image: number[];
  lazyUrlBase: string;
  atomicPaths?: {
    first: string;
    second: string;
  };
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<InspectPackageTreeRequest>) => void) | null;
  postMessage(message: unknown): void;
}

const workerScope = self as unknown as WorkerScope;

function readText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    const read = fs.read(fd, bytes, null, bytes.byteLength);
    if (read !== bytes.byteLength) {
      throw new Error(`short package-tree read: ${read}/${bytes.byteLength}`);
    }
  } finally {
    fs.close(fd);
  }
  return new TextDecoder().decode(bytes);
}

workerScope.onmessage = async (event) => {
  try {
    const fs = MemoryFileSystem.fromImagePreservingCapacity(
      Uint8Array.from(event.data.image),
    );
    fs.rewriteLazyFileUrls((url) =>
      resolveLazyUrl(event.data.lazyUrlBase, url)
    );
    fs.rewriteLazyArchiveUrls((url) =>
      resolveLazyUrl(event.data.lazyUrlBase, url)
    );
    if (event.data.atomicPaths !== undefined) {
      const { first, second } = event.data.atomicPaths;
      let exportBlockedBeforeVerification = false;
      try {
        fs.exportLazyArchiveEntries();
      } catch (error) {
        exportBlockedBeforeVerification =
          error instanceof Error &&
          /not been cryptographically verified after import/.test(error.message);
      }
      if (!exportBlockedBeforeVerification) {
        throw new Error(
          "imported atomic package trees exported before browser verification",
        );
      }
      const deferredBefore = {
        first: fs.isPathDeferred(first),
        second: fs.isPathDeferred(second),
      };
      // WHY: browser SubtleCrypto is the trust boundary for imported cohort
      // seals. Verify directly so metadata inspection does not need to
      // snapshot and serialize the complete filesystem as an incidental step.
      await fs.verifyImportedLazyAtomicGroupSeals();
      const verifiedPendingTrees = fs.exportLazyArchiveEntries().length;
      const prepared = await fs.preparePath(first);
      workerScope.postMessage({
        ok: true,
        result: {
          exportBlockedBeforeVerification,
          deferredBefore,
          verifiedPendingTrees,
          prepared,
          firstText: readText(fs, first),
          secondText: readText(fs, second),
          deferredAfter: {
            first: fs.isPathDeferred(first),
            second: fs.isPathDeferred(second),
          },
          pendingTrees: fs.exportLazyArchiveEntries().length,
        },
      });
      return;
    }
    const snapshot = (path: string) => {
      const stat = fs.lstat(path);
      return {
        mode: stat.mode & 0o7777,
        uid: stat.uid,
        gid: stat.gid,
        size: stat.size,
        deferred: fs.isPathDeferred(path),
      };
    };
    const readPath = "/opt/browser-package-tree/share/runtime.txt";
    const executablePath = "/opt/browser-package-tree/bin/tool";
    const directoryPath = "/opt/browser-package-tree/share";
    const before = {
      data: snapshot(readPath),
      executable: snapshot(executablePath),
      directory: snapshot(directoryPath),
    };
    const handle = fs.opendir(directoryPath);
    const names: string[] = [];
    try {
      for (;;) {
        const entry = fs.readdir(handle);
        if (entry === null) break;
        names.push(entry.name);
      }
    } finally {
      fs.closedir(handle);
    }
    const prepared = await fs.preparePath(readPath);
    workerScope.postMessage({
      ok: true,
      result: {
        before,
        after: {
          data: snapshot(readPath),
          executable: snapshot(executablePath),
          directory: snapshot(directoryPath),
        },
        names: names.sort(),
        prepared,
        text: readText(fs, readPath),
        pendingTrees: fs.exportLazyArchiveEntries().length,
      },
    });
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};
