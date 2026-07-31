import {
  LinkedForkContinuation,
  type LinkedFrameFormatDescriptor,
} from "../../../../host/src/fork-continuation";
import { ForkModuleStateArena } from "../../../../host/src/fork-module-state";
import { SingleActivationForkRuntime } from "../../../../host/test/fork-instrument-runtime-harness";

interface BorrowedReplayRequest {
  module: WebAssembly.Module;
  moduleBytes: Uint8Array;
  memory: WebAssembly.Memory;
  linkedFormat: LinkedFrameFormatDescriptor;
  moduleBuffer: number;
  moduleStateRoot: number;
  privateModuleBuffer: number;
}

interface BorrowedReplayResult {
  result?: number;
  active?: boolean;
  arenaActive?: boolean;
  error?: string;
}

const workerScope = globalThis as unknown as {
  close(): void;
  onmessage: ((event: MessageEvent<BorrowedReplayRequest>) => void) | null;
  postMessage(message: BorrowedReplayResult): void;
};

workerScope.onmessage = (event) => {
  try {
    const {
      module,
      moduleBytes,
      memory,
      linkedFormat,
      moduleBuffer,
      moduleStateRoot,
      privateModuleBuffer,
    } = event.data;
    const continuation = new LinkedForkContinuation(
      memory,
      linkedFormat,
      () => {
        throw new Error("borrowed browser child must not allocate continuation state");
      },
      () => {
        throw new Error("borrowed browser child must not release continuation state");
      },
      "borrow-child-browser-e2e",
    );
    const newArena = () => new ForkModuleStateArena(
      memory,
      linkedFormat.ptrWidth,
      () => {
        throw new Error("borrowed browser child must not allocate module state");
      },
      () => {
        throw new Error("borrowed browser child must not release module state");
      },
      "borrow-child-browser module state",
    );
    const runtime = new SingleActivationForkRuntime({
      module,
      moduleBytes,
      memory,
      continuation,
      newArena,
      label: "borrow-child-browser-e2e",
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
              `borrowed browser child reached fork while `
              + runtime.coordinator.phaseName(),
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
        throw new Error(`unexpected borrowed browser activation ${activationId}`);
      }
      return linkedFormat.ptrWidth === 8
        ? BigInt(privateModuleBuffer)
        : privateModuleBuffer;
    });

    workerScope.postMessage({
      result: (instance.exports.run as () => number)(),
      active: continuation.hasActiveContinuation(),
      arenaActive: arena.hasActiveArena(),
    });
  } catch (error) {
    workerScope.postMessage({
      error: error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : String(error),
    });
  } finally {
    workerScope.close();
  }
};
