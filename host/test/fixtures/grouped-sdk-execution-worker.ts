import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { NodePlatformIO } from "../../src/platform/node";
import { NodeWorkerAdapter } from "../../src/worker-adapter";
import { runSdkCycles, runSdkExecution } from "./grouped-sdk-execution";

// This is a dedicated kernel Worker, separate from the ordinary process entry.
const buffer = (path: string): ArrayBuffer => Uint8Array.from(readFileSync(path)).buffer;
const { imageModulePath, kernelPath, programPath, ordinaryPath, grouped, trace, cycles, physicalPages, maximumVirtualPages, execTargetPath, rejectThreadLaunchCount, threadPoolRollback, rejectForkLaunchCount, rejectForkStage, uncertainThreadConstructor, forcedLifecycle, nativeWaitLifecycle, execPrecommitFailure, execPoolRollback, execSuccess, execOldThreads, execSignal, execTerminationPool, anonymousShared } = workerData;
try {
  const options = {
    kernelBytes: buffer(kernelPath), programBytes: buffer(programPath), ordinaryBytes: buffer(ordinaryPath),
    imageModuleBytes: buffer(imageModulePath),
    grouped, trace, physicalPages, maximumVirtualPages, execTargetBytes: execTargetPath ? buffer(execTargetPath) : undefined,
    rejectThreadLaunchCount, threadPoolRollback, rejectForkLaunchCount, rejectForkStage, uncertainThreadConstructor, forcedLifecycle, nativeWaitLifecycle, execPrecommitFailure, execPoolRollback, execSuccess, execOldThreads, execSignal, execTerminationPool, anonymousShared, io: new NodePlatformIO(), adapter: new NodeWorkerAdapter(), joinOnExit: true,
  };
  parentPort!.postMessage(await (cycles ? runSdkCycles(options, cycles) : runSdkExecution(options)));
} finally { parentPort!.close(); }
