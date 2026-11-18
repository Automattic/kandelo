import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { dirname, join } from "node:path";
import { NodePlatformIO } from "../../src/platform/node";
import { NodeWorkerAdapter } from "../../src/worker-adapter";
import { runSdkCycles, runSdkExecution } from "./grouped-sdk-execution";

// This is a dedicated kernel Worker, separate from the ordinary process entry.
const buffer = (path: string): ArrayBuffer => Uint8Array.from(readFileSync(path)).buffer;
const { kernelPath, programPath, ordinaryPath, grouped, trace, cycles, physicalPages, rejectThreadLaunchCount, uncertainThreadConstructor, forcedLifecycle } = workerData;
try {
  const options = {
    kernelBytes: buffer(kernelPath), programBytes: buffer(programPath), ordinaryBytes: buffer(ordinaryPath),
    imageModuleBytes: buffer(join(dirname(dirname(kernelPath)), "kandelo_image_module32.wasm")),
    grouped, trace, physicalPages, rejectThreadLaunchCount, uncertainThreadConstructor, forcedLifecycle, io: new NodePlatformIO(), adapter: new NodeWorkerAdapter(), joinOnExit: true,
  };
  parentPort!.postMessage(await (cycles ? runSdkCycles(options, cycles) : runSdkExecution(options)));
} finally { parentPort!.close(); }
