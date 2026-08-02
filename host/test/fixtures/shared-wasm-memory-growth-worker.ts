import { parentPort, workerData } from "node:worker_threads";

import { synchronizeReceivedSharedWasmMemory } from "../../src/shared-wasm-memory-growth";

type Initialization = {
  memory: WebAssembly.Memory;
  module: WebAssembly.Module;
};

type FixtureWorkerData = {
  barrier: SharedArrayBuffer;
};

if (parentPort === null) {
  throw new Error("shared-memory growth fixture requires a parent port");
}

const port = parentPort;
const data = workerData as FixtureWorkerData;
const barrier = new Int32Array(data.barrier);
const RECEIVE_INITIALIZATION = 0;
const USE_INITIALIZATION = 1;

function reportFailure(stage: string, error: unknown): void {
  port.postMessage({
    type: "failure",
    stage,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
}

function receiveInitialization(): Promise<Initialization> {
  return new Promise((resolve) => port.once("message", resolve));
}

// Let the coordinator queue initialization before this worker installs its
// one-shot listener, matching Kandelo's built-in Node worker transport.
port.postMessage({ type: "bootstrap-ready" });
Atomics.wait(barrier, RECEIVE_INITIALIZATION, 0);

try {
  const { memory, module } = await receiveInitialization();

  // Memory is deserialized in this isolate, but no local buffer, view, or
  // instance exists. Hold this precise startup boundary while the process
  // isolate grows the shared backing.
  port.postMessage({ type: "init-received" });
  Atomics.wait(barrier, USE_INITIALIZATION, 0);

  // Exercise the same production boundary as centralizedThreadWorkerMain.
  // The return value is the page count before delta-zero growth; comparing it
  // with the buffer below proves synchronization did not add a page.
  const synchronizedPages = synchronizeReceivedSharedWasmMemory(memory);
  const synchronizedMemoryBytes = memory.buffer.byteLength;
  const retainedView = new Uint8Array(memory.buffer, 0, 1);
  const instance = await WebAssembly.instantiate(module, {
    env: { memory },
  });
  const storeThenLoad = instance.exports.store_then_load;
  if (typeof storeThenLoad !== "function") {
    throw new Error("fixture module does not export store_then_load");
  }

  const firstAddress = 64 * 1024;
  const firstValue = 0x1234_5678;
  const firstObserved = storeThenLoad(firstAddress, firstValue) as number;
  port.postMessage({
    type: "instance-ready",
    memoryBytes: memory.buffer.byteLength,
    observed: firstObserved,
    retainedBufferBytes: retainedView.buffer.byteLength,
    synchronizedMemoryBytes,
    synchronizedPages,
  });

  port.once("message", (message: unknown) => {
    try {
      if (
        message === null ||
        typeof message !== "object" ||
        !("type" in message) ||
        message.type !== "access"
      ) {
        throw new Error("fixture received an invalid access command");
      }
      const command = message as {
        type: "access";
        address: number;
        value: number;
      };
      const observed = storeThenLoad(command.address, command.value) as number;
      port.postMessage({
        type: "result",
        memoryBytes: memory.buffer.byteLength,
        observed,
      });
    } catch (error) {
      reportFailure("later access", error);
    }
  });
} catch (error) {
  reportFailure("initial access", error);
}
