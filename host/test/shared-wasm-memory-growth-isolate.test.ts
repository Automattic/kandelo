import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PAGE_BYTES = 64 * 1024;
const MESSAGE_TIMEOUT_MS = 10_000;
const RECEIVE_INITIALIZATION = 0;
const USE_INITIALIZATION = 1;
const workerUrl = new URL(
  "./fixtures/shared-wasm-memory-growth-worker.ts",
  import.meta.url,
);
const growerWorkerUrl = new URL(
  "./fixtures/shared-wasm-memory-grower-worker.ts",
  import.meta.url,
);
const watPath = new URL(
  "./fixtures/shared-wasm-memory-growth.wat",
  import.meta.url,
);

type WorkerMessage =
  | { type: "bootstrap-ready" }
  | { type: "init-received" }
  | { type: "grower-ready"; memoryBytes: number; observed: number }
  | { type: "grown"; memoryBytes: number; previousPages: number }
  | {
      type: "instance-ready";
      memoryBytes: number;
      observed: number;
      retainedBufferBytes: number;
      synchronizedMemoryBytes: number;
      synchronizedPages: number;
    }
  | { type: "result"; memoryBytes: number; observed: number }
  | {
      type: "failure";
      stage: string;
      name: string;
      message: string;
    };

let compiledModule: WebAssembly.Module;
let fixtureDirectory: string;

async function nextMessage(worker: Worker): Promise<WorkerMessage> {
  const signal = AbortSignal.timeout(MESSAGE_TIMEOUT_MS);
  const [message] = await once(worker, "message", { signal });
  return message as WorkerMessage;
}

function assertMessageType<T extends WorkerMessage["type"]>(
  message: WorkerMessage,
  type: T,
): asserts message is Extract<WorkerMessage, { type: T }> {
  if (message.type === "failure") {
    throw new Error(`${message.stage}: ${message.name}: ${message.message}`);
  }
  expect(message.type).toBe(type);
}

function releaseBarrier(barrier: Int32Array, index: number): void {
  // WHY: the worker acknowledges the phase before it starts waiting. The
  // stored state is authoritative; a notify count of zero is also valid when
  // the worker observes that state before entering Atomics.wait.
  Atomics.store(barrier, index, 1);
  Atomics.notify(barrier, index, 1);
}

function createTypeScriptWorker(entryUrl: URL, workerData: unknown): Worker {
  const require = createRequire(import.meta.url);
  const tsxApiUrl = pathToFileURL(require.resolve("tsx/esm/api")).href;
  const bootstrap = [
    `import { register } from '${tsxApiUrl}';`,
    "register();",
    `await import('${entryUrl.href}');`,
  ].join("\n");
  return new Worker(bootstrap, { eval: true, workerData });
}

async function growFromWorker(
  grower: Worker,
  expectedPreviousPages: number,
): Promise<void> {
  const grownPromise = nextMessage(grower);
  grower.postMessage({ type: "grow", pages: 1 });
  const grown = await grownPromise;
  assertMessageType(grown, "grown");
  expect(grown).toEqual({
    type: "grown",
    memoryBytes: (expectedPreviousPages + 1) * PAGE_BYTES,
    previousPages: expectedPreviousPages,
  });
}

beforeAll(async () => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "kandelo-wasm-growth-"));
  const wasmPath = join(fixtureDirectory, "shared-memory-growth.wasm");
  execFileSync(
    "wat2wasm",
    ["--enable-threads", fileURLToPath(watPath), "-o", wasmPath],
    { stdio: "inherit" },
  );
  compiledModule = await WebAssembly.compile(
    readFileSync(wasmPath) as unknown as BufferSource,
  );
});

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

/**
 * Node/V8 measurement, 2026-08-02 (Node.js 24.15.0): minimal variants did
 * not fail when another isolate grew before receipt, after receipt but before
 * instantiation, or from an enumerable getter during structured clone. This
 * is therefore a positive Node subsystem contract, not the RED proof for the
 * fix. The executable Kandelo/SpiderMonkey helper-pthread regression remains
 * the RED authority.
 */
describe("shared WebAssembly.Memory growth across Node isolates", () => {
  it("synchronizes a received pthread memory before compiled Wasm access", async () => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 4,
      shared: true,
    });
    const initialization = { memory, module: compiledModule };
    const barrier = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    const barrierView = new Int32Array(barrier);
    const target = createTypeScriptWorker(workerUrl, { barrier });
    const grower = createTypeScriptWorker(growerWorkerUrl, initialization);

    try {
      const [bootstrapReady, growerReady] = await Promise.all([
        nextMessage(target),
        nextMessage(grower),
      ]);
      assertMessageType(bootstrapReady, "bootstrap-ready");
      assertMessageType(growerReady, "grower-ready");
      expect(growerReady).toEqual({
        type: "grower-ready",
        memoryBytes: PAGE_BYTES,
        observed: 0x0123_4567,
      });

      const initReceivedPromise = nextMessage(target);
      target.postMessage(initialization);
      releaseBarrier(barrierView, RECEIVE_INITIALIZATION);
      const initReceived = await initReceivedPromise;
      assertMessageType(initReceived, "init-received");

      await growFromWorker(grower, 1);
      expect(memory.buffer.byteLength).toBe(2 * PAGE_BYTES);
      const instanceReadyPromise = nextMessage(target);
      releaseBarrier(barrierView, USE_INITIALIZATION);
      const instanceReady = await instanceReadyPromise;
      assertMessageType(instanceReady, "instance-ready");
      expect(instanceReady).toEqual({
        type: "instance-ready",
        memoryBytes: 2 * PAGE_BYTES,
        observed: 0x1234_5678,
        retainedBufferBytes: 2 * PAGE_BYTES,
        synchronizedMemoryBytes: 2 * PAGE_BYTES,
        synchronizedPages: 2,
      });

      // A later grow must update the already-compiled target instance too.
      const resultPromise = nextMessage(target);
      await growFromWorker(grower, 2);
      target.postMessage({
        type: "access",
        address: 2 * PAGE_BYTES,
        value: 0x2345_6789,
      });
      const result = await resultPromise;
      assertMessageType(result, "result");
      expect(result).toEqual({
        type: "result",
        memoryBytes: 3 * PAGE_BYTES,
        observed: 0x2345_6789,
      });
    } finally {
      releaseBarrier(barrierView, RECEIVE_INITIALIZATION);
      releaseBarrier(barrierView, USE_INITIALIZATION);
      await Promise.all([target.terminate(), grower.terminate()]);
    }
  });
});
