/**
 * End-to-end multiplex test for `programs/cube_pyramid.c`. Runs the
 * forked-two-process GL binary against a centralised kernel and
 * asserts (1) both sides exit clean, (2) the host muxer's `switchTo`
 * sees ≥2 distinct (pid, ctx_id) bindings.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { CAPTURED_STDIO, CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { NodeWorkerAdapter } from "../src/worker-adapter";
import { detectPtrWidth, extractHeapBase } from "../src/constants";
import { tryResolveBinary } from "../src/binary-resolver";
import { GlMuxer } from "../src/webgl/muxer";
import type { GlBinding } from "../src/webgl/registry";
import type {
  CentralizedWorkerInitMessage,
  WorkerToHostMessage,
} from "../src/worker-protocol";

const programBinary = tryResolveBinary("programs/cube_pyramid.wasm") ?? "";
const kernelBinary = tryResolveBinary("kernel.wasm") ?? "";

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 72 + 65536;

function loadProgramWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createProcessMemory(pages: number): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: pages,
    maximum: MAX_PAGES,
    shared: true,
  });
}

/** Proxy WebGL2 context: every call lands in `log`; `create*` returns
 *  a fresh object so the bridge's per-name maps stay distinct. */
function makeFakeGl(): { log: Array<[string, unknown[]]>; gl: WebGL2RenderingContext } {
  const log: Array<[string, unknown[]]> = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) => {
        log.push([prop, args]);
        if (prop.startsWith("create")) return {};
        if (prop.startsWith("get")) return 0;
        return undefined;
      };
    },
  };
  return { log, gl: new Proxy({}, handler) as unknown as WebGL2RenderingContext };
}

function makeFakeCanvas(gl: WebGL2RenderingContext) {
  return {
    getContext(kind: string) {
      return kind === "webgl2" ? gl : null;
    },
  } as unknown as OffscreenCanvas;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!existsSync(programBinary) || !existsSync(kernelBinary))(
  "dri cube + pyramid end-to-end multiplex (plan 3 §C2)",
  () => {
    it("two forked processes drive two GL contexts; muxer arbitrates", async () => {
      const programBytes = loadProgramWasm(programBinary);
      const kernelWasmBytes = loadProgramWasm(kernelBinary);
      const ptrWidth = detectPtrWidth(programBytes);
      expect(ptrWidth).toBe(4);

      const { gl: fakeGl } = makeFakeGl();
      const fakeCanvas = makeFakeCanvas(fakeGl);

      // Spy must be installed before the kernel constructs muxers.
      const switchSpy = vi.spyOn(GlMuxer.prototype, "switchTo");

      const io = new NodePlatformIO();
      const workerAdapter = new NodeWorkerAdapter();
      const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

      const parentPid = 100;
      let stdout = "";
      let stderr = "";
      let resolveExit: (s: number) => void;
      let rejectExit: (e: Error) => void;
      const exitPromise = new Promise<number>((resolve, reject) => {
        resolveExit = resolve;
        rejectExit = reject;
      });

      const kernel = new CentralizedKernelWorker(
        {
          maxWorkers: 4,
          dataBufferSize: 65536,
          useSharedMemory: true,
          enableSyscallLog: false,
        },
        io,
        {
          onFork: async (parentForkPid, childPid, parentMemory) => {
            const parentBuf = new Uint8Array(parentMemory.buffer);
            const parentPages = Math.ceil(parentBuf.byteLength / 65536);
            const childMemory = createProcessMemory(parentPages);
            const growBy = MAX_PAGES - parentPages;
            if (growBy > 0) childMemory.grow(growBy);
            new Uint8Array(childMemory.buffer).set(parentBuf);

            const childChannelOffset = (MAX_PAGES - 2) * 65536;
            new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

            kernel.registerProcess(childPid, childMemory, [childChannelOffset], {
              skipKernelCreate: true,
              ptrWidth,
            });

            // Same canvas → same WebGL2 context → same muxer instance
            // (gl_muxers is a WeakMap keyed by context).
            kernel.gl.attachCanvas(childPid, fakeCanvas);

            const ASYNCIFY_BUF_SIZE = 16384;
            const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;

            const childInit: CentralizedWorkerInitMessage = {
              type: "centralized_init",
              pid: childPid,
              ppid: parentForkPid,
              programBytes,
              memory: childMemory,
              channelOffset: childChannelOffset,
              isForkChild: true,
              asyncifyBufAddr,
              ptrWidth,
            };

            const childWorker = workerAdapter.createWorker(childInit);
            workers.set(childPid, childWorker);
            childWorker.on("error", () => {
              kernel.unregisterProcess(childPid);
              workers.delete(childPid);
            });
            childWorker.on("message", (m: unknown) => {
              const msg = m as WorkerToHostMessage;
              if (msg.type !== "error") return;
              kernel.unregisterProcess(childPid);
              workers.delete(childPid);
            });

            return [childChannelOffset];
          },
          onExit: (exitPid, exitStatus) => {
            const w = workers.get(exitPid);
            if (w) {
              w.terminate().catch(() => {});
              workers.delete(exitPid);
            }
            if (exitPid === parentPid) {
              kernel.unregisterProcess(exitPid);
              resolveExit(exitStatus);
            } else {
              kernel.deactivateProcess(exitPid);
            }
          },
        },
      );

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

      kernel.registerProcess(parentPid, memory, [channelOffset], { ptrWidth, stdio: CAPTURED_STDIO });
      const heapBase = extractHeapBase(programBytes);
      if (heapBase !== null) kernel.setBrkBase(parentPid, heapBase);

      // Attach before the worker starts so eglInitialize → host_gl_bind
      // sees the canvas.
      kernel.gl.attachCanvas(parentPid, fakeCanvas);

      const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init",
        pid: parentPid,
        ppid: 0,
        programBytes,
        memory,
        channelOffset,
        argv: ["cube_pyramid", "200"],
        env: [],
        ptrWidth,
      };

      const mainWorker = workerAdapter.createWorker(initData);
      workers.set(parentPid, mainWorker);

      const timer = setTimeout(() => {
        for (const [, w] of workers) w.terminate().catch(() => {});
        rejectExit(new Error(`cube_pyramid timed out. stdout=${stdout} stderr=${stderr}`));
      }, 30_000);
      mainWorker.on("error", (err: Error) => {
        clearTimeout(timer);
        rejectExit(err);
      });
      mainWorker.on("message", (m: unknown) => {
        const msg = m as WorkerToHostMessage;
        if (msg.type === "error" && msg.pid === parentPid) {
          clearTimeout(timer);
          rejectExit(new Error(msg.message));
        }
      });

      let exitCode = -1;
      try {
        exitCode = await exitPromise;
      } finally {
        clearTimeout(timer);
      }

      expect(exitCode, `stdout=${stdout}\nstderr=${stderr}`).toBe(0);
      expect(stdout).toMatch(/cube_pyramid: parent pid=\d+ rc=0, child pid=\d+ rc=0/);

      const switchedKeys = new Set<string>();
      for (const call of switchSpy.mock.calls) {
        const b = call[0] as Pick<GlBinding, "pid" | "contextId">;
        switchedKeys.add(`${b.pid}/${b.contextId ?? "-"}`);
      }
      expect(switchedKeys.size, `switched keys = ${[...switchedKeys].join(",")}`).toBeGreaterThanOrEqual(2);
    }, 60_000);
  },
);
