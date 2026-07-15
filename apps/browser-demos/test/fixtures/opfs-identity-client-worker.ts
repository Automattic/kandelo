import { OpfsFileSystem } from "../../../../host/src/vfs/opfs";

const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const SEEK_SET = 0;

function errorName(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

self.onmessage = (
  event: MessageEvent<{
    buffer: SharedArrayBuffer;
    oldPath: string;
    newPath: string;
  }>,
) => {
  const { buffer, oldPath, newPath } = event.data;
  const fs = OpfsFileSystem.create(buffer);
  const openFds = new Set<number>();

  const close = (fd: number): void => {
    fs.close(fd);
    openFds.delete(fd);
  };

  try {
    const fd1 = fs.open(oldPath, O_CREAT | O_TRUNC | O_RDWR, 0o600);
    openFds.add(fd1);
    const oldBytes = new TextEncoder().encode("old-object");
    if (fs.write(fd1, oldBytes, null, oldBytes.length) !== oldBytes.length) {
      throw new Error("short OPFS identity fixture write");
    }

    const first = fs.fstat(fd1);
    const beforeRename = fs.stat(oldPath);

    // OPFS sync access handles are exclusive. The proxy must still support
    // independent guest opens by sharing its one identity-owned access handle.
    const fd2 = fs.open(oldPath, O_RDWR, 0o600);
    openFds.add(fd2);
    const second = fs.fstat(fd2);

    fs.rename(oldPath, newPath);
    const afterRenamePath = fs.stat(newPath);
    const oldPathError = errorName(() => fs.stat(oldPath));
    const afterRenameFd = fs.fstat(fd1);

    fs.unlink(newPath);
    const newPathAfterUnlinkError = errorName(() => fs.stat(newPath));
    const unlinkedFirst = fs.fstat(fd1);
    const unlinkedSecond = fs.fstat(fd2);

    fs.seek(fd1, 0, SEEK_SET);
    const readBuffer = new Uint8Array(oldBytes.length);
    const bytesRead = fs.read(fd1, readBuffer, null, readBuffer.length);
    const oldContents = new TextDecoder().decode(readBuffer.subarray(0, bytesRead));

    // Recreating the same pathname must allocate a new file identity while
    // both old descriptors continue to refer to the unlinked object.
    const fd3 = fs.open(newPath, O_CREAT | O_TRUNC | O_RDWR, 0o600);
    openFds.add(fd3);
    const recreated = fs.fstat(fd3);

    close(fd1);
    const secondAfterFirstClose = fs.fstat(fd2);
    close(fd2);
    close(fd3);
    fs.unlink(newPath);

    const sourceFd = fs.open(oldPath, O_CREAT | O_TRUNC | O_RDWR, 0o600);
    openFds.add(sourceFd);
    const sourceBytes = new TextEncoder().encode("replacement-source");
    fs.write(sourceFd, sourceBytes, null, sourceBytes.length);
    const sourceIdentity = fs.fstat(sourceFd);

    const targetFd = fs.open(newPath, O_CREAT | O_TRUNC | O_RDWR, 0o600);
    openFds.add(targetFd);
    const targetBytes = new TextEncoder().encode("open-target");
    fs.write(targetFd, targetBytes, null, targetBytes.length);
    const targetIdentity = fs.fstat(targetFd);

    fs.rename(oldPath, newPath);
    const replacementPath = fs.stat(newPath);
    const replacementSource = fs.fstat(sourceFd);
    const replacementTarget = fs.fstat(targetFd);
    fs.seek(targetFd, 0, SEEK_SET);
    const targetReadBuffer = new Uint8Array(targetBytes.length);
    const targetBytesRead = fs.read(
      targetFd,
      targetReadBuffer,
      null,
      targetReadBuffer.length,
    );
    const targetContents = new TextDecoder().decode(
      targetReadBuffer.subarray(0, targetBytesRead),
    );

    close(sourceFd);
    close(targetFd);
    fs.unlink(newPath);

    self.postMessage({
      type: "result",
      exactBigIntIdentity:
        typeof first.dev === "bigint" && typeof first.ino === "bigint",
      nonzeroInode: first.ino !== 0n,
      statMatchesOpen:
        beforeRename.dev === first.dev && beforeRename.ino === first.ino,
      simultaneousOpenMatches:
        second.dev === first.dev && second.ino === first.ino,
      renamePreservesIdentity:
        afterRenamePath.dev === first.dev &&
        afterRenamePath.ino === first.ino &&
        afterRenameFd.dev === first.dev &&
        afterRenameFd.ino === first.ino,
      oldPathError,
      newPathAfterUnlinkError,
      unlinkPreservesOpenIdentity:
        unlinkedFirst.dev === first.dev &&
        unlinkedFirst.ino === first.ino &&
        unlinkedSecond.dev === first.dev &&
        unlinkedSecond.ino === first.ino &&
        secondAfterFirstClose.dev === first.dev &&
        secondAfterFirstClose.ino === first.ino,
      unlinkedNlink: unlinkedFirst.nlink,
      recreatedIsDistinct:
        recreated.dev === first.dev && recreated.ino !== first.ino,
      oldContents,
      replacementPreservesBothObjects:
        sourceIdentity.ino !== targetIdentity.ino &&
        replacementPath.ino === sourceIdentity.ino &&
        replacementSource.ino === sourceIdentity.ino &&
        replacementTarget.ino === targetIdentity.ino &&
        replacementTarget.nlink === 0,
      targetContents,
      firstIno: first.ino.toString(),
      recreatedIno: recreated.ino.toString(),
    });
  } catch (error) {
    for (const fd of openFds) {
      try {
        fs.close(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    for (const path of [oldPath, newPath]) {
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
