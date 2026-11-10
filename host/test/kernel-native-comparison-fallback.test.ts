import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { createWasmPosixKernelTestHarness, getWasmPosixKernelRuntimeAccess } from "../src/kernel";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { NodeTimeProvider } from "../src/vfs/time";
import { lookupComparisonMemoryShape } from "../src/process-snapshot-comparator";
import { ABI_SYSCALLS, CH_ARGS, CH_ARG_SIZE, CH_DATA, CH_ERRNO, CH_RETURN, CH_SYSCALL, CH_TOTAL_SIZE } from "../src/generated/abi";

// A genuine externally provided Memory deliberately has no trusted constructor
// descriptor. Exercise real Rust fallback through the normal selected kernel,
// channel dispatch and kernel-file mapping exports, without overriding results.
describe("normal kernel native-comparison fallback", () => {
  it("copies and publishes changed process bytes when descriptor metadata is unknown", async () => {
    const processMemory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
    expect(lookupComparisonMemoryShape(processMemory)).toBeUndefined();
    const statuses: number[] = [];
    let reads = 0;
    const kernel = createWasmPosixKernelTestHarness({
      config: { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
      io: new VirtualPlatformIO([], new NodeTimeProvider()),
      callbacks: { getProcessMemory: () => processMemory },
      engine: {
        compile: bytes => WebAssembly.compile(bytes),
        instantiate: async (module, imports) => {
          const env = imports.env as Record<string, any>;
          const compare = env.host_proc_compare_bytes, read = env.host_proc_read_bytes;
          env.host_proc_compare_bytes = (...args: any[]) => {
            const status = compare(...args);
            statuses.push(status);
            return status;
          };
          env.host_proc_read_bytes = (...args: any[]) => { reads++; return read(...args); };
          return WebAssembly.instantiate(module, imports);
        },
      },
    });
    await kernel.init(readFileSync(resolveBinary("kernel.wasm")));
    const access = getWasmPosixKernelRuntimeAccess(kernel);
    const exports = access.instance()!.exports as Record<string, Function>;
    const pid = exports.kernel_create_process();
    expect(pid).toBeGreaterThan(0);
    const pointer = exports.kernel_alloc_scratch(CH_TOTAL_SIZE) as number;
    expect(pointer).toBeGreaterThan(0);
    function call(nr: number, args: bigint[], data?: Uint8Array) {
      const memory = access.memory()!;
      new Uint8Array(memory.buffer, pointer, CH_TOTAL_SIZE).fill(0);
      if (data) new Uint8Array(memory.buffer, pointer + CH_DATA, data.length).set(data);
      const view = new DataView(memory.buffer, pointer, CH_TOTAL_SIZE);
      view.setUint32(CH_SYSCALL, nr, true);
      args.forEach((arg, i) => view.setBigInt64(CH_ARGS + CH_ARG_SIZE * i, arg, true));
      expect(exports.kernel_set_current_tid(pid, pid)).toBe(0);
      exports.kernel_handle_channel(pointer, CH_TOTAL_SIZE, pid, 0n);
      const after = new DataView(access.memory()!.buffer, pointer, CH_TOTAL_SIZE);
      expect(after.getUint32(CH_ERRNO, true), `syscall ${nr}`).toBe(0);
      return after.getBigInt64(CH_RETURN, true);
    }
    const fd = call(ABI_SYSCALLS.MemfdCreate, [BigInt(pointer + CH_DATA), 0n], new TextEncoder().encode("snapshot-fallback\0"));
    expect(fd).toBeGreaterThanOrEqual(0n);
    expect(call(ABI_SYSCALLS.Ftruncate, [fd, 4096n])).toBe(0n);
    expect(exports.kernel_shared_mapping_file_track(pid, 65536n, Number(fd), 4096n, 0n, 1, BigInt(processMemory.buffer.byteLength))).toBe(0);
    const expected = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 23) & 255);
    new Uint8Array(processMemory.buffer, 65536, expected.length).set(expected);
    statuses.length = 0; reads = 0;
    expect(exports.kernel_shared_mapping_sync_process(pid, 1)).toBe(0);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every(status => status === 2)).toBe(true);
    expect(reads).toBeGreaterThan(0);
    expect(call(ABI_SYSCALLS.Pread, [fd, BigInt(pointer + CH_DATA), 4096n, 0n])).toBe(4096n);
    expect(new Uint8Array(access.memory()!.buffer, pointer + CH_DATA, expected.length)).toEqual(expected);
    // An equal observation must still take a real owned read under fallback.
    statuses.length = 0; reads = 0;
    expect(exports.kernel_shared_mapping_sync_process(pid, 1)).toBe(0);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every(status => status === 2)).toBe(true);
    expect(reads).toBeGreaterThan(0);
    expect(exports.kernel_shared_mapping_release_process(pid, 0, 0)).toBe(0);
    expect(exports.kernel_remove_process(pid)).toBe(0);
  });
});
