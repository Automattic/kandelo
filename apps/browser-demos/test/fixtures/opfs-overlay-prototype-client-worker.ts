import { OpfsFileSystem } from "../../../../host/src/vfs/opfs";
import { OverlayStorageFile } from "../../../../host/src/vfs/overlay-storage";

type PrototypeExports = {
  prototype_scratch(length: number): number;
  prototype_open(): number;
  prototype_size(inode: bigint, baseSize: bigint): bigint;
  prototype_lookup(parent: bigint, nameLength: number): bigint;
  prototype_create(parent: bigint, inode: bigint, nameLength: number): number;
  prototype_read(inode: bigint, baseSize: bigint, offset: bigint, length: number): number;
  prototype_write(inode: bigint, baseSize: bigint, offset: bigint, length: number): number;
};

const base = Uint8Array.from({ length: 8192 }, (_, index) => index % 251);
const sparseOffset = 8n * 1024n * 1024n * 1024n;

function assertResult(result: number, expected: number): void {
  if (result !== expected) throw new Error(`expected ${expected}, got ${result}`);
}

function ignoreFailure(action: () => void): void {
  try {
    action();
  } catch {
    return;
  }
}

async function openPrototype(
  wasm: ArrayBuffer,
  storage: OverlayStorageFile,
  digest: Uint8Array,
): Promise<{ exports: PrototypeExports; memory: WebAssembly.Memory }> {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
  const memorySlice = (pointer: number, length: number) =>
    new Uint8Array(memory.buffer, pointer, length);
  const noError = (action: () => void): number => {
    try {
      action();
      return 0;
    } catch {
      return -5;
    }
  };
  const imports = {
    env: {
      memory,
      overlay_len: () => {
        try {
          return BigInt(storage.len());
        } catch {
          return -5n;
        }
      },
      overlay_read: (offset: bigint, pointer: number, length: number) =>
        noError(() => storage.readExactAt(offset, memorySlice(pointer, length))),
      overlay_write: (offset: bigint, pointer: number, length: number) =>
        noError(() => storage.writeAllAt(offset, memorySlice(pointer, length))),
      overlay_flush: () => noError(() => storage.flush()),
      overlay_truncate: (length: bigint) => noError(() => storage.truncate(length)),
      base_read: (offset: bigint, pointer: number, length: number) => {
        const start = Number(offset);
        if (!Number.isSafeInteger(start) || start < 0) return -5;
        const count = Math.min(length, Math.max(0, base.length - start));
        memorySlice(pointer, count).set(base.subarray(start, start + count));
        return count;
      },
    },
  };
  const module = new WebAssembly.Module(wasm);
  const instantiated = await WebAssembly.instantiate(module, imports);
  const exports = instantiated.exports as unknown as PrototypeExports;
  const pointer = exports.prototype_scratch(32);
  if (pointer === 0) throw new Error("scratch allocation failed");
  memorySlice(pointer, 32).set(digest);
  assertResult(exports.prototype_open(), 0);
  return { exports, memory };
}

function scratchBytes(
  exports: PrototypeExports,
  memory: WebAssembly.Memory,
  bytes: Uint8Array,
): void {
  const pointer = exports.prototype_scratch(bytes.length);
  if (pointer === 0) throw new Error("scratch allocation failed");
  new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
}

function readBytes(
  exports: PrototypeExports,
  memory: WebAssembly.Memory,
  inode: bigint,
  baseSize: bigint,
  offset: bigint,
  length: number,
): number[] {
  const pointer = exports.prototype_scratch(length);
  if (pointer === 0) throw new Error("scratch allocation failed");
  assertResult(exports.prototype_read(inode, baseSize, offset, length), length);
  return [...new Uint8Array(memory.buffer, pointer, length)];
}

self.onmessage = async (event: MessageEvent<{
  buffer: SharedArrayBuffer;
  path: string;
  wasmUrl: string;
  mode: "write" | "verify";
}>) => {
  const { buffer, path, wasmUrl, mode } = event.data;
  const backend = OpfsFileSystem.create(buffer);
  let storage: OverlayStorageFile | null = null;
  try {
    storage = OverlayStorageFile.open(backend, path);
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`Wasm fetch failed: ${response.status}`);
    const wasm = await response.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", base));
    const { exports, memory } = await openPrototype(wasm, storage, digest);
    if (mode === "write") {
      const baseBefore = readBytes(exports, memory, 7n, BigInt(base.length), 4092n, 8);
      scratchBytes(exports, memory, Uint8Array.of(91, 92, 93, 94));
      assertResult(exports.prototype_write(7n, BigInt(base.length), 4094n, 4), 4);
      scratchBytes(exports, memory, Uint8Array.of(5, 6, 7));
      assertResult(exports.prototype_write(7n, BigInt(base.length), sparseOffset, 3), 3);
      const name = new TextEncoder().encode("note.txt");
      scratchBytes(exports, memory, name);
      assertResult(exports.prototype_create(1n, 8n, name.length), 0);
      scratchBytes(exports, memory, new TextEncoder().encode("hello"));
      assertResult(exports.prototype_write(8n, 0n, 0n, 5), 5);
      storage.close();
      self.postMessage({ type: "written", baseBefore, journalBytes: backend.stat(path).size });
      return;
    }
    const changed = readBytes(exports, memory, 7n, BigInt(base.length), 4092n, 8);
    const sparse = readBytes(exports, memory, 7n, BigInt(base.length), sparseOffset - 2n, 5);
    const untouched = readBytes(exports, memory, 7n, BigInt(base.length), 5000n, 4);
    const name = new TextEncoder().encode("note.txt");
    scratchBytes(exports, memory, name);
    const createdInode = exports.prototype_lookup(1n, name.length).toString();
    const createdData = readBytes(exports, memory, 8n, 0n, 0n, 5);
    const logicalSize = exports.prototype_size(7n, BigInt(base.length)).toString();
    storage.close();
    storage = OverlayStorageFile.open(backend, path);
    const wrongDigest = Uint8Array.from(digest);
    wrongDigest[0] ^= 1;
    let wrongBaseStatus = 0;
    try {
      await openPrototype(wasm, storage, wrongDigest);
    } catch (error) {
      wrongBaseStatus = error instanceof Error && error.message.includes("got -5") ? -5 : -1;
    }
    storage.close();
    backend.unlink(path);
    self.postMessage({ type: "result", changed, sparse, untouched, logicalSize, createdInode, createdData, wrongBaseStatus });
  } catch (error) {
    const opened = storage;
    if (opened !== null) ignoreFailure(() => opened.close());
    ignoreFailure(() => backend.unlink(path));
    self.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    self.close();
  }
};
