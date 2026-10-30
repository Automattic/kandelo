const queuedMessages: MessageEvent[] = [];
self.onmessage = (event) => queuedMessages.push(event);

const name = new URL(self.location.href).searchParams.get("name");
if (name === null) throw new Error("missing persistent overlay name");

const root = await navigator.storage.getDirectory();
const directory = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
const probeName = `overlay-conversion-quota-probe-${crypto.randomUUID()}`;
const probeFile = await directory.getFileHandle(probeName, { create: true });
const probeAccess = await probeFile.createSyncAccessHandle();
const filePrototype = Object.getPrototypeOf(probeFile) as FileSystemFileHandle;
const accessPrototype = Object.getPrototypeOf(probeAccess) as FileSystemSyncAccessHandle;
probeAccess.close();
await directory.removeEntry(probeName);

const originalCreateSyncAccessHandle = filePrototype.createSyncAccessHandle;
const originalWrite = accessPrototype.write;
const targetNames = new Set(["journal", "index", "seal"].map((suffix) => `${name}.g0.${suffix}`));
const targetHandles = new WeakSet<FileSystemSyncAccessHandle>();
let remainingGrowth = 128 * 1024;

filePrototype.createSyncAccessHandle = async function (...args: Parameters<FileSystemFileHandle["createSyncAccessHandle"]>) {
  const access = await originalCreateSyncAccessHandle.apply(this, args);
  if (targetNames.has(this.name)) targetHandles.add(access);
  return access;
};
accessPrototype.write = function (...args: Parameters<FileSystemSyncAccessHandle["write"]>) {
  if (!targetHandles.has(this)) return originalWrite.apply(this, args);
  const [source, options] = args;
  const bytes = source as Uint8Array;
  const oldLength = this.getSize();
  const offset = options?.at ?? oldLength;
  const permitted = Math.max(0, Math.min(bytes.byteLength, oldLength + remainingGrowth - offset));
  if (permitted === 0) throw new DOMException("injected shared overlay quota exhaustion", "QuotaExceededError");
  const written = originalWrite.call(this, bytes.subarray(0, permitted), options);
  remainingGrowth -= Math.max(0, this.getSize() - oldLength);
  return written;
};

await import("../../../../host/src/browser-kernel-worker-entry");
const handleMessage = self.onmessage;
if (handleMessage === null) throw new Error("kernel worker did not install its message handler");
for (const event of queuedMessages) handleMessage.call(self, event);
