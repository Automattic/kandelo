const queuedMessages: MessageEvent[] = [];
self.onmessage = (event) => queuedMessages.push(event);

const name = new URL(self.location.href).searchParams.get("name");
if (name === null) throw new Error("missing persistent overlay name");

const root = await navigator.storage.getDirectory();
const directory = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
const probeName = `overlay-read-probe-${crypto.randomUUID()}`;
const probeFile = await directory.getFileHandle(probeName, { create: true });
const probeAccess = await probeFile.createSyncAccessHandle();
const filePrototype = Object.getPrototypeOf(probeFile) as any;
const accessPrototype = Object.getPrototypeOf(probeAccess) as any;
probeAccess.close();
await directory.removeEntry(probeName);

const originalCreateSyncAccessHandle = filePrototype.createSyncAccessHandle;
const originalRead = accessPrototype.read;
const reads = new WeakMap<FileSystemSyncAccessHandle, number>();

filePrototype.createSyncAccessHandle = async function (...args: unknown[]) {
  const access = await originalCreateSyncAccessHandle.apply(this, args);
  if (this.name === `${name}.g1.journal`) reads.set(access, 0);
  return access;
};
accessPrototype.read = function (...args: unknown[]) {
  const count = reads.get(this);
  if (count !== undefined) {
    if (count > 0) throw new DOMException("injected journal read failure", "NotReadableError");
    reads.set(this, count + 1);
  }
  return originalRead.apply(this, args);
};

await import("../../../../host/src/browser-kernel-worker-entry");
const handleMessage = self.onmessage;
if (handleMessage === null) throw new Error("kernel worker did not install its message handler");
for (const event of queuedMessages) handleMessage.call(self, event);
