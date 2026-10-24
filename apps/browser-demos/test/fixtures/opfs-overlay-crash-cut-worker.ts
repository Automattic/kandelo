const queuedMessages: MessageEvent[] = [];
self.onmessage = (event) => queuedMessages.push(event);

const parameters = new URL(self.location.href).searchParams;
const name = parameters.get("name");
const cut = parameters.get("cut");
const torn = parameters.get("torn") === "1";
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
const originalWrite = accessPrototype.write;
const originalClose = accessPrototype.close;
const originalTruncate = accessPrototype.truncate;
const targets = new WeakSet<FileSystemSyncAccessHandle>();
const targetName = `${name}.g0.${cut}`;
let writes = 0;
let tornWrite: { written: number; attempted: number; ordinal: number } | undefined;

function pauseBeforeCleanup(operation: string): void {
  self.postMessage({ type: "overlay_crash_cut", cut, tornWrite, cleanup: operation });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

filePrototype.createSyncAccessHandle = async function (...args: Parameters<FileSystemFileHandle["createSyncAccessHandle"]>) {
  const access = await originalCreateSyncAccessHandle.apply(this, args);
  if (this.name === targetName) targets.add(access);
  return access;
};
accessPrototype.flush = function (...args: Parameters<FileSystemSyncAccessHandle["flush"]>) {
  if (torn && targets.has(this) && tornWrite !== undefined) pauseBeforeCleanup("flush");
  const result = originalFlush.apply(this, args);
  if (!torn && targets.has(this) && this.getSize() > 0) {
    self.postMessage({ type: "overlay_crash_cut", cut });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
accessPrototype.write = function (...args: Parameters<FileSystemSyncAccessHandle["write"]>) {
  if (torn && targets.has(this) && tornWrite === undefined) {
    writes++;
    if (writes === (cut === "index" ? 1 : 2)) {
      const input = args[0];
      const source = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      if (source.byteLength < 2) throw new Error("torn compaction write needs a nontrivial payload");
      const written = originalWrite.call(this, source.subarray(0, Math.floor(source.byteLength / 2)), args[1]);
      if (written <= 0 || written >= source.byteLength) throw new Error("native torn prefix was not written");
      originalFlush.call(this);
      tornWrite = { written, attempted: source.byteLength, ordinal: writes };
      throw new DOMException("injected torn compaction output", "QuotaExceededError");
    }
  }
  return originalWrite.apply(this, args);
};
accessPrototype.close = function (...args: Parameters<FileSystemSyncAccessHandle["close"]>) {
  if (torn && targets.has(this) && tornWrite !== undefined) pauseBeforeCleanup("close");
  return originalClose.apply(this, args);
};
accessPrototype.truncate = function (...args: Parameters<FileSystemSyncAccessHandle["truncate"]>) {
  if (torn && targets.has(this) && tornWrite !== undefined) pauseBeforeCleanup("truncate");
  return originalTruncate.apply(this, args);
};

await import("../../../../host/src/browser-kernel-worker-entry");
const handleMessage = self.onmessage;
if (handleMessage === null) throw new Error("kernel worker did not install its message handler");
for (const event of queuedMessages) handleMessage.call(self, event);
