import { OpfsFileSystem } from "../../../../host/src/vfs/opfs";
import { OverlayStorageFile } from "../../../../host/src/vfs/overlay-storage";

function ignoreFailure(action: () => void): void {
  try {
    action();
  } catch {
    return;
  }
}

self.onmessage = (
  event: MessageEvent<{ buffer: SharedArrayBuffer; path: string; mode: "write" | "verify" }>,
) => {
  const { buffer, path, mode } = event.data;
  const backend = OpfsFileSystem.create(buffer);
  let storage: OverlayStorageFile | null = null;
  try {
    storage = OverlayStorageFile.open(backend, path);
    if (mode === "write") {
      storage.writeAllAt(0, Uint8Array.of(1, 2, 3, 4));
      storage.writeAllAt(8192, Uint8Array.of(5, 6, 7));
      storage.flush();
      storage.close();
      self.postMessage({ type: "written" });
      return;
    }
    const size = storage.len();
    const header = new Uint8Array(4);
    const tail = new Uint8Array(3);
    storage.readExactAt(0, header);
    storage.readExactAt(8192, tail);
    storage.truncate(4);
    storage.flush();
    storage.close();
    storage = OverlayStorageFile.open(backend, path);
    const truncatedSize = storage.len();
    storage.close();
    backend.unlink(path);
    self.postMessage({ type: "result", size, truncatedSize, header: [...header], tail: [...tail] });
  } catch (error) {
    const opened = storage;
    if (opened !== null) ignoreFailure(() => opened.close());
    ignoreFailure(() => backend.unlink(path));
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    self.close();
  }
};
