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
    const marker = new TextEncoder().encode("!");
    const append = fs.append(fd, marker, marker.length, null);
    if (append.written !== marker.length || append.end !== 7) {
      throw new Error("short OPFS fixture append");
    }
    const limited = fs.append(
      fd,
      new TextEncoder().encode("blocked"),
      7,
      append.end,
    );
    if (limited.written !== 0 || limited.end !== append.end) {
      throw new Error("OPFS append limit was not atomic with EOF");
    }
    const replacement = new TextEncoder().encode("X");
    if (fs.write(fd, replacement, 1, replacement.length) !== replacement.length) {
      throw new Error("short OPFS positioned fixture write");
    }
    const observed = new Uint8Array(7);
    if (fs.read(fd, observed, 0, observed.length) !== observed.length) {
      throw new Error("short OPFS positioned fixture read");
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
      content: new TextDecoder().decode(observed),
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
