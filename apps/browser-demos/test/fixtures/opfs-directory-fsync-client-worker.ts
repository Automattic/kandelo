import { OpfsFileSystem } from "../../../../host/src/vfs/opfs";

const O_RDONLY = 0;
const O_DIRECTORY = 0x010000;

self.onmessage = (
  event: MessageEvent<{ buffer: SharedArrayBuffer; path: string }>,
) => {
  const { buffer, path } = event.data;
  const fs = OpfsFileSystem.create(buffer);
  let fd = -1;

  try {
    fs.mkdir(path, 0o700);
    fd = fs.open(path, O_RDONLY | O_DIRECTORY, 0);
    fs.fsync(fd);
    fs.close(fd);
    fd = -1;
    fs.rmdir(path);
    self.postMessage({ type: "result" });
  } catch (error) {
    if (fd >= 0) {
      try {
        fs.close(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      fs.rmdir(path);
    } catch {
      // Preserve the original failure.
    }
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    self.close();
  }
};
