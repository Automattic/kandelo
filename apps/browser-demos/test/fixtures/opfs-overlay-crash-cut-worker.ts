const queuedMessages: MessageEvent[] = [];
self.onmessage = (event) => queuedMessages.push(event);

const parameters = new URL(self.location.href).searchParams;
const name = parameters.get("name");
const cut = parameters.get("cut");
if (name === null || (cut !== "journal" && cut !== "index" && cut !== "seal")) throw new Error("invalid overlay crash cut");

const root = await navigator.storage.getDirectory();
const directory = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
const probeName = `overlay-crash-cut-probe-${crypto.randomUUID()}`;
const probeFile = await directory.getFileHandle(probeName, { create: true });
const probeAccess = await probeFile.createSyncAccessHandle();
const filePrototype = Object.getPrototypeOf(probeFile) as FileSystemFileHandle;
const accessPrototype = Object.getPrototypeOf(probeAccess) as FileSystemSyncAccessHandle;
probeAccess.close();
await directory.removeEntry(probeName);

const originalCreateSyncAccessHandle = filePrototype.createSyncAccessHandle;
const originalFlush = accessPrototype.flush;
const targets = new WeakSet<FileSystemSyncAccessHandle>();
const targetName = `${name}.g0.${cut}`;

filePrototype.createSyncAccessHandle = async function (...args: Parameters<FileSystemFileHandle["createSyncAccessHandle"]>) {
  const access = await originalCreateSyncAccessHandle.apply(this, args);
  if (this.name === targetName) targets.add(access);
  return access;
};
accessPrototype.flush = function (...args: Parameters<FileSystemSyncAccessHandle["flush"]>) {
  const result = originalFlush.apply(this, args);
  if (targets.has(this) && this.getSize() > 0) {
    self.postMessage({ type: "overlay_crash_cut", cut });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};

await import("../../../../host/src/browser-kernel-worker-entry");
const handleMessage = self.onmessage;
if (handleMessage === null) throw new Error("kernel worker did not install its message handler");
for (const event of queuedMessages) handleMessage.call(self, event);
