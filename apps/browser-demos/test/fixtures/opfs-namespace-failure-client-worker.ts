import { OpfsFileSystem } from "../../../../host/src/vfs/opfs";

const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const SEEK_SET = 0;

type Scenario = "flush-unlink" | "reopen-replace";

function captureError(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function writeText(
  fs: OpfsFileSystem,
  fd: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (fs.write(fd, bytes, null, bytes.length) !== bytes.length) {
    throw new Error("short OPFS failure-atomicity fixture write");
  }
}

function readText(
  fs: OpfsFileSystem,
  fd: number,
  length: number,
): string {
  fs.seek(fd, 0, SEEK_SET);
  const bytes = new Uint8Array(length);
  const count = fs.read(fd, bytes, null, bytes.length);
  return new TextDecoder().decode(bytes.subarray(0, count));
}

self.onmessage = (
  event: MessageEvent<{
    buffer: SharedArrayBuffer;
    scenario: Scenario;
    sourcePath: string;
    destinationPath: string;
  }>,
) => {
  const { buffer, scenario, sourcePath, destinationPath } = event.data;
  const fs = OpfsFileSystem.create(buffer);
  const openFds = new Set<number>();

  const open = (path: string): number => {
    const fd = fs.open(path, O_CREAT | O_TRUNC | O_RDWR, 0o600);
    openFds.add(fd);
    return fd;
  };
  const close = (fd: number): void => {
    fs.close(fd);
    openFds.delete(fd);
  };

  try {
    const sourceFd = open(sourcePath);
    writeText(fs, sourceFd, "source-object");
    const sourceBefore = fs.fstat(sourceFd);

    let destinationBefore: ReturnType<OpfsFileSystem["stat"]> | null = null;
    if (scenario === "reopen-replace") {
      const destinationFd = open(destinationPath);
      writeText(fs, destinationFd, "destination-object");
      destinationBefore = fs.fstat(destinationFd);
    }

    const operationError = captureError(() => {
      if (scenario === "flush-unlink") fs.unlink(sourcePath);
      else fs.rename(sourcePath, destinationPath);
    });

    const sourceAfter = fs.stat(sourcePath);
    const descriptorAfter = fs.fstat(sourceFd);
    fs.fsync(sourceFd);
    const sourceContents = readText(fs, sourceFd, "source-object".length);
    const destinationPathError = captureError(() => fs.stat(destinationPath));

    let destinationPreserved = destinationBefore === null;
    let destinationContents: string | null = null;
    if (destinationBefore !== null) {
      const destinationAfter = fs.stat(destinationPath);
      const destinationFd = [...openFds].find((fd) => fd !== sourceFd)!;
      fs.fsync(destinationFd);
      destinationContents = readText(
        fs,
        destinationFd,
        "destination-object".length,
      );
      destinationPreserved =
        destinationAfter.ino === destinationBefore.ino &&
        destinationAfter.dev === destinationBefore.dev &&
        fs.fstat(destinationFd).nlink === 1;
    }

    if (scenario === "flush-unlink") fs.unlink(sourcePath);
    else fs.rename(sourcePath, destinationPath);

    const sourcePathAfterRetryError = captureError(() => fs.stat(sourcePath));
    const sourceDescriptorAfterRetry = fs.fstat(sourceFd);
    const sourceContentsAfterRetry = readText(
      fs,
      sourceFd,
      "source-object".length,
    );
    const destinationAfterRetry =
      scenario === "reopen-replace" ? fs.stat(destinationPath) : null;
    const destinationFd = [...openFds].find((fd) => fd !== sourceFd);
    const destinationDescriptorAfterRetry =
      destinationFd === undefined ? null : fs.fstat(destinationFd);
    const destinationContentsAfterRetry =
      destinationFd === undefined
        ? null
        : readText(fs, destinationFd, "destination-object".length);

    for (const fd of [...openFds]) close(fd);
    for (const path of [sourcePath, destinationPath]) {
      try {
        fs.unlink(path);
      } catch {
        // Cleanup is not part of the operation result.
      }
    }

    self.postMessage({
      type: "result",
      operationFailed: operationError !== null,
      sourcePathPreserved:
        sourceAfter.ino === sourceBefore.ino &&
        sourceAfter.dev === sourceBefore.dev,
      sourceDescriptorPreserved:
        descriptorAfter.ino === sourceBefore.ino &&
        descriptorAfter.dev === sourceBefore.dev &&
        descriptorAfter.nlink === 1,
      sourceContents,
      destinationAbsent:
        destinationBefore === null && destinationPathError !== null,
      destinationPreserved,
      destinationContents,
      retryCommitted:
        sourcePathAfterRetryError !== null &&
        sourceDescriptorAfterRetry.ino === sourceBefore.ino &&
        sourceDescriptorAfterRetry.dev === sourceBefore.dev &&
        (scenario === "flush-unlink"
          ? sourceDescriptorAfterRetry.nlink === 0
          : sourceDescriptorAfterRetry.nlink === 1) &&
        sourceContentsAfterRetry === "source-object" &&
        (scenario === "flush-unlink"
          ? destinationAfterRetry === null
          : destinationAfterRetry?.ino === sourceBefore.ino) &&
        (destinationBefore === null
          ? destinationDescriptorAfterRetry === null
          : destinationDescriptorAfterRetry?.ino === destinationBefore.ino &&
            destinationDescriptorAfterRetry.nlink === 0 &&
            destinationContentsAfterRetry === "destination-object"),
    });
  } catch (error) {
    for (const fd of openFds) {
      try {
        fs.close(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    for (const path of [sourcePath, destinationPath]) {
      try {
        fs.unlink(path);
      } catch {
        // Preserve the original failure.
      }
    }
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    self.close();
  }
};
