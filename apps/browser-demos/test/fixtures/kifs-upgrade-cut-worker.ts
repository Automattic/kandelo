import { installBrowserSetImmediatePolyfill } from "../../../../host/src/browser-immediate-polyfill";
import { acquireBrowserPersistenceJournalLease } from "../../../../host/src/browser-persistence-journal-lease";
import { CentralizedKernelWorker } from "../../../../host/src/kernel-worker";
import { configureRootfsOverlayFromImage } from "../../../../host/src/process-lifecycle";
import { OpfsOverlayStorageFile } from "../../../../host/src/vfs/overlay-storage";
import { BrowserTimeProvider } from "../../../../host/src/vfs/time";
import { VirtualPlatformIO } from "../../../../host/src/vfs/vfs";
import { inspectOpfsJournalBinding } from "../../../../host/src/vfs/opfs-journal-binding";
import { runUpgradeOwner, type OwnerAction } from "../../../../host/test/fixtures/kifs-upgrade-cuts";

installBrowserSetImmediatePolyfill();
self.onmessage = async ({ data }: MessageEvent<{
  name: string; action: OwnerAction; base: FileSystemFileHandle; identity: string; kernelWasm: ArrayBuffer;
}>) => {
  try {
    const release = await acquireBrowserPersistenceJournalLease(data.name);
    let result;
    try {
      const image = await data.base.createSyncAccessHandle();
      const worker = new CentralizedKernelWorker(
        { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true, kernelMaxPages: 1024 },
        new VirtualPlatformIO([], new BrowserTimeProvider()),
      );
      try {
        configureRootfsOverlayFromImage(worker, {
          imageLength: image.getSize(), imageRead: (offset, bytes) => {
            if (data.action === "reopen") throw new Error("active volume boot read its checked base");
            return image.read(bytes, { at: offset });
          },
          persistentImageBinding: { identitySha256: data.identity, dataCachePages: 1, indexCachePages: 1 },
          foreignPrefixes: [], nosuid: false,
        });
        await worker.init(data.kernelWasm, true);
        if (data.action === "recover") {
          await inspectOpfsJournalBinding(data.name, data.identity, worker.overlayActivationCodec(), () => worker.overlaySealCodec());
        }
        result = await runUpgradeOwner(worker, {
          activationCodec: worker.overlayActivationCodec(), sealCodec: worker.overlaySealCodec(),
          listSlots: () => OpfsOverlayStorageFile.listSlots(data.name),
          open: (slot, file, create) => OpfsOverlayStorageFile.openFile(data.name, slot, file, create),
          remove: (slot, file) => OpfsOverlayStorageFile.removeFile(data.name, slot, file),
        }, data.action, message => self.postMessage(message));
      } finally { worker.disposeRootfsDeferredTransport(); image.close(); }
    } finally { await release(); }
    self.postMessage(result);
  } catch (error) { self.postMessage({ error: String(error) }); }
};
