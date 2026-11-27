/** Shared comparison of the current journal index and the paged prototype. */
export interface PositionedFile {
  size(): number;
  read(offset: number, bytes: Uint8Array): number;
  write(offset: number, bytes: Uint8Array): number;
  flush(): void;
  truncate(length: number): void;
}

interface Counters {
  readCalls: number;
  readBytes: number;
  writeCalls: number;
  writeBytes: number;
  flushCalls: number;
}

interface Phase extends Counters {
  name: string;
  ms: number;
}

export interface NamespaceSample {
  format: "current" | "paged" | "payload";
  files: number;
  phases: Phase[];
  retainedBytes: number;
  memoryBytes: number;
}

type BenchmarkExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  sm_namespace_benchmark(format: number, files: number, seed: number): number;
};

const namespacePhases = ["ingest", "checkpoint", "open", "lookup", "readdir", "verify"];
const payloadPhases = ["write-and-flush", "sequential-read"];

export async function measureNamespace(
  module: WebAssembly.Module,
  slots: PositionedFile[],
  format: NamespaceSample["format"],
  files: number,
  seed: number,
): Promise<NamespaceSample> {
  const empty = (): Counters => ({ readCalls: 0, readBytes: 0, writeCalls: 0, writeBytes: 0, flushCalls: 0 });
  const names = format === "payload" ? payloadPhases : namespacePhases;
  const phases: Phase[] = [];
  let counters = empty();
  let started = 0;
  let active = -1;
  let lastError: unknown;
  let exports: BenchmarkExports;
  const storage = (slot: number) => {
    const file = slots[slot];
    if (file === undefined) throw new Error(`Unexpected storage slot ${slot}`);
    return file;
  };
  const position = (value: bigint) => {
    const offset = Number(value);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Unsafe storage offset");
    return offset;
  };
  const result = (operation: () => void) => {
    try { operation(); return 0; }
    catch (error) { lastError = error; return -5; }
  };
  const writable = (pointer: number, length: number) => new Uint8Array(exports.memory.buffer, pointer, length);
  const imports = {
    namespace_benchmark: {
      storage_len: (slot: number) => {
        try { return BigInt(storage(slot).size()); }
        catch (error) { lastError = error; return -5n; }
      },
      storage_read: (slot: number, offset: bigint, pointer: number, length: number) => result(() => {
        const read = storage(slot).read(position(offset), writable(pointer, length));
        if (read !== length) throw new Error(`Short read at ${offset}: ${read}/${length}`);
        counters.readCalls++;
        counters.readBytes += read;
      }),
      storage_write: (slot: number, offset: bigint, pointer: number, length: number) => result(() => {
        const written = storage(slot).write(position(offset), writable(pointer, length));
        if (written !== length) throw new Error(`Short write at ${offset}: ${written}/${length}`);
        counters.writeCalls++;
        counters.writeBytes += written;
      }),
      storage_flush: (slot: number) => result(() => { storage(slot).flush(); counters.flushCalls++; }),
      storage_truncate: (slot: number, length: bigint) => result(() => storage(slot).truncate(position(length))),
      mark_phase: (phase: number) => {
        const now = performance.now();
        if (phase !== active + 1) throw new Error(`Unexpected phase ${phase} after ${active}`);
        if (active >= 0) phases.push({ name: names[active]!, ms: now - started, ...counters });
        counters = empty();
        active = phase;
        started = now;
      },
    },
  };
  const instance = await WebAssembly.instantiate(module, imports);
  exports = instance.exports as BenchmarkExports;
  const status = exports.sm_namespace_benchmark(format === "current" ? 0 : format === "paged" ? 1 : 2, files, seed);
  if (status !== 0) throw new Error(`${format} namespace benchmark failed with errno ${-status}`, { cause: lastError });
  if (phases.length !== names.length) throw new Error("The namespace benchmark did not finish all phases");
  const retainedBytes = (format === "current" ? slots.slice(1) : slots)
    .reduce((bytes, slot) => bytes + slot.size(), 0);
  return { format, files, phases, retainedBytes, memoryBytes: exports.memory.buffer.byteLength };
}

export const comparisonFileCounts = [4096, 32768];
export const comparisonRounds = 3;

export async function compareNamespaces(
  run: (format: NamespaceSample["format"], files: number, seed: number) => Promise<NamespaceSample>,
): Promise<NamespaceSample[]> {
  const samples = [await run("payload", 0, 0)];
  for (const files of comparisonFileCounts) {
    for (let round = 0; round < comparisonRounds; round++) {
      const order = round % 2 === 0 ? ["current", "paged"] as const : ["paged", "current"] as const;
      for (const format of order) {
        samples.push(await run(format, files, 101 + round));
      }
    }
  }
  return samples;
}
