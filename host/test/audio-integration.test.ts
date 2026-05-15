/**
 * Integration test for /dev/dsp.
 *
 * Spawns programs/audiotest.c which:
 *   - opens /dev/dsp with O_WRONLY
 *   - configures sample rate (44100), stereo, AFMT_S16_LE via OSS ioctls
 *   - prints "ready <rate> <chans>\n"
 *   - writes a 256-byte PCM frame sequence (byte i = i & 0xff)
 *   - prints "wrote <n>\n"
 *   - exits 0
 *
 * The test then asserts:
 *   - the program exited cleanly
 *   - audioSampleRate() / audioChannels() report what audiotest configured
 *   - drainAudio() returns the same 256 bytes the program wrote
 *
 * Runs in centralized worker mode (single shared kernel, per-process
 * worker) — same harness as mouse-integration.test.ts.
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

const audiotestBinary = join(__dirname, "../wasm/audiotest.wasm");
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

describe.skipIf(!existsSync(audiotestBinary))("audio integration", () => {
  it("/dev/dsp buffers PCM written by a program; host drains it back verbatim", async () => {
    const programBytes = loadProgramWasm(audiotestBinary);
    const kernelWasmBytes = loadProgramWasm(kernelBinary);
    const ptrWidth = detectPtrWidth(programBytes);
    expect(ptrWidth).toBe(4);

    const io = new NodePlatformIO();
    const workerAdapter = new NodeWorkerAdapter();
    const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

    const pid = 100;

    let stdout = "";
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

    let stderr = "";
    kernel.setOutputCallbacks({
      onStdout: (data: Uint8Array) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (data: Uint8Array) => {
        stderr += new TextDecoder().decode(data);
      },
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
      argv: ["audiotest"],
      env: [],
      ptrWidth,
    };

    const mainWorker = workerAdapter.createWorker(initData);
    workers.set(pid, mainWorker);

    try {
      const exitCode = await Promise.race([
        exitPromise,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("audiotest didn't exit in 10s")), 10_000),
        ),
      ]);
      expect(exitCode).toBe(0);
      void stderr;

      // Stdout: "ready 44100 2\nwrote 256\n"
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      const ready = lines[0].split(" ");
      expect(ready[0]).toBe("ready");
      expect(parseInt(ready[1], 10)).toBe(44100);
      expect(parseInt(ready[2], 10)).toBe(2);
      const wrote = lines[1].split(" ");
      expect(wrote[0]).toBe("wrote");
      expect(parseInt(wrote[1], 10)).toBe(256);

      // Kernel-side config readouts agree with what the program asked for.
      expect(kernel.audioSampleRate()).toBe(44100);
      expect(kernel.audioChannels()).toBe(2);

      // Drain the ring. audiotest writes 256 bytes that the kernel's
      // 4-byte stereo frame alignment rounds down to 256 (256 / 4 *
      // 4 = 256). The first call should pull all 256 bytes; we loop
      // defensively in case the host returns fewer per call.
      const drained = new Uint8Array(256);
      let total = 0;
      for (let attempt = 0; attempt < 8 && total < drained.length; attempt++) {
        const chunk = new Uint8Array(drained.length - total);
        const n = kernel.drainAudio(chunk);
        if (n === 0) break;
        drained.set(chunk.subarray(0, n), total);
        total += n;
      }
      expect(total).toBe(256);
      // audiotest wrote pcm[i] = i & 0xff
      for (let i = 0; i < 256; i++) {
        expect(drained[i]).toBe(i & 0xff);
      }

      // Ring is empty after the drain.
      expect(kernel.audioPending()).toBe(0);
      const after = new Uint8Array(64);
      expect(kernel.drainAudio(after)).toBe(0);
    } finally {
      for (const [, w] of workers) await w.terminate().catch(() => {});
      void exitPromise.catch(() => {});
    }
  }, 30_000);
});
