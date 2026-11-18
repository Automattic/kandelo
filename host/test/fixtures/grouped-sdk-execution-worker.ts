import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { NodePlatformIO } from "../../src/platform/node";
import { NodeWorkerAdapter } from "../../src/worker-adapter";
import { runSdkExecution } from "./grouped-sdk-execution";

// This is a dedicated kernel Worker, separate from the ordinary process entry.
const buffer = (path: string): ArrayBuffer => Uint8Array.from(readFileSync(path)).buffer;
const { kernelPath, programPath, ordinaryPath, grouped, trace } = workerData;
try {
  parentPort!.postMessage(await runSdkExecution({
    kernelBytes: buffer(kernelPath), programBytes: buffer(programPath), ordinaryBytes: buffer(ordinaryPath),
    grouped, trace, io: new NodePlatformIO(), adapter: new NodeWorkerAdapter(), joinOnExit: true,
  }));
} finally { parentPort!.close(); }
