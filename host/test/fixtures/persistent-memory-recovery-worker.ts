import { parentPort, workerData } from "node:worker_threads";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ERRNO } from "../../src/generated/abi";
import { CentralizedKernelWorker } from "../../src/kernel-worker";
import { NodePlatformIO } from "../../src/platform/node";
import { configureRootfsOverlayFromImage } from "../../src/process-lifecycle";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { compactOverlayGenerationForBoot, enableBestOverlayGeneration, RejectedOverlayGenerationError, type OverlayGenerationFiles, type SelectedOverlayGeneration } from "../../src/vfs/overlay-generation-selection";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";
import { OverlayGenerationMetadata } from "../../src/vfs/overlay-generation-metadata";

const { image, kernelWasm, path, mode, injectMemoryRefusal = true, reportMemory = false } = workerData as {
  image: Uint8Array; kernelWasm: ArrayBuffer; path: string; mode: "fixed" | "resizable";
  injectMemoryRefusal?: boolean; reportMemory?: boolean;
};
let selected: SelectedOverlayGeneration | undefined;
let result: unknown;
const failures: string[] = [];
try {
  const worker = new CentralizedKernelWorker(
    { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true, kernelMaxPages: 1024 }, new NodePlatformIO(),
  );
  configureRootfsOverlayFromImage(worker, {
    imageLength: image.byteLength,
    imageRead: (offset, destination) => {
      const bytes = image.subarray(offset, offset + destination.byteLength);
      destination.set(bytes);
      return bytes.byteLength;
    },
    foreignPrefixes: [], nosuid: false,
  });
  await worker.init(kernelWasm);
  const backend = new HostFileSystem(dirname(path));
  const name = basename(path);
  const files: OverlayGenerationFiles = {
    activationCodec: worker.overlayActivationCodec(),
    sealCodec: worker.overlaySealCodec(),
    metadata: new OverlayGenerationMetadata(worker.rootfsTransportMetadataBudget()),
    listSlots: async () => [...new Set(readdirSync(dirname(path)).flatMap(filename => {
      if (!filename.startsWith(`${name}.`)) return [];
      const slot = /^(g[0-9]+)\.(?:journal|index|seal)$/.exec(filename.slice(name.length + 1));
      return slot === null ? [] : [slot[1]!];
    }))],
    open: async (slot, file, create) => {
      const filename = slot === "legacy" ? file === "journal" ? name : `${name}.${file}` : `${name}.${slot}.${file}`;
      if (!create && !existsSync(join(dirname(path), filename))) return null;
      return OverlayStorageFile.open(backend, `/${filename}`, create, true);
    },
    remove: async () => { throw new Error("memory-recovery selection must not retire a source"); },
  };
  let attempts = 0;
  let conversions = 0;
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
    cancel: () => worker.cancelRootfsPersistenceCompaction(),
    fail: error => worker.failPersistenceWriter(error),
  }, error => { throw error; });
  const visible = new TextDecoder().decode(worker.rootfsReadFile("/state"));
  worker.syncRootfsPersistence();
  result = { visible, attempts, conversions, slot: selected.slot,
    ...(reportMemory ? { initialMemory, finalMemory: worker.rootfsJournalStateMemory(), compactions, ioMemory: worker.rootfsIoMemory() } : {}) };
} catch (error) {
  failures.push(String(error));
} finally {
  for (const storage of [selected?.index, selected?.journal]) {
    try { storage?.close(); } catch (error) { failures.push(String(error)); }
  }
}
parentPort!.postMessage(failures.length === 0 ? result : { error: failures.join(" | ") });
