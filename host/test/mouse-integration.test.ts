/**
 * Integration test for /dev/input/mice.
 *
 * Spawns programs/mousetest.c which:
 *   - opens /dev/input/mice with O_RDONLY|O_NONBLOCK
 *   - prints "ready\n"
 *   - reads N=3 PS/2 packets, printing one line per packet
 *   - exits 0 once N packets have arrived
 *
 * The test injects 3 events through CentralizedKernelWorker once it
 * sees "ready\n", then asserts the program reports them in the correct
 * PS/2 encoding (sign bits in byte0, signed int8 deltas).
 *
 * Runs in main-thread mode so the test holds the live
 * CentralizedKernelWorker reference and can call injectMouseEvent
 * directly. Worker-thread mode would need the same cross-thread
 * MouseInjectMessage plumbing the browser uses — out of scope here;
 * that path is exercised by the BrowserKernel demo.
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

const mousetestBinary = join(__dirname, "../wasm/mousetest.wasm");
const kernelBinary = join(__dirname, "../wasm/wasm_posix_kernel.wasm");

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

/**
 * Build the byte-0 of the PS/2 frame the kernel emits for a given
 * (dx, dy, buttons). Kept here so the test mirrors the kernel's
 * encoding rules without re-importing them.
 */
function expectedByte0(dx: number, dy: number, buttons: number): number {
  let b = 0x08 | (buttons & 0x07);
  if (dx < 0) b |= 0x10;
  if (dy < 0) b |= 0x20;
  return b;
}

describe.skipIf(!existsSync(mousetestBinary))("mouse integration", () => {
  it("/dev/input/mice delivers injected PS/2 packets in order", async () => {
    const programBytes = loadProgramWasm(mousetestBinary);
    const kernelWasmBytes = loadProgramWasm(kernelBinary);
    const ptrWidth = detectPtrWidth(programBytes);
    expect(ptrWidth).toBe(4);

    const io = new NodePlatformIO();
    const workerAdapter = new NodeWorkerAdapter();
    const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

    const pid = 100;

    let stdout = "";
    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
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

    let readySignalled = false;
    kernel.setOutputCallbacks({
      onStdout: (data: Uint8Array) => {
        stdout += new TextDecoder().decode(data);
        if (!readySignalled && stdout.includes("ready\n")) {
          readySignalled = true;
          resolveReady();
        }
      },
      onStderr: () => {},
    });

    await kernel.init(kernelWasmBytes);

    const memory = createProcessMemory(17);
    const channelOffset = (MAX_PAGES - 2) * 65536;
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
      argv: ["mousetest", "3"],
      env: [],
      ptrWidth,
    };

    const mainWorker = workerAdapter.createWorker(initData);
    workers.set(pid, mainWorker);

    try {
      await Promise.race([
        readyPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("mousetest didn't print 'ready' in 10s")), 10_000),
        ),
      ]);

      // Three events covering: pure motion (no buttons), motion with a
      // negative-y delta (forces the YSIGN bit in byte0), and a click
      // with no motion (button bit only).
      const events: Array<{ dx: number; dy: number; buttons: number }> = [
        { dx: 3, dy: 5, buttons: 0x00 },
        { dx: -2, dy: -7, buttons: 0x00 },
        { dx: 0, dy: 0, buttons: 0x01 },
      ];
      for (const ev of events) {
        kernel.injectMouseEvent(ev.dx, ev.dy, ev.buttons);
      }

      // Process exits after reading 3 packets.
      const exitCode = await Promise.race([
        exitPromise,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("mousetest didn't exit after 3 packets in 10s")), 10_000),
        ),
      ]);
      expect(exitCode).toBe(0);

      // Stdout should contain "ready\n" followed by 3 "pkt …" lines in
      // injection order.
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      expect(lines[0]).toBe("ready");
      expect(lines.slice(1)).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        const ev = events[i];
        const b0 = expectedByte0(ev.dx, ev.dy, ev.buttons).toString(16).padStart(2, "0");
        expect(lines[1 + i]).toBe(`pkt ${b0} ${ev.dx} ${ev.dy}`);
      }
    } finally {
      for (const [, w] of workers) await w.terminate().catch(() => {});
      void exitPromise.catch(() => {});
    }
  }, 30_000);
});
