import { parentPort, workerData } from "node:worker_threads";
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { CentralizedKernelWorker } from "../../src/kernel-worker";
import { NodePlatformIO } from "../../src/platform/node";
import { configureRootfsOverlayFromImage } from "../../src/process-lifecycle";

const { image, kernelWasm, destination } = workerData as { image: Uint8Array; kernelWasm: ArrayBuffer; destination: string };
try {
  const worker = new CentralizedKernelWorker({ maxWorkers: 1, dataBufferSize: 65536,
    useSharedMemory: true, kernelMaxPages: 1024 }, new NodePlatformIO());
  configureRootfsOverlayFromImage(worker, { imageLength: image.length, foreignPrefixes: [], nosuid: false,
    imageRead: (offset, output) => {
      const source = image.subarray(offset, offset + output.length);
      output.set(source);
      return source.length;
    } });
  await worker.init(kernelWasm);
  worker.rootfsWriteFile("/owned-snapshot-payload", new Uint8Array(1024 * 1024).fill(81), 0o644);
  const baseline = worker.rootfsIoMemory().used;
  writeFileSync(destination, new Uint8Array(0));
  const descriptor = openSync(destination, "r");
  let code: string | undefined;
  try { worker.rootfsExportContainerVisitBorrowed((_offset, bytes) => { writeSync(descriptor, bytes); }); }
  catch (error) { code = (error as { code?: string }).code; }
  finally { closeSync(descriptor); }
  const afterFailure = worker.rootfsIoMemory().used;
  worker.rootfsWriteFile("/after-export-error", new TextEncoder().encode("usable"), 0o644);
  const visible = new TextDecoder().decode(worker.rootfsReadFile("/after-export-error"));
  const beforeSuccess = worker.rootfsIoMemory().used;
  const length = worker.rootfsExportContainerVisitBorrowed(() => {});
  const afterSuccess = worker.rootfsIoMemory().used;
  parentPort!.postMessage({ code, baseline, afterFailure, beforeSuccess, afterSuccess, length, visible });
} catch (error) { parentPort!.postMessage({ unexpected: String(error) }); }
