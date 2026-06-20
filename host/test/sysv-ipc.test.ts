/**
 * Tests for SysV IPC: message queues, semaphores, and shared memory.
 * Verifies that the SharedIpcTable is properly wired up in the kernel worker.
 */
import { describe, it, expect, vi } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ipcBinary = join(__dirname, "../../examples/sysv_ipc_test.wasm");
const hasBinary = existsSync(ipcBinary);

function createSysvSyncHarness() {
  const pid = 101;
  const segId = 7;
  const mapAddr = 0x2000;
  const size = 4096;
  const processMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const kernelMemory = new WebAssembly.Memory({ initial: 2 });
  const backing = new Uint8Array(size);
  const writes: Array<{ segId: number; offset: number; bytes: Uint8Array }> = [];

  const writeChunk = vi.fn((shmid: number, offset: number, dataPtr: number, dataLen: number) => {
    const kernelMem = new Uint8Array(kernelMemory.buffer);
    const bytes = kernelMem.slice(dataPtr, dataPtr + dataLen);
    backing.set(bytes, offset);
    writes.push({ segId: shmid, offset, bytes });
    return dataLen;
  });

  const readChunk = vi.fn((shmid: number, offset: number, outPtr: number, maxLen: number) => {
    expect(shmid).toBe(segId);
    const len = Math.min(maxLen, backing.length - offset);
    new Uint8Array(kernelMemory.buffer).set(backing.subarray(offset, offset + len), outPtr);
    return len;
  });

  const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    kernel: { toKernelPtr: (value: number | bigint) => Number(value) },
    kernelMemory,
    kernelInstance: {
      exports: {
        kernel_set_current_pid: vi.fn(),
        kernel_ipc_shm_write_chunk: writeChunk,
        kernel_ipc_shm_read_chunk: readChunk,
        kernel_ipc_shmdt: vi.fn(() => 0),
      },
    },
    processes: new Map([
      [pid, { memory: processMemory, ptrWidth: 4 }],
    ]),
    shmMappings: new Map([
      [
        pid,
        new Map([
          [
            mapAddr,
            {
              segId,
              size,
              readOnly: false,
              snapshot: new Uint8Array(size),
              version: 0,
            },
          ],
        ]),
      ],
    ]),
    shmSegmentVersions: new Map([[segId, 0]]),
    scratchOffset: 0,
  }) as CentralizedKernelWorker;

  const channel = {
    pid,
    memory: processMemory,
    channelOffset: 0,
    i32View: new Int32Array(processMemory.buffer, 0, 1),
    consecutiveSyscalls: 0,
  };

  return {
    pid,
    segId,
    mapAddr,
    processMemory,
    processMem: new Uint8Array(processMemory.buffer),
    kw,
    channel,
    writes,
    writeChunk,
  };
}

describe("SysV shared-memory host synchronization", () => {
  it("skips single-observer syscall-boundary publishes but forces observer handoff publishes", () => {
    const {
      pid,
      segId,
      mapAddr,
      processMem,
      kw,
      channel,
      writes,
      writeChunk,
    } = createSysvSyncHarness();

    processMem[mapAddr + 17] = 0x7b;

    (kw as any).synchronizeSysvShmMappingsForSyscallBoundary(channel);
    expect(writeChunk).not.toHaveBeenCalled();

    (kw as any).syncSysvShmSegmentFromMappedProcesses(segId);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.segId).toBe(segId);
    expect(writes[0]!.offset).toBe(0);
    expect(writes[0]!.bytes[17]).toBe(0x7b);

    writes.length = 0;
    writeChunk.mockClear();
    processMem[mapAddr + 41] = 0xa5;

    (kw as any).releaseAllSysvShmMappingsForProcess(pid);
    expect(writeChunk).toHaveBeenCalledTimes(1);
    expect(writes[0]!.bytes[41]).toBe(0xa5);
  });
});

describe.skipIf(!hasBinary)("SysV IPC", () => {
  it("message queues, semaphores, shared memory", async () => {
    const result = await runCentralizedProgram({
      programPath: ipcBinary,
      timeout: 10_000,
    });
    console.log("stdout:", JSON.stringify(result.stdout));
    console.log("stderr:", JSON.stringify(result.stderr));
    expect(result.stdout).toContain("msgq: PASS");
    expect(result.stdout).toContain("sem: PASS");
    expect(result.stdout).toContain("shm: PASS");
    expect(result.stdout).toContain("ALL TESTS PASSED");
    expect(result.exitCode).toBe(0);
  }, 15_000);
});
