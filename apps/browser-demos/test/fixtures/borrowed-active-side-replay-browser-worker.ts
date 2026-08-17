import {
  LinkedForkContinuation,
  readLinkedFrameFormat,
} from "../../../../host/src/fork-continuation";
import { ForkModuleStateArena } from "../../../../host/src/fork-module-state";
import { BorrowedProcessTestRuntime } from "./borrowed-process-runtime";

interface BorrowedActiveSideReplayRequest {
  mainModule: WebAssembly.Module;
  mainBytes: Uint8Array;
  sideModule: WebAssembly.Module;
  sideBytes: Uint8Array;
  memory: WebAssembly.Memory;
  processLaunchRoot: number;
  moduleStateRoot: number;
  privatePrefix: number;
}

interface BorrowedActiveSideReplayResult {
  result?: number;
  prefixActivations?: number[];
  mainActive?: boolean;
  sideActive?: boolean;
  arenaActive?: boolean;
  error?: string;
}

const workerScope = globalThis as unknown as {
  close(): void;
  onmessage: (
    (event: MessageEvent<BorrowedActiveSideReplayRequest>) => void
  ) | null;
  postMessage(message: BorrowedActiveSideReplayResult): void;
};

workerScope.onmessage = (event) => {
  try {
    const {
      mainModule,
      mainBytes,
      sideModule,
      sideBytes,
      memory,
      processLaunchRoot,
      moduleStateRoot,
      privatePrefix,
    } = event.data;
    const runtime = new BorrowedProcessTestRuntime(
      memory,
      "borrowed active-side browser child",
    );
    const mainContinuation = new LinkedForkContinuation(
      memory,
      readLinkedFrameFormat(mainModule),
      () => { throw new Error("borrowed main activation must not allocate"); },
      () => { throw new Error("borrowed main activation must not release"); },
      "borrowed browser child main",
    );
    const sideContinuation = new LinkedForkContinuation(
      memory,
      readLinkedFrameFormat(sideModule),
      () => { throw new Error("borrowed side activation must not allocate"); },
      () => { throw new Error("borrowed side activation must not release"); },
      "borrowed browser child side",
    );
    const finishBorrowedFork = (): number => {
      if (runtime.coordinator.phaseName() !== "child-replay") {
        throw new Error(
          `borrowed side reached fork while ${runtime.coordinator.phaseName()}`,
        );
      }
      runtime.coordinator.finishReplay();
      return 0;
    };
    const mainEnv = runtime.prepareActivation({
      activationId: 0,
      module: mainModule,
      moduleBytes: mainBytes,
      continuation: mainContinuation,
    });
    const sideEnv = runtime.prepareActivation({
      activationId: 1,
      module: sideModule,
      moduleBytes: sideBytes,
      continuation: sideContinuation,
      invokeFork: finishBorrowedFork,
    });
    const mainInstance = new WebAssembly.Instance(mainModule, {
      env: { memory, ...mainEnv },
      kernel: { kernel_fork: finishBorrowedFork },
    });
    const sideInstance = new WebAssembly.Instance(sideModule, {
      env: { memory, ...sideEnv },
    });
    runtime.registerActivation(0, mainInstance, false);
    runtime.registerActivation(1, sideInstance, false);
    runtime.setProcessLaunchRoot(processLaunchRoot);

    const arena = new ForkModuleStateArena(
      memory,
      readLinkedFrameFormat(mainModule).ptrWidth,
      () => { throw new Error("borrowed child must not allocate module state"); },
      () => { throw new Error("borrowed child must not release module state"); },
      "borrowed active-side browser child arena",
    );
    arena.attachBorrowed(moduleStateRoot);
    const prefixActivations: number[] = [];
    runtime.coordinator.attachBorrowedChild(arena, ({ activationId }) => {
      prefixActivations.push(activationId);
      if (activationId !== 1) {
        throw new Error(`inactive main activation requested prefix ${activationId}`);
      }
      return privatePrefix;
    });

    workerScope.postMessage({
      result: (sideInstance.exports.run as () => number)(),
      prefixActivations,
      mainActive: mainContinuation.hasActiveContinuation(),
      sideActive: sideContinuation.hasActiveContinuation(),
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
