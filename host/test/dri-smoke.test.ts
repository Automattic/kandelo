/**
 * End-to-end smoke test for the v1 GBM dumb-buffer surface on
 * /dev/dri/renderD128. Runs `dri-smoke.wasm` (programs/dri-smoke.c) which:
 *
 *   - opens the device,
 *   - queries DRM_IOCTL_VERSION + DRM_IOCTL_GET_CAP(DUMB_BUFFER, PRIME),
 *   - CREATE_DUMB(640x400, bpp=32),
 *   - MAP_DUMB + mmap,
 *   - writes a known pixel pattern into the mapping,
 *   - exports the bo as a PRIME fd,
 *   - prints "ok\n" and pauses.
 *
 * The test asserts:
 *   1. the program reached "ok" (every ioctl returned success),
 *   2. the kernel populated the host GbmBoRegistry with the right
 *      metadata (size, geometry, binding range),
 *   3. the bound region of the process Memory SAB contains the
 *      expected pixel pattern.
 *
 * Same template as framebuffer-integration.test.ts — main-thread
 * kernel mode so vitest can directly inspect `kernel.bos`.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { CAPTURED_STDIO, CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import { detectPtrWidth } from "../src/constants";
import { tryResolveBinary } from "../src/binary-resolver";
import type { CentralizedWorkerInitMessage } from "../src/worker-protocol";

const driSmokeBinary = tryResolveBinary("programs/dri-smoke.wasm") ?? "";
const kernelBinary = tryResolveBinary("kernel.wasm") ?? "";

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 72 + 65536;

function loadProgramWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createProcessMemory(initialPages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: MAX_PAGES,
    shared: true,
  });
}

describe.skipIf(!existsSync(driSmokeBinary))("dri-smoke integration", () => {
  it("CREATE_DUMB + MAP_DUMB + mmap binds bo and surfaces pixels through the SAB", async () => {
    const programBytes = loadProgramWasm(driSmokeBinary);
    const kernelWasmBytes = loadProgramWasm(kernelBinary);
    const ptrWidth = detectPtrWidth(programBytes);
    expect(ptrWidth).toBe(4);

    const io = new NodePlatformIO();
    const workerAdapter = new NodeWorkerAdapter();
    const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

    let pid = 0;

    let stdout = "";
    let stderr = "";
    let stdoutResolved = false;
    let resolveOk: () => void;
    const okPromise = new Promise<void>((resolve) => {
      resolveOk = resolve;
    });
    let resolveExit: (status: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const kernel = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true, enableSyscallLog: false },
      io,
      {
        onExit: (exitPid, exitStatus) => {
          if (exitPid === pid) {
            kernel.unregisterProcess(exitPid);
            const w = workers.get(exitPid);
            if (w) {
              w.terminate().catch(() => {});
              workers.delete(exitPid);
            }
            resolveExit(exitStatus);
          }
        },
      },
    );

    kernel.setOutputCallbacks({
      onStdout: (data: Uint8Array) => {
        stdout += new TextDecoder().decode(data);
        if (!stdoutResolved && stdout.includes("ok\n")) {
          stdoutResolved = true;
          resolveOk();
        }
      },
      onStderr: (data: Uint8Array) => {
        stderr += new TextDecoder().decode(data);
      },
    });

    await kernel.init(kernelWasmBytes);
    pid = kernel.createProcess(CAPTURED_STDIO);

    const memory = createProcessMemory(17);
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    kernel.registerProcess(pid, memory, [channelOffset], { ptrWidth });

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      programBytes,
      memory,
      channelOffset,
      argv: ["dri-smoke"],
      env: [],
      ptrWidth,
    };

    const mainWorker = workerAdapter.createWorker(initData);
    workers.set(pid, mainWorker);

    try {
      await Promise.race([
        okPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`dri-smoke didn't print 'ok' in 10s. stdout=${stdout!} stderr=${stderr!}`)), 10_000),
        ),
      ]);

      // Exactly one bo for our pid.
      const bos = kernel.bos.listForPid(pid);
      expect(bos.length).toBe(1);
      const bo = bos[0]!;

      // CREATE_DUMB geometry: 640x400 ARGB8888.
      expect(bo.w).toBe(640);
      expect(bo.h).toBe(400);
      expect(bo.stride).toBe(640 * 4);
      expect(bo.size).toBe(640 * 400 * 4);

      // mmap reported the binding.
      expect(bo.binding).not.toBeNull();
      expect(bo.binding!.len).toBe(640 * 400 * 4);

      // Read pixel pattern from the bound region of the process Memory SAB.
      const procMem = kernel.getProcessMemory(pid);
      expect(procMem).toBeDefined();
      const view = new DataView(procMem!.buffer, bo.binding!.addr, bo.binding!.len);
      const sample = (r: number, c: number) =>
        view.getUint32((r * bo.w + c) * 4, /*littleEndian*/ true);
      const expected = (r: number, c: number) =>
        ((0xff000000 | (r << 16) | c) >>> 0);
      expect(sample(0, 0)).toBe(expected(0, 0));
      expect(sample(10, 20)).toBe(expected(10, 20));
      expect(sample(255, 255)).toBe(expected(255, 255));
      expect(sample(399, 639)).toBe(expected(399, 639));
    } finally {
      const mainW = workers.get(pid);
      if (mainW) {
        await mainW.terminate().catch(() => {});
      }
      await Promise.race([
        exitPromise,
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 1_000)),
      ]);
    }
  }, 20_000);
});
