import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { createWasmPosixKernelTestHarness, getWasmPosixKernelRuntimeAccess } from "../src/kernel";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { NodeTimeProvider } from "../src/vfs/time";
import { ABI_SYSCALLS, CH_ARGS, CH_ARG_SIZE, CH_DATA, CH_ERRNO, CH_RETURN, CH_SYSCALL, CH_TOTAL_SIZE } from "../src/generated/abi";

// The real kernel's half of the completion-boundary proof (`BoundaryRecord`
// in crates/runtime-core/src/memory.rs): a sync whose caller passes force=2
// after an entry sync that found the mapping equal skips the comparison, and
// every condition that voids the proof brings the comparison back.
describe("kernel shared-mapping boundary proof", () => {
  async function boot() {
    const processMemory = new WebAssembly.Memory({ initial: 4, maximum: 8, shared: true });
    let compares = 0;
    const kernel = createWasmPosixKernelTestHarness({
      config: { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
      io: new VirtualPlatformIO([], new NodeTimeProvider()),
      callbacks: { getProcessMemory: () => processMemory },
      engine: {
        compile: bytes => WebAssembly.compile(bytes),
        instantiate: async (module, imports) => {
          const env = imports.env as Record<string, any>;
          const compare = env.host_proc_compare_bytes;
          env.host_proc_compare_bytes = (...args: any[]) => { compares++; return compare(...args); };
          return WebAssembly.instantiate(module, imports);
        },
      },
    });
    await kernel.init(readFileSync(resolveBinary("kernel.wasm")));
    const access = getWasmPosixKernelRuntimeAccess(kernel);
    const exports = access.instance()!.exports as Record<string, Function>;
    const pid = exports.kernel_create_process() as number;
    const pointer = exports.kernel_alloc_scratch(CH_TOTAL_SIZE) as number;
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
    const fd = call(ABI_SYSCALLS.MemfdCreate, [BigInt(pointer + CH_DATA), 0n], new TextEncoder().encode("boundary-proof\0"));
    expect(call(ABI_SYSCALLS.Ftruncate, [fd, 4096n])).toBe(0n);
    // Two mappings of one memfd: each is the other's live peer, so both are
    // compared at every ordinary boundary.
    for (const addr of [65536n, 131072n]) {
      expect(exports.kernel_shared_mapping_file_track(pid, addr, Number(fd), 4096n, 0n, 1, BigInt(processMemory.buffer.byteLength))).toBe(0);
    }
    const sync = (force: number) => {
      compares = 0;
      expect(exports.kernel_shared_mapping_sync_process(pid, force)).toBe(0);
      return compares;
    };
    return { exports, pid, processMemory, sync };
  }

  it("skips a claimed completion and compares every other boundary", async () => {
    const { exports, pid, processMemory, sync } = await boot();
    expect(sync(0)).toBe(2);
    expect(sync(2)).toBe(0);
    expect(sync(0)).toBe(2);
    // A store after the claimed boundary is published at the next one.
    new Uint8Array(processMemory.buffer, 65536, 4).set([1, 2, 3, 4]);
    expect(sync(0)).toBe(2);
    expect(Array.from(new Uint8Array(processMemory.buffer, 131072, 4))).toEqual([1, 2, 3, 4]);
    // Another mapping operation in between voids the proof.
    expect(sync(0)).toBe(2);
    expect(exports.kernel_shared_mapping_protect(pid, 65536n, 4096n, 1)).toBe(0);
    expect(sync(2)).toBe(2);
    // A forced sync is not a boundary the next claim can build on.
    expect(sync(1)).toBeGreaterThan(0);
    expect(sync(2)).toBe(2);
  });
});
