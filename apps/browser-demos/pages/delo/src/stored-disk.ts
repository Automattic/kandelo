// The files of a stored computer, as image bytes. A computer that never
// booted still has the disk Delo wrote for it. A computer that booted keeps
// its files as a saved image plus a journal of later writes, and only a
// kernel replays that journal: Delo starts one without any process, exports
// the filesystem, and closes it. The caller holds the computer's lease.

import kernelWasmUrl from "@kernel-wasm?url";

import { BrowserKernel } from "../../../../../host/src/browser-kernel-host";
import { browserComputerStorageName } from "../../../../../host/src/browser-computer-storage";
import { detectRuntimeMemoryProfile } from "../../../../../host/src/runtime-memory-profile";
import type { acquireBrowserPersistenceComputerLease } from "../../../../../host/src/browser-persistence-computer-lease";
import type { BrowserComputerStore } from "../../../../../web-libs/kandelo-session/src/browser-computer-store";
import { filesystemProfileId, type StoredComputer } from "../../../../../web-libs/kandelo-session/src/computer-library";
import { loadFixedPersistenceImageHandle } from "../../kandelo/kernel-host/fixed-persistence-image";
import { vfsImageUrlFromDescriptor } from "../../kandelo/url-state";
import { deloLazyDirectory } from "./lazy-directory";

type Lease = Awaited<ReturnType<typeof acquireBrowserPersistenceComputerLease>>;

// The identity Kandelo saved the filesystem under: a copy of
// `persistenceIdentity` in pages/kandelo/kernel-host/live-setup.ts, which
// Kandelo does not export (kandelo-problems.md). The saved image opens only
// under the exact identity it was saved with, keys in the same order.
const persistenceIdentity = (computer: StoredComputer) => JSON.stringify({
  vfsUrl: vfsImageUrlFromDescriptor(computer.descriptor) ?? "",
  profileId: filesystemProfileId(computer),
  appPath: import.meta.env.BASE_URL + "computer",
  proto: window.location.protocol === "https:" ? "https" : "http",
  preforkServiceProcesses: detectRuntimeMemoryProfile({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }).preforkServiceProcesses,
  mounts: computer.descriptor.mounts,
  persistenceMode: "resizable",
});

async function replayedImage(computer: StoredComputer, lease: Lease, onState: (state: string) => void) {
  const name = browserComputerStorageName(computer.id);
  const handle = await loadFixedPersistenceImageHandle(name, persistenceIdentity(computer));
  if (handle === null) throw new Error(`${computer.title} has no saved filesystem`);
  onState("starting kernel");
  const response = await fetch(kernelWasmUrl);
  if (!response.ok) throw new Error(`kernel.wasm: ${response.status} ${response.statusText}`);
  const kernel = new BrowserKernel({ kernelOwnedFs: true });
  let image: Uint8Array;
  try {
    onState("replaying journal");
    await kernel.initFromOpfsImage({
      kernelWasm: await response.arrayBuffer(),
      vfsImageFile: handle.file,
      persistentImageBinding: handle.persistentImageBinding,
      lazyAssetDirectory: deloLazyDirectory(handle.lazyAssets),
      experimentalResizablePersistenceName: handle.journalName,
      persistentComputerName: name,
      persistenceComputerLease: lease,
      requireExistingRootfsPersistence: true,
    });
    onState("kernel running");
    image = await kernel.exportRootfsImage();
  } finally {
    onState("closing kernel");
    await kernel.destroy();
  }
  const failure = kernel.getPersistenceShutdownFailure();
  if (failure !== null) throw new Error(`the kernel could not close the saved filesystem: ${failure}`);
  return image as Uint8Array<ArrayBuffer>;
}

export async function readStoredDisk(store: BrowserComputerStore, computer: StoredComputer, lease: Lease, onState: (state: string) => void): Promise<Uint8Array<ArrayBuffer>> {
  return await store.filesystemInitialized(computer.id)
    ? replayedImage(computer, lease, onState)
    : new Uint8Array(await (await store.diskImage(computer.id)).arrayBuffer());
}
