import { hostFilePositionToSafeNumber } from "../file-offset";
import { OPEN_FLAGS } from "../generated/abi";
import type { HostFileOffset } from "../types";
import type { FileSystemBackend } from "./types";

type OverlayStorageBackend = Pick<
  FileSystemBackend,
  "open" | "close" | "read" | "write" | "fstat" | "ftruncate" | "fsync"
>;

export interface PersistentOverlayStorage {
  len(): number;
  readExactAt(offset: HostFileOffset, destination: Uint8Array): void;
  writeAllAt(offset: HostFileOffset, source: Uint8Array): void;
  flush(): void;
  truncate(length: HostFileOffset): void;
  close(): void;
}

const MAX_IO_BYTES = 1024 * 1024;

function storageError(code: "EBADF" | "EIO" | "ENOSPC" | "EOVERFLOW"): Error & { code: string } {
  const error = new Error(`${code}: persistent overlay storage`) as Error & { code: string };
  error.code = code;
  return error;
}

function opfsStorageError(error: unknown): unknown {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return storageError("ENOSPC");
  }
  return error;
}

function checkedPosition(offset: HostFileOffset, length: number): number {
  const position = hostFilePositionToSafeNumber(offset);
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position + length)) {
    throw storageError("EOVERFLOW");
  }
  return position;
}

export class OverlayStorageFile implements PersistentOverlayStorage {
  private handle: number | null;

  private constructor(
    private readonly backend: OverlayStorageBackend,
    handle: number,
  ) {
    this.handle = handle;
  }

  static open(backend: OverlayStorageBackend, path: string): OverlayStorageFile {
    const handle = backend.open(
      path,
      OPEN_FLAGS.O_RDWR | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_NOFOLLOW,
      0o600,
    );
    return new OverlayStorageFile(backend, handle);
  }

  private liveHandle(): number {
    if (this.handle === null) throw storageError("EBADF");
    return this.handle;
  }

  len(): number {
    const size = this.backend.fstat(this.liveHandle()).size;
    if (!Number.isSafeInteger(size) || size < 0) throw storageError("EOVERFLOW");
    return size;
  }

  readExactAt(offset: HostFileOffset, destination: Uint8Array): void {
    const start = checkedPosition(offset, destination.byteLength);
    const handle = this.liveHandle();
    let done = 0;
    while (done < destination.byteLength) {
      const chunk = destination.subarray(done, done + MAX_IO_BYTES);
      const read = this.backend.read(handle, chunk, start + done, chunk.byteLength);
      if (!Number.isInteger(read) || read <= 0 || read > chunk.byteLength) {
        throw storageError("EIO");
      }
      done += read;
    }
  }

  writeAllAt(offset: HostFileOffset, source: Uint8Array): void {
    const start = checkedPosition(offset, source.byteLength);
    const handle = this.liveHandle();
    let done = 0;
    while (done < source.byteLength) {
      const chunk = source.subarray(done, done + MAX_IO_BYTES);
      const written = this.backend.write(handle, chunk, start + done, chunk.byteLength);
      if (!Number.isInteger(written) || written <= 0 || written > chunk.byteLength) {
        throw storageError("EIO");
      }
      done += written;
    }
  }

  flush(): void {
    this.backend.fsync(this.liveHandle());
  }

  truncate(length: HostFileOffset): void {
    this.backend.ftruncate(this.liveHandle(), checkedPosition(length, 0));
  }

  close(): void {
    const handle = this.liveHandle();
    this.backend.close(handle);
    this.handle = null;
  }
}

export class OpfsOverlayStorageFile implements PersistentOverlayStorage {
  private constructor(private handle: FileSystemSyncAccessHandle | null) {}

  static async open(name: string): Promise<OpfsOverlayStorageFile> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw storageError("EIO");
    let stage = "root";
    try {
      const root = await navigator.storage.getDirectory();
      stage = "directory";
      const directory = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
      stage = "file";
      const file = await directory.getFileHandle(`${name}.journal`, { create: true });
      stage = "access handle";
      return new OpfsOverlayStorageFile(await file.createSyncAccessHandle());
    } catch (error) {
      throw new Error(`persistent overlay OPFS ${stage}: ${error}`);
    }
  }

  private liveHandle(): FileSystemSyncAccessHandle {
    if (this.handle === null) throw storageError("EBADF");
    return this.handle;
  }

  len(): number {
    const length = this.liveHandle().getSize();
    if (!Number.isSafeInteger(length) || length < 0) throw storageError("EOVERFLOW");
    return length;
  }

  readExactAt(offset: HostFileOffset, destination: Uint8Array): void {
    const start = checkedPosition(offset, destination.byteLength);
    const handle = this.liveHandle();
    let done = 0;
    while (done < destination.byteLength) {
      const chunk = destination.subarray(done, done + MAX_IO_BYTES);
      const read = handle.read(chunk, { at: start + done });
      if (!Number.isInteger(read) || read <= 0 || read > chunk.byteLength) throw storageError("EIO");
      done += read;
    }
  }

  writeAllAt(offset: HostFileOffset, source: Uint8Array): void {
    const start = checkedPosition(offset, source.byteLength);
    const handle = this.liveHandle();
    let done = 0;
    while (done < source.byteLength) {
      const chunk = source.subarray(done, done + MAX_IO_BYTES);
      let written: number;
      try {
        written = handle.write(chunk, { at: start + done });
      } catch (error) {
        throw opfsStorageError(error);
      }
      if (!Number.isInteger(written) || written <= 0 || written > chunk.byteLength) throw storageError("EIO");
      done += written;
    }
  }

  flush(): void {
    try {
      this.liveHandle().flush();
    } catch (error) {
      throw opfsStorageError(error);
    }
  }
  truncate(length: HostFileOffset): void {
    try {
      this.liveHandle().truncate(checkedPosition(length, 0));
    } catch (error) {
      throw opfsStorageError(error);
    }
  }
  close(): void {
    const handle = this.liveHandle();
    handle.close();
    this.handle = null;
  }
}
