import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { createWasmPosixKernelTestHarness, getWasmPosixKernelRuntimeAccess } from "../src/kernel";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { NodeTimeProvider } from "../src/vfs/time";
import { ABI_SYSCALLS, CH_ARGS, CH_ARG_SIZE, CH_DATA, CH_ERRNO, CH_RETURN, CH_SYSCALL, CH_TOTAL_SIZE } from "../src/generated/abi";

// The real kernel's half of lazy kernel-file coherence
// (`sync_file_at_completion` and `CleanStamp` in
// crates/runtime-core/src/memory.rs), driven through the same exports and
// imports the kernel worker uses: an entry sync does no kernel-file work, a
// completion pulls the mappings that share a file with the process, and a
// pull of a process still parked at the epoch of its previous pull is
// proved unchanged. A kernel built with `shared-mapping-proof-verify`
// compares anyway and counts the confirmed proof.
const ENTRY = 3, COMPLETION = 0, FORCED = 1, LEGACY_UNCHANGED = 2;

describe("kernel shared-mapping lazy boundaries", () => {
  async function boot() {
    const processMemory = new WebAssembly.Memory({ initial: 4, maximum: 8, shared: true });
    let compares = 0;
    // -1: not provably quiescent, as the harness host answers by default.
    let epoch = -1n;
    let memoryChanges = 0;
    let parks = 0;
    const kernel = createWasmPosixKernelTestHarness({
      config: { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
      io: new VirtualPlatformIO([], new NodeTimeProvider()),
      callbacks: {
        getProcessMemory: () => processMemory,
        getProcessQuiescentEpoch: () => epoch,
        onProcessMemoryChanged: () => { memoryChanges++; if (epoch >= 0n) epoch++; },
      },
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
    const verifies = typeof exports.kernel_shared_mapping_proofs_verified === "function";
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
    // Two mappings of one memfd in one process: each alias observes the
    // other, so both are pulled at every completion of the process.
    for (const addr of [65536n, 131072n]) {
      expect(exports.kernel_shared_mapping_file_track(pid, addr, Number(fd), 4096n, 0n, 1, BigInt(processMemory.buffer.byteLength))).toBe(0);
    }
    const sync = (force: number) => {
      compares = 0;
      expect(exports.kernel_shared_mapping_sync_process(pid, force)).toBe(0);
      return compares;
    };
    const verified = () => verifies ? Number(exports.kernel_shared_mapping_proofs_verified()) : 0;
    return {
      processMemory, sync, verifies, verified,
      // Each park follows a resume, which always moves the epoch on.
      park: () => { epoch = BigInt(++parks) * 1000n; },
      resume: () => { epoch = -1n; },
      memoryChanges: () => memoryChanges,
    };
  }

  it("does no kernel-file work at an entry and pulls aliases at a completion", async () => {
    const { processMemory, sync } = await boot();
    expect(sync(ENTRY)).toBe(0);
    expect(sync(COMPLETION)).toBe(2);
    new Uint8Array(processMemory.buffer, 65536, 4).set([1, 2, 3, 4]);
    expect(sync(ENTRY)).toBe(0);
    expect(Array.from(new Uint8Array(processMemory.buffer, 131072, 4))).toEqual([0, 0, 0, 0]);
    expect(sync(COMPLETION)).toBe(2);
    expect(Array.from(new Uint8Array(processMemory.buffer, 131072, 4))).toEqual([1, 2, 3, 4]);
  });

  it("skips a pull the process's quiescent epoch proves redundant", async () => {
    const { processMemory, sync, verifies, verified, park, resume, memoryChanges } = await boot();
    park();
    // The first pull at this epoch compares and stamps.
    expect(sync(COMPLETION)).toBe(2);
    const proofs = verified();
    // Still parked at the same epoch: proved unchanged.
    expect(sync(COMPLETION)).toBe(verifies ? 2 : 0);
    expect(sync(LEGACY_UNCHANGED)).toBe(verifies ? 2 : 0);
    expect(sync(FORCED)).toBe(verifies ? 2 : 0);
    expect(verified()).toBe(verifies ? proofs + 6 : 0);
    // The process runs and stores: a new epoch, so it is compared again,
    // and the store reaches the other alias.
    resume();
    new Uint8Array(processMemory.buffer, 65536, 2).set([9, 9]);
    park();
    // Both aliases are compared once; the stale one is refreshed from what
    // that pull read, without a second comparison.
    expect(sync(COMPLETION)).toBe(2);
    expect(Array.from(new Uint8Array(processMemory.buffer, 131072, 2))).toEqual([9, 9]);
    // That refresh was a host write into the process: an epoch event.
    expect(memoryChanges()).toBeGreaterThan(0);
  });
});
