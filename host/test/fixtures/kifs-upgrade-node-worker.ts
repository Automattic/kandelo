import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { CentralizedKernelWorker } from "../../src/kernel-worker";
import { NodePlatformIO } from "../../src/platform/node";
import { configureRootfsOverlayFromImage } from "../../src/process-lifecycle";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { NodeImageReader } from "../../src/vfs/node-image-reader";
import { OverlayStorageFile } from "../../src/vfs/overlay-storage";
import { runUpgradeOwner } from "./kifs-upgrade-cuts";

const { directory, identity, kernelPath, action } = workerData;
const image = NodeImageReader.open(join(directory, "base.img"), undefined, true);
const worker = new CentralizedKernelWorker(
  { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true, kernelMaxPages: 1024 }, new NodePlatformIO(),
);
try {
  configureRootfsOverlayFromImage(worker, {
    imageLength: image.length, imageRead: (offset, bytes) => {
      if (action === "reopen") throw new Error("active volume boot read its checked base");
      return image.readAt(offset, bytes);
    },
    persistentImageBinding: { identitySha256: identity, dataCachePages: 1, indexCachePages: 1 },
    foreignPrefixes: [], nosuid: false,
  });
  await worker.init(Uint8Array.from(readFileSync(kernelPath)).buffer, true);
  const backend = new HostFileSystem(directory);
  const report = (result: unknown) => parentPort!.postMessage(result);
  const result = await runUpgradeOwner(worker, {
    activationCodec: worker.overlayActivationCodec(), sealCodec: worker.overlaySealCodec(),
    listSlots: () => readdirSync(directory).flatMap(name => /^(g[0-9]+)\.(?:journal|index|seal)$/.exec(name)?.[1] ?? []),
    open: async (slot, kind, create) => !create && !existsSync(join(directory, `${slot}.${kind}`))
      ? null : OverlayStorageFile.open(backend, `/${slot}.${kind}`, create, true),
    remove: async (slot, kind) => { rmSync(join(directory, `${slot}.${kind}`), { force: true }); },
  }, action, report);
  report(result);
} finally {
  worker.disposeRootfsDeferredTransport();
  image.close();
}
