const queuedMessages: MessageEvent[] = [];
self.onmessage = (event) => queuedMessages.push(event);

const name = new URL(self.location.href).searchParams.get("name");
if (name === null) throw new Error("missing persistent overlay name");
const fault = new URL(self.location.href).searchParams.get("fault");
if (fault !== "write" && fault !== "partial" && fault !== "flush") {
  throw new Error("invalid persistent overlay fault mode");
}
const cutParameter = new URL(self.location.href).searchParams.get("cut");
if (fault === "partial" && (cutParameter === null || !/^(?:[1-9]\d*|-1)$/.test(cutParameter))) {
  throw new Error("invalid persistent overlay partial cut");
}

const root = await navigator.storage.getDirectory();
const directory = await root.getDirectoryHandle("kandelo-persistent-overlay", { create: true });
const probeName = `overlay-quota-probe-${crypto.randomUUID()}`;
const probeFile = await directory.getFileHandle(probeName, { create: true });
const probeAccess = await probeFile.createSyncAccessHandle();
const filePrototype = Object.getPrototypeOf(probeFile) as any;
const accessPrototype = Object.getPrototypeOf(probeAccess) as any;
probeAccess.close();
await directory.removeEntry(probeName);

const originalCreateSyncAccessHandle = filePrototype.createSyncAccessHandle;
const originalWrite = accessPrototype.write;
const originalFlush = accessPrototype.flush;
const journalName = `${name}.journal`;
const journals = new WeakSet<FileSystemSyncAccessHandle>();
let armed = false;
let injected = false;

filePrototype.createSyncAccessHandle = async function (...args: unknown[]) {
  const access = await originalCreateSyncAccessHandle.apply(this, args);
  if (this.name === journalName) journals.add(access);
  return access;
};
accessPrototype.flush = function (...args: unknown[]) {
  if (journals.has(this) && armed && !injected && fault === "flush") {
    injected = true;
    throw new DOMException("injected journal quota exhaustion", "QuotaExceededError");
  }
  const result = originalFlush.apply(this, args);
  if (journals.has(this)) armed = true;
  return result;
};
accessPrototype.write = function (...args: unknown[]) {
  if (journals.has(this) && armed && !injected && fault !== "flush") {
    injected = true;
    if (fault === "partial") {
      const source = args[0] as Uint8Array;
      const cut = Number(cutParameter) === -1 ? source.byteLength - 1 : Number(cutParameter);
      if (cut >= source.byteLength) throw new Error("partial cut must precede the transaction end");
      originalWrite.call(this, source.subarray(0, cut), args[1]);
    }
    throw new DOMException("injected journal quota exhaustion", "QuotaExceededError");
  }
  return originalWrite.apply(this, args);
};

await import("../../../../host/src/browser-kernel-worker-entry");
const handleMessage = self.onmessage;
if (handleMessage === null) throw new Error("kernel worker did not install its message handler");
for (const event of queuedMessages) handleMessage.call(self, event);
