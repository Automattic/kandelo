import { closeSync, openSync, readSync, statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { CentralizedKernelWorker } from "../../src/kernel-worker";
import { NodePlatformIO } from "../../src/platform/node";
import { configureRootfsOverlayFromImage } from "../../src/process-lifecycle";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";
import { exerciseInspectionAdmission } from "./inspection-admission";

const { imagePath, binding, kernelWasm, directory, variant, phase } = workerData;
let descriptor: number | undefined;
let storage: OverlayStorageFile | undefined;
let result: Record<string, unknown> = {};
const failures: string[] = [];
const fatalErrors: string[] = [];
try {
  const worker = new CentralizedKernelWorker({ maxWorkers: 1, dataBufferSize: 65536,
    useSharedMemory: true, kernelMaxPages: 1024 }, new NodePlatformIO(),
  { onKernelFatal: error => fatalErrors.push(String(error)) });
  descriptor = openSync(imagePath, "r");
  configureRootfsOverlayFromImage(worker, { imageLength: statSync(imagePath).size,
    persistentImageBinding: binding, foreignPrefixes: [], nosuid: false,
    imageRead: (offset, output) => readSync(descriptor!, output, 0, output.length, offset) });
  await worker.init(kernelWasm);
  storage = OverlayStorageFile.open(new HostFileSystem(directory), "/journal", phase === "exercise");
  worker.enableResizableRootfsPersistence(storage);
  result = phase === "exercise" ? await exerciseInspectionAdmission(worker, variant)
    : { marker: new TextDecoder().decode(worker.rootfsReadFile("/after-inspection-refusal")) };
  worker.syncRootfsPersistence();
} catch (error) { failures.push(String(error)); }
finally {
  try { storage?.close(); } catch (error) { failures.push(String(error)); }
  try { if (descriptor !== undefined) closeSync(descriptor); } catch (error) { failures.push(String(error)); }
}
parentPort!.postMessage({ ...result, fatalErrors, failures });
