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
import { CAPTURED_STDIO, CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import { detectPtrWidth } from "../src/constants";
import { tryResolveBinary } from "../src/binary-resolver";
import type {
  CentralizedWorkerInitMessage,
  WorkerToHostMessage,
} from "../src/worker-protocol";
import { TestProcessReferenceOwners } from "./process-reference-owner-helper";

const fbtestBinary = tryResolveBinary("programs/fbtest.wasm") ?? "";
const kernelBinary = tryResolveBinary("kernel.wasm") ?? "";

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

/**
 * Boot a kernel, run fbtest to the point where it has printed "ok", and
 * hand the caller the kernel plus the program's pid. `configure` runs
 * after `kernel.init` and before the process exists — the window in which
 * a machine's display mode is set.
 */
async function withFbtest(
  configure: (kernel: CentralizedKernelWorker) => void,
  inspect: (kernel: CentralizedKernelWorker, pid: number) => void,
): Promise<void> {
  const programBytes = loadProgramWasm(fbtestBinary);
  const kernelWasmBytes = loadProgramWasm(kernelBinary);
  const ptrWidth = detectPtrWidth(programBytes);
  expect(ptrWidth).toBe(4);

  const io = new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();
  const referenceOwners = new TestProcessReferenceOwners();
  const workers = new Map<
    number,
    ReturnType<NodeWorkerAdapter["createWorker"]>
  >();

  let pid = 0;

  let stdout = "";
  let stderr = "";
  let stdoutResolved = false;
  let resolveOk: () => void;
  let rejectOk: (reason: Error) => void;
  const okPromise = new Promise<void>((resolve, reject) => {
    resolveOk = resolve;
    rejectOk = reject;
  });
  let resolveExit: (status: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const kernel = new CentralizedKernelWorker(
    {
      maxWorkers: 4,
      dataBufferSize: 65536,
      useSharedMemory: true,
      enableSyscallLog: !!process.env.KERNEL_SYSCALL_LOG,
    },
    io,
    {
      onExit: (exitPid, exitStatus) => {
        if (exitPid === pid) {
          referenceOwners.release(exitPid);
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
  configure(kernel);
  pid = kernel.createProcess(CAPTURED_STDIO);

  const memory = createProcessMemory(17);
  const channelOffset = (MAX_PAGES - 2) * 65536;
  // Pre-grow to MAX_PAGES so the channel offset is in mapped memory.
  memory.grow(MAX_PAGES - 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

  kernel.registerProcess(pid, memory, [channelOffset], { ptrWidth });
  const referenceInit = referenceOwners.start(pid);

  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid,
    programBytes,
    memory,
    channelOffset,
    secureExec: kernel.processSecureExec(pid),
    argv: ["fbtest"],
    env: [],
    ptrWidth,
    ...referenceInit,
  };

  const mainWorker = workerAdapter.createWorker(initData);
  referenceOwners.attach(pid, mainWorker);
  mainWorker.on("error", (error) => rejectOk(error));
  mainWorker.on("message", (raw: unknown) => {
    const message = raw as WorkerToHostMessage;
    if (message.type === "error" && message.pid === pid) {
      rejectOk(new Error(message.message));
    }
  });
  mainWorker.on("exit", (code) => {
    if (!stdoutResolved) {
      rejectOk(
        new Error(
          `fbtest worker exited with status ${code} before readiness` +
            (stderr ? `: ${stderr}` : ""),
        ),
      );
    }
  });
  workers.set(pid, mainWorker);

  try {
    // Wait for the program to print "ok\n" (mmap done, pattern written).
    await Promise.race([
      okPromise,
      new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "fbtest didn't print 'ok' in 10s" +
                  (stderr ? `: ${stderr}` : ""),
              ),
            ),
          10_000,
        ),
      ),
    ]);

    inspect(kernel, pid);
  } finally {
    for (const [, w] of workers) await w.terminate().catch(() => {});
    referenceOwners.close();
    // Avoid an unhandled-promise warning if the program never exits.
    void exitPromise.catch(() => {});
  }
}

/**
 * Check the binding the kernel registered and the pattern fbtest wrote
 * into it: pixel(r,c) = 0xFF000000 | (r << 16) | c.
 */
function expectPatternAt(
  kernel: CentralizedKernelWorker,
  pid: number,
  width: number,
  height: number,
): void {
  const binding = kernel.framebuffers.get(pid);
  expect(binding).toBeDefined();
  expect(binding!.w).toBe(width);
  expect(binding!.h).toBe(height);
  expect(binding!.stride).toBe(width * 4);
  expect(binding!.fmt).toBe("BGRA32");
  expect(binding!.len).toBe(width * height * 4);

  const procMem = kernel.getProcessMemory(pid);
  expect(procMem).toBeDefined();
  const view = new DataView(procMem!.buffer, binding!.addr, binding!.len);
  const sample = (r: number, c: number) =>
    view.getUint32((r * binding!.w + c) * 4, /*littleEndian*/ true);

  // With r up to height-1 the high bit of `r << 16` ORs into the alpha
  // byte; the test simply recomputes the formula so it stays
  // self-consistent.
  const expected = (r: number, c: number) =>
    (0xff000000 | (r << 16) | c) >>> 0;
  for (const [r, c] of [[0, 0], [10, 20], [255, 255], [height - 1, width - 1]]) {
    expect(sample(r!, c!)).toBe(expected(r!, c!));
  }
}

describe.skipIf(!existsSync(fbtestBinary))("framebuffer integration", () => {
  it("mmap of /dev/fb0 binds the region and surfaces pixels through the SAB", async () => {
    await withFbtest(
      () => {},
      (kernel, pid) => expectPatternAt(kernel, pid, 640, 400),
    );

    // Note: unbind on process exit / munmap is exercised by the
    // cargo unit tests (`munmap_of_fb_region_clears_binding_and_unbinds_host`,
    // `execve_releases_fb_binding_and_unbinds`). Verifying it here
    // would need an exit signal we can't trivially deliver from the
    // test harness in main-thread mode.
  }, 30_000);

  it("a geometry set before the process runs is the mode the program gets", async () => {
    // fbtest never names a size: it mmaps `smem_len` and fills `xres` ×
    // `yres`, so a full 1280×800 pattern lands only if every reply
    // followed the pushed mode.
    await withFbtest(
      (kernel) => kernel.setFbGeometry(1280, 800),
      (kernel, pid) => expectPatternAt(kernel, pid, 1280, 800),
    );
  }, 30_000);
});
