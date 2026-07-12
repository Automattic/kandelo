import { PATHCONF_NAMES } from "../../../../host/src/generated/abi";
import { OpfsFileSystem } from "../../../../host/src/vfs/opfs";

const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

function errorName(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

self.onmessage = (
  event: MessageEvent<{ buffer: SharedArrayBuffer; path: string }>,
) => {
  const { buffer, path } = event.data;
  const fs = OpfsFileSystem.create(buffer);
  let fd = -1;

  try {
    fd = fs.open(path, O_CREAT | O_TRUNC | O_RDWR, 0o600);
    const result = {
      type: "result",
      // Keep the synchronous access handle open while pathname queries run:
      // Chromium permits FileSystemFileHandle.getFile() here, but rejects a
      // second createSyncAccessHandle() for the same file.
      nameMax: fs.pathconf(path, PATHCONF_NAMES.NAME_MAX),
      pathMax: fs.fpathconf(fd, PATHCONF_NAMES.PATH_MAX),
      asyncIo: fs.fpathconf(fd, PATHCONF_NAMES.ASYNC_IO),
      symlinks: fs.pathconf(path, PATHCONF_NAMES.POSIX2_SYMLINKS),
      timestampResolution: fs.pathconf(
        path,
        PATHCONF_NAMES.TIMESTAMP_RESOLUTION,
      ),
    };

    const closedFd = fd;
    fs.close(closedFd);
    fd = -1;
    const closedHandleError = errorName(() =>
      fs.fpathconf(closedFd, PATHCONF_NAMES.NAME_MAX),
    );
    fs.unlink(path);
    const missingPathError = errorName(() =>
      fs.pathconf(path, PATHCONF_NAMES.NAME_MAX),
    );

    self.postMessage({ ...result, closedHandleError, missingPathError });
  } catch (error) {
    if (fd >= 0) {
      try {
        fs.close(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      fs.unlink(path);
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
