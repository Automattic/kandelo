import { installBrowserSetImmediatePolyfill } from "../../../../host/src/browser-immediate-polyfill";
import { acquireBrowserPersistenceJournalLease } from "../../../../host/src/browser-persistence-journal-lease";
import { CentralizedKernelWorker } from "../../../../host/src/kernel-worker";
import { configureRootfsOverlayFromImage } from "../../../../host/src/process-lifecycle";
import { compactOverlayGeneration, enableBestOverlayGeneration, type OverlayGenerationFiles } from "../../../../host/src/vfs/overlay-generation-selection";
import { OpfsOverlayStorageFile } from "../../../../host/src/vfs/overlay-storage";
import { BrowserTimeProvider } from "../../../../host/src/vfs/time";
import { VirtualPlatformIO } from "../../../../host/src/vfs/vfs";

installBrowserSetImmediatePolyfill();

self.onmessage = async ({ data }: MessageEvent<{
  name: string; kernelWasm: ArrayBuffer; base: FileSystemFileHandle; interrupt: boolean;
}>) => {
  const { name, kernelWasm, base, interrupt } = data;
  try {
    const worker = new CentralizedKernelWorker(
      { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true, kernelMaxPages: 1024 },
      new VirtualPlatformIO([], new BrowserTimeProvider()),
    );
    const release = await acquireBrowserPersistenceJournalLease(name);
    let result;
    try {
      const image = await base.createSyncAccessHandle();
      try {
        configureRootfsOverlayFromImage(worker, {
          imageLength: image.getSize(), imageRead: (offset, bytes) => image.read(bytes, { at: offset }),
          foreignPrefixes: [], nosuid: false,
        });
        await worker.init(kernelWasm);
        const reclaimed: string[] = [];
        const files: OverlayGenerationFiles = {
          activationCodec: worker.overlayActivationCodec(), sealCodec: worker.overlaySealCodec(),
          listSlots: () => OpfsOverlayStorageFile.listSlots(name),
          open: async (slot, file, create) => {
            const storage = await OpfsOverlayStorageFile.openFile(name, slot, file, create);
            if (storage !== null && create && slot !== "legacy") {
              const truncate = storage.truncate.bind(storage);
              storage.truncate = length => {
                const wasOccupied = length === 0 && storage.len() > 0;
                truncate(length);
                if (wasOccupied) reclaimed.push(`${slot}.${file}`);
              };
            }
            return storage;
          },
          remove: (slot, file) => OpfsOverlayStorageFile.removeFile(name, slot, file),
        };
        let selected = await enableBestOverlayGeneration(files, (journal, index, end) => {
          worker.enableResizableRootfsPersistence(journal, index, end);
        }, true);
        const source = selected.slot;
        try {
          selected = await compactOverlayGeneration(selected, files, {
            prepare: target => worker.prepareRootfsPersistenceCompaction(target),
            checkpoint: index => worker.checkpointPreparedRootfsPersistence(index),
            activate: () => {
              if (interrupt) {
                // The real publisher has flushed and verified all three target files.
                // Keep ownership live until the test terminates this worker.
                self.postMessage({ stage: "verified-before-activation", source });
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
                throw new Error("discarded storage owner resumed");
              }
              worker.activateRootfsPersistenceCompaction();
            },
            cancel: () => worker.cancelRootfsPersistenceCompaction(),
            fail: error => worker.failPersistenceWriter(error),
          }, 0);
          result = { stage: "activated", source, target: selected.slot, reclaimed: reclaimed.sort() };
        } finally {
          try { selected.index?.close(); }
          finally { selected.journal.close(); }
        }
      } finally {
        image.close();
      }
    } finally {
      try { worker.disposeRootfsDeferredTransport(); }
      finally { await release(); }
    }
    self.postMessage(result);
  } catch (error) { self.postMessage({ error: String(error) }); }
};
