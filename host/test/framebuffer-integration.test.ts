/**
 * Integration test for /dev/fb0 binding.
 *
 * Runs `fbtest.wasm` (programs/fbtest.c) which:
 *   - opens /dev/fb0
 *   - queries geometry via FBIOGET_VSCREENINFO / FBIOGET_FSCREENINFO
 *   - mmaps the pixel buffer
 *   - writes a known pattern (pixel at row=r, col=c is 0xFF000000 | r<<16 | c)
 *   - prints "ok\n" and pauses (wait for SIGTERM)
 *
 * The test verifies that the kernel correctly registers the framebuffer
 * binding with the host and that pixel writes from the user program land
 * in the bound region of the process's wasm Memory SAB.
 *
 * Runs in main-thread mode via NodePlatformIO so the test can inspect
 * the kernel-side FramebufferRegistry directly. (Worker-thread mode
 * would need an event-forwarding bridge — out of scope for this PR; the
 * canvas renderer in PR #3 is what consumes the registry in production.)
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import { detectPtrWidth } from "../src/constants";
import type { CentralizedWorkerInitMessage } from "../src/worker-protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));

const fbtestBinary = join(__dirname, "../wasm/fbtest.wasm");
const kernelBinary = join(__dirname, "../wasm/wasm_posix_kernel.wasm");

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 72 + 65536;

function loadProgramWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createProcessMemory(initialPages: number): WebAssembly.Memory {
  // fbtest is wasm32 (compiled with wasm32posix-cc).
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: MAX_PAGES,
    shared: true,
  });
}

describe.skipIf(!existsSync(fbtestBinary))("framebuffer integration", () => {
  it("mmap of /dev/fb0 binds the region and surfaces pixels through the SAB", async () => {
    const programBytes = loadProgramWasm(fbtestBinary);
    const kernelWasmBytes = loadProgramWasm(kernelBinary);
    const ptrWidth = detectPtrWidth(programBytes);
    expect(ptrWidth).toBe(4);

    const io = new NodePlatformIO();
    const workerAdapter = new NodeWorkerAdapter();
    const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

    const pid = 100;

    let stdout = "";
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
      onStderr: () => {},
    });

    await kernel.init(kernelWasmBytes);

    const memory = createProcessMemory(17);
    const channelOffset = (MAX_PAGES - 2) * 65536;
    // Pre-grow to MAX_PAGES so the channel offset is in mapped memory.
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    kernel.registerProcess(pid, memory, [channelOffset], { ptrWidth });

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      ppid: 0,
      programBytes,
      memory,
      channelOffset,
      argv: ["fbtest"],
      env: [],
      ptrWidth,
    };

    const mainWorker = workerAdapter.createWorker(initData);
    workers.set(pid, mainWorker);

    try {
      // Wait for the program to print "ok\n" (mmap done, pattern written).
      await Promise.race([
        okPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("fbtest didn't print 'ok' in 10s")), 10_000),
        ),
      ]);

      // Verify the binding was recorded.
      const binding = kernel.framebuffers.get(pid);
      expect(binding).toBeDefined();
      expect(binding!.w).toBe(640);
      expect(binding!.h).toBe(400);
      expect(binding!.stride).toBe(640 * 4);
      expect(binding!.fmt).toBe("BGRA32");
      expect(binding!.len).toBe(640 * 400 * 4);

      // Read the bound region and check the pattern: pixel(r,c) =
      // 0xFF000000 | (r << 16) | c. Sample at a few coordinates.
      const procMem = kernel.getProcessMemory(pid);
      expect(procMem).toBeDefined();
      const view = new DataView(procMem!.buffer, binding!.addr, binding!.len);
      const sample = (r: number, c: number) =>
        view.getUint32((r * binding!.w + c) * 4, /*littleEndian*/ true);

      // Pattern: 0xFF000000 | (r << 16) | c. With r up to 399 the high
      // bit of `r << 16` ORs into the alpha byte; the test simply
      // recomputes the formula so it stays self-consistent.
      const expected = (r: number, c: number) =>
        ((0xff000000 | (r << 16) | c) >>> 0);
      expect(sample(0, 0)).toBe(expected(0, 0));
      expect(sample(10, 20)).toBe(expected(10, 20));
      expect(sample(255, 255)).toBe(expected(255, 255));
      expect(sample(399, 639)).toBe(expected(399, 639));

      // Note: unbind on process exit / munmap is exercised by the
      // cargo unit tests (`munmap_of_fb_region_clears_binding_and_unbinds_host`,
      // `execve_releases_fb_binding_and_unbinds`). Verifying it here
      // would need an exit signal we can't trivially deliver from the
      // test harness in main-thread mode.
    } finally {
      for (const [, w] of workers) await w.terminate().catch(() => {});
      // Avoid an unhandled-promise warning if the program never exits.
      void exitPromise.catch(() => {});
    }
  }, 30_000);
});
