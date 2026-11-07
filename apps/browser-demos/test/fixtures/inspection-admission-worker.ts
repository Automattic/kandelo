import { installBrowserSetImmediatePolyfill } from "../../../../host/src/browser-immediate-polyfill";
import { CentralizedKernelWorker } from "../../../../host/src/kernel-worker";
import { configureRootfsOverlayFromImage } from "../../../../host/src/process-lifecycle";
import { OpfsOverlayStorageFile } from "../../../../host/src/vfs/overlay-storage";
import { BrowserTimeProvider } from "../../../../host/src/vfs/time";
import { VirtualPlatformIO } from "../../../../host/src/vfs/vfs";
import { exerciseInspectionAdmission } from "../../../../host/test/fixtures/inspection-admission";

installBrowserSetImmediatePolyfill();

self.onmessage = async event => {
  const { source, kernelWasm, binding, name, variant, phase } = event.data;
  let image: FileSystemSyncAccessHandle | undefined;
  let journal: OpfsOverlayStorageFile | undefined;
  const failures: string[] = [];
  const fatalErrors: string[] = [];
  let result: Record<string, unknown> = {};
  try {
    image = await source.createSyncAccessHandle();
    const input = image!;
    const worker = new CentralizedKernelWorker({ maxWorkers: 1, dataBufferSize: 65536,
      useSharedMemory: true, kernelMaxPages: 1024 }, new VirtualPlatformIO([], new BrowserTimeProvider()),
    { onKernelFatal: error => fatalErrors.push(String(error)) });
    configureRootfsOverlayFromImage(worker, { imageLength: input.getSize(), persistentImageBinding: binding,
      foreignPrefixes: [], nosuid: false, imageRead: (offset, output) => input.read(output, { at: offset }) });
    await worker.init(kernelWasm);
    journal = (await OpfsOverlayStorageFile.openFile(name, "legacy", "journal", phase === "exercise")) ?? undefined;
    if (journal === undefined) throw new Error("inspection recovery journal missing");
    worker.enableResizableRootfsPersistence(journal);
    if (phase === "recover") {
      result = { marker: new TextDecoder().decode(worker.rootfsReadFile("/after-inspection-refusal")) };
    } else {
      result = await exerciseInspectionAdmission(worker, variant);
    }
    worker.syncRootfsPersistence();
  } catch (error) { failures.push(String(error)); }
  finally {
    for (const storage of [journal, image]) {
      try { storage?.close(); } catch (error) { failures.push(String(error)); }
    }
  }
  self.postMessage({ ...result, fatalErrors, failures, closed: failures.length === 0 });
};
