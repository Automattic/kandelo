import { parentPort, workerData } from "node:worker_threads";

type GrowerWorkerData = {
  memory: WebAssembly.Memory;
  module: WebAssembly.Module;
};

if (parentPort === null) {
  throw new Error("shared-memory grower fixture requires a parent port");
}

const port = parentPort;
const { memory, module } = workerData as GrowerWorkerData;
const instance = await WebAssembly.instantiate(module, {
  env: { memory },
});
const storeThenLoad = instance.exports.store_then_load;

if (typeof storeThenLoad !== "function") {
  throw new Error("fixture module does not export store_then_load");
}

// Prove the grower owns a live instance before the coordinator proceeds.
const initialObserved = storeThenLoad(0, 0x0123_4567) as number;
port.postMessage({
  type: "grower-ready",
  memoryBytes: memory.buffer.byteLength,
  observed: initialObserved,
});

port.on("message", (message: unknown) => {
  try {
    if (
      message === null ||
      typeof message !== "object" ||
      !("type" in message)
    ) {
      throw new Error("grower fixture received an invalid command");
    }
    if (message.type !== "grow") {
      throw new Error("grower fixture received an invalid command");
    }
    const command = message as { type: "grow"; pages: number };
    const previousPages = memory.grow(command.pages);
    port.postMessage({
      type: "grown",
      memoryBytes: memory.buffer.byteLength,
      previousPages,
    });
  } catch (error) {
    port.postMessage({
      type: "failure",
      stage: "grow",
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
