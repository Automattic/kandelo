import { OpfsFileSystem } from "../../../../host/src/vfs/opfs";

const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const SEEK_SET = 0;
const SEEK_CUR = 1;

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
    const data = new TextEncoder().encode("abcdef");
    if (fs.write(fd, data, null, data.length) !== data.length) {
      throw new Error("short OPFS fixture write");
    }

    fs.seek(fd, 2, SEEK_SET);
    const negativeError = errorName(() => fs.seek(fd, -3, SEEK_CUR));
    const afterNegative = fs.seek(fd, 0, SEEK_CUR);

    const wideOffset = 2 ** 32 + 1;
    const wideResult = fs.seek(fd, wideOffset, SEEK_SET);

    fs.seek(fd, Number.MAX_SAFE_INTEGER, SEEK_SET);
    const overflowError = errorName(() => fs.seek(fd, 1, SEEK_CUR));
    const afterOverflow = fs.seek(fd, 0, SEEK_CUR);

    fs.close(fd);
    fd = -1;
    fs.unlink(path);
    self.postMessage({
      type: "result",
      negativeError,
      afterNegative,
      wideResult,
      overflowError,
      afterOverflow,
    });
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
