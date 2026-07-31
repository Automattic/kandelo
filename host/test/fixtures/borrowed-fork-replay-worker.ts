import { parentPort, workerData } from "node:worker_threads";
import {
  LinkedForkContinuation,
  type LinkedFrameFormatDescriptor,
} from "../../src/fork-continuation";
import { ForkModuleStateArena } from "../../src/fork-module-state";
import { SingleActivationForkRuntime } from "../fork-instrument-runtime-harness";

const {
  module,
  moduleBytes,
  memory,
  linkedFormat,
  moduleBuffer,
  moduleStateRoot,
  privateModuleBuffer,
} = workerData as {
  module: WebAssembly.Module;
  moduleBytes: Uint8Array;
  memory: WebAssembly.Memory;
  linkedFormat: LinkedFrameFormatDescriptor;
  moduleBuffer: number;
  moduleStateRoot: number;
  privateModuleBuffer: number;
};

const continuation = new LinkedForkContinuation(
  memory,
  linkedFormat,
  () => { throw new Error("borrowed child must not allocate continuation state"); },
  () => { throw new Error("borrowed child must not release continuation state"); },
  "borrow-child-worker-e2e",
);
const newArena = () => new ForkModuleStateArena(
  memory,
  linkedFormat.ptrWidth,
  () => { throw new Error("borrowed child must not allocate module state"); },
  () => { throw new Error("borrowed child must not release module state"); },
  "borrow-child-worker module state",
);
const runtime = new SingleActivationForkRuntime({
  module,
  moduleBytes,
  memory,
  continuation,
  newArena,
  label: "borrow-child-worker-e2e",
});
let instance: WebAssembly.Instance;
instance = new WebAssembly.Instance(module, {
  env: {
    memory,
    ...runtime.envImports,
  },
  kernel: {
    kernel_fork: () => {
      if (runtime.coordinator.phaseName() !== "child-replay") {
        throw new Error(
          `borrowed child reached fork while ${runtime.coordinator.phaseName()}`,
        );
      }
      runtime.coordinator.finishReplay();
      return 0;
    },
  },
});
runtime.register(instance, { bootstrap: false });
runtime.setCopiedProcessLaunchRoot(moduleBuffer);
const arena = newArena();
arena.attachBorrowed(
  linkedFormat.ptrWidth === 8 ? BigInt(moduleStateRoot) : moduleStateRoot,
);
runtime.coordinator.attachBorrowedChild(arena, ({ activationId }) => {
  if (activationId !== 0) {
    throw new Error(`unexpected borrowed activation ${activationId}`);
  }
  return linkedFormat.ptrWidth === 8
    ? BigInt(privateModuleBuffer)
    : privateModuleBuffer;
});

parentPort!.postMessage({
  result: (instance.exports.run as () => number)(),
  active: continuation.hasActiveContinuation(),
  arenaActive: arena.hasActiveArena(),
});
