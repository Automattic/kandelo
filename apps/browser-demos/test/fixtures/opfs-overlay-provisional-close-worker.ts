import { StorageCloseLedger } from "../../../../host/src/storage-close-ledger";

const queuedMessages: MessageEvent[] = [];
self.onmessage = (event) => queuedMessages.push(event);

const parameters = new URL(self.location.href).searchParams;
const name = parameters.get("name");
if (name === null || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)) {
  throw new Error("invalid provisional-storage test name");
}
const fault = parameters.get("fault");
if (fault !== "provisional-read" && fault !== "provisional-read-close"
  && fault !== "early-image" && fault !== "early-image-close"
  && fault !== "snapshot-acquire" && fault !== "snapshot-acquire-close") {
  throw new Error("invalid provisional-storage test fault");
}

const directory = await (await navigator.storage.getDirectory())
  .getDirectoryHandle("kandelo-persistent-overlay", { create: true });
const probeName = `provisional-close-probe-${crypto.randomUUID()}`;
const probeFile = await directory.getFileHandle(probeName, { create: true });
const probeHandle = await probeFile.createSyncAccessHandle();
const filePrototype = Object.getPrototypeOf(probeFile) as FileSystemFileHandle;
const accessPrototype = Object.getPrototypeOf(probeHandle) as FileSystemSyncAccessHandle;
probeHandle.close();
await directory.removeEntry(probeName);

const originalCreate = filePrototype.createSyncAccessHandle;
const originalFlush = accessPrototype.flush;
const originalSize = accessPrototype.getSize;
const originalClose = accessPrototype.close;
const handles = new WeakMap<FileSystemSyncAccessHandle, string>();
const journalName = `${name}.journal`;
let armed = false;
let injected = false;
let releaseSnapshotAcquisition: (() => void) | undefined;
const originalRetirement = StorageCloseLedger.prototype.beginRetirement;
StorageCloseLedger.prototype.beginRetirement = function () {
  const drained = originalRetirement.call(this);
  const release = releaseSnapshotAcquisition;
  releaseSnapshotAcquisition = undefined;
  release?.();
  return drained;
};

function report(event: string, file: string): void {
  self.postMessage({
    type: "host_diagnostic",
    pid: 0,
    source: "provisional storage fault fixture",
    message: JSON.stringify({ event, file }),
  });
}

filePrototype.createSyncAccessHandle = async function (
  ...arguments_: Parameters<FileSystemFileHandle["createSyncAccessHandle"]>
) {
  const handle = await originalCreate.apply(this, arguments_);
  if (this.name.startsWith(`${name}.`)) {
    handles.set(handle, this.name);
    report("opened", this.name);
  }
  if (this.name === `${name}.snapshot` && fault.startsWith("snapshot-acquire")) {
    const pending = new Promise<void>(resolve => { releaseSnapshotAcquisition = resolve; });
    report("snapshot-acquisition-held", this.name);
    await pending;
  }
  return handle;
};

accessPrototype.flush = function () {
  const result = originalFlush.call(this);
  if (handles.get(this) === journalName) {
    armed = true;
    report("journal-flushed", journalName);
  }
  return result;
};

accessPrototype.getSize = function () {
  if (handles.get(this) === journalName && armed && !injected && fault.startsWith("provisional-read")) {
    injected = true;
    report("provisional-read-refused", journalName);
    throw new DOMException("injected provisional journal size failure", "UnknownError");
  }
  return originalSize.call(this);
};

accessPrototype.close = function () {
  const file = handles.get(this);
  if ((file === journalName && injected && fault === "provisional-read-close")
    || (file === `${name}.base` && fault === "early-image-close")
    || (file === `${name}.snapshot` && fault === "snapshot-acquire-close")) {
    report("close-refused", file);
    throw new DOMException("injected provisional storage close failure", "UnknownError");
  }
  const result = originalClose.call(this);
  if (file !== undefined) report("closed", file);
  return result;
};

await import("../../../../host/src/browser-kernel-worker-entry");
const handleMessage = self.onmessage;
if (handleMessage === null) throw new Error("kernel worker did not install its message handler");
for (const event of queuedMessages) handleMessage.call(self, event);
