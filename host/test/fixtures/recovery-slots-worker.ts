import { closeSync, openSync, readSync, statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { CentralizedKernelWorker } from "../../src/kernel-worker";
import { NodePlatformIO } from "../../src/platform/node";
import { configureRootfsOverlayFromImage } from "../../src/process-lifecycle";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";

const { imagePath, binding, kernelWasm, directory, count, budget, phase } = workerData;
let descriptor: number | undefined;
let storage: OverlayStorageFile | undefined;
let result: Record<string, unknown> = {};
const failures: string[] = [];
try {
  const worker = new CentralizedKernelWorker({ maxWorkers: 1, dataBufferSize: 65536,
    useSharedMemory: true, kernelMaxPages: 1024, rootfsMetadataBytes: budget }, new NodePlatformIO());
  descriptor = openSync(imagePath, "r");
  configureRootfsOverlayFromImage(worker, { imageLength: statSync(imagePath).size,
    persistentImageBinding: binding, foreignPrefixes: [], nosuid: false,
    imageRead: (offset, output) => readSync(descriptor!, output, 0, output.length, offset) });
  await worker.init(kernelWasm);
  storage = OverlayStorageFile.open(new HostFileSystem(directory), "/journal", phase === "replace");
  worker.enableResizableRootfsPersistence(storage);
  if (phase === "replace") {
    for (let index = 0; index < count; index++) {
      const suffix = String(index).padStart(4, "0");
      if (!worker.rootfsUnlinkFile(`/base-${suffix}`)) throw new Error(`base unlink failed: ${suffix}`);
      worker.rootfsWriteFile(`/next-${suffix}`, new Uint8Array(), 0o644);
    }
    worker.syncRootfsPersistence();
  }
  const entries = worker.rootfsReadDirectory("/");
  const replacements = entries.filter(entry => entry.name.startsWith("next-"));
  if (replacements.length !== count || entries.some(entry => entry.name.startsWith("base-"))) {
    throw new Error("recovered replacement namespace differs");
  }
  if (phase === "recover") {
    worker.rootfsWriteFile("/next-0000", new TextEncoder().encode("after recovery"), 0o644);
    worker.syncRootfsPersistence();
  }
  result = { count: replacements.length, text: new TextDecoder().decode(worker.rootfsReadFile("/next-0000")),
    ioMemory: worker.rootfsIoMemory(), journalBytes: storage.len() };
} catch (error) {
  failures.push(String(error));
} finally {
  try { storage?.close(); } catch (error) { failures.push(String(error)); }
  try { if (descriptor !== undefined) closeSync(descriptor); } catch (error) { failures.push(String(error)); }
}
parentPort!.postMessage(failures.length === 0 ? result : { error: failures.join(" | ") });
