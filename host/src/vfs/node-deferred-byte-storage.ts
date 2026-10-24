import { closeSync, constants, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DeferredByteStorage } from "./deferred-byte-spool";

export function openNodeDeferredByteStorage(directory: string): DeferredByteStorage {
  if (constants.O_NOFOLLOW === undefined) throw new Error("Deferred byte storage requires no-follow opens");
  const path = join(directory, "rootfs-deferred-bytes");
  let descriptor: number | null = openSync(path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    unlinkSync(path);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  const live = () => {
    if (descriptor === null) throw Object.assign(new Error("Deferred byte storage is closed"), { code: "EBADF" });
    return descriptor;
  };
  return {
    readAt: (offset, destination) => readSync(live(), destination, 0, destination.byteLength, offset),
    writeAt: (offset, source) => writeSync(live(), source, 0, source.byteLength, offset),
    close: () => {
      if (descriptor !== null) {
        const closing = descriptor;
        descriptor = null;
        closeSync(closing);
      }
    },
  };
}
