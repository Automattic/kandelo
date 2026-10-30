import { ERRNO } from "../../../../host/src/generated/abi";
import { installBrowserSetImmediatePolyfill } from "../../../../host/src/browser-immediate-polyfill";
import { CentralizedKernelWorker } from "../../../../host/src/kernel-worker";
import { configureRootfsOverlayFromImage } from "../../../../host/src/process-lifecycle";
import { compactOverlayGenerationForBoot, enableBestOverlayGeneration, RejectedOverlayGenerationError, type OverlayGenerationFiles, type SelectedOverlayGeneration } from "../../../../host/src/vfs/overlay-generation-selection";
import { OpfsOverlayStorageFile } from "../../../../host/src/vfs/overlay-storage";
import { BrowserTimeProvider } from "../../../../host/src/vfs/time";
import { VirtualPlatformIO } from "../../../../host/src/vfs/vfs";

installBrowserSetImmediatePolyfill();

self.onmessage = async (event: MessageEvent<{ name: string; mode: "fixed" | "resizable"; kernelWasm: ArrayBuffer; injectMemoryRefusal?: boolean; reportMemory?: boolean }>) => {
  const { name, mode, kernelWasm, injectMemoryRefusal = true, reportMemory = false } = event.data;
  let image: FileSystemSyncAccessHandle | undefined;
  let selected: SelectedOverlayGeneration | undefined;
  let result: unknown;
  const failures: string[] = [];
  try {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
    image = await (await directory.getFileHandle(`${name}.base`)).createSyncAccessHandle();
    const worker = new CentralizedKernelWorker(
      { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true, kernelMaxPages: 1024 },
      new VirtualPlatformIO([], new BrowserTimeProvider()),
    );
    const source = image;
    configureRootfsOverlayFromImage(worker, {
      imageLength: source.getSize(),
      imageRead: (offset, destination) => source.read(destination, { at: offset }),
      foreignPrefixes: [], nosuid: false,
    });
    await worker.init(kernelWasm);
    let attempts = 0;
    let conversions = 0;
    const files: OverlayGenerationFiles = {
      activationCodec: worker.overlayActivationCodec(),
      sealCodec: worker.overlaySealCodec(),
      listSlots: () => OpfsOverlayStorageFile.listSlots(name),
      open: (slot, file, create) => OpfsOverlayStorageFile.openFile(name, slot, file, create),
      remove: (slot, file) => OpfsOverlayStorageFile.removeFile(name, slot, file),
    };
    selected = await enableBestOverlayGeneration(files, (journal, index, end) => {
      attempts++;
      if (attempts === 1 && injectMemoryRefusal) throw new RejectedOverlayGenerationError(mode, ERRNO.ENOMEM, true);
      if (mode === "fixed") worker.enableFixedRootfsPersistence(journal, index, end);
      else worker.enableResizableRootfsPersistence(journal, index, end);
    }, true, (journal, target, index) => {
      conversions++;
      worker.convertUnindexedRootfsPersistence(journal, target, index, mode === "resizable");
    });
    const initialMemory = worker.rootfsJournalStateMemory();
    let compactions = 0;
    selected = await compactOverlayGenerationForBoot(selected, files, {
      memoryPressure: () => worker.rootfsJournalStateMemory().pressure,
      prepare: target => { compactions++; worker.prepareRootfsPersistenceCompaction(target); },
      checkpoint: index => worker.checkpointPreparedRootfsPersistence(index),
      activate: () => worker.activateRootfsPersistenceCompaction(),
      fail: error => worker.failPersistenceWriter(error),
      cancel: () => worker.cancelRootfsPersistenceCompaction(),
    }, error => { throw error; });
    const visible = new TextDecoder().decode(worker.rootfsReadFile("/state"));
    worker.syncRootfsPersistence();
    result = { visible, attempts, conversions, slot: selected.slot,
      ...(reportMemory ? { initialMemory, finalMemory: worker.rootfsJournalStateMemory(), compactions, ioMemory: worker.rootfsIoMemory() } : {}) };
  } catch (error) {
    failures.push(String(error));
  } finally {
    for (const storage of [selected?.index, selected?.journal, image]) {
      try { storage?.close(); } catch (error) { failures.push(String(error)); }
    }
  }
  self.postMessage(failures.length === 0 ? result : { error: failures.join(" | ") });
};
