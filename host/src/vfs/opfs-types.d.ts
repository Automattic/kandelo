/**
 * Ambient type declarations for OPFS and Atomics.waitAsync APIs
 * used by the OPFS proxy worker. These types are available in modern
 * browsers but not yet in TypeScript's ES2022/DOM lib.
 */

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface FileSystemHandle {
  isSameEntry(other: FileSystemHandle): Promise<boolean>;
  move(newName: string): Promise<void>;
  move(
    destination: FileSystemDirectoryHandle,
    newName?: string,
  ): Promise<void>;
}

interface AtomicsWaitAsyncResult {
  async: false;
  value: "not-equal" | "timed-out";
}

interface AtomicsWaitAsyncResultAsync {
  async: true;
  value: Promise<"ok" | "timed-out">;
}

interface Atomics {
  waitAsync(
    typedArray: Int32Array,
    index: number,
    value: number,
    timeout?: number,
  ): AtomicsWaitAsyncResult | AtomicsWaitAsyncResultAsync;
}
