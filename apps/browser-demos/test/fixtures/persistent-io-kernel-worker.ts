import "../../../../host/src/browser-kernel-worker-entry";

const reads = new Map<string, { bytes: number; calls: number; maxRequest: number; touchedPayload: boolean }>();
const guards = new Map<string, { start: number; end: number }>();
const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...options: Parameters<typeof open>) {
  const handle = await open.apply(this, options);
  const name = this.name;
  const read = handle.read;
  handle.read = (destination, position) => {
    const count = read.call(handle, destination, position);
    const record = reads.get(name) ?? { bytes: 0, calls: 0, maxRequest: 0, touchedPayload: false };
    record.bytes += count;
    record.calls++;
    record.maxRequest = Math.max(record.maxRequest, destination.byteLength);
    const guard = guards.get(name);
    const start = position?.at ?? 0;
    if (guard !== undefined && start < guard.end && start + count > guard.start) record.touchedPayload = true;
    reads.set(name, record);
    return count;
  };
  return handle;
};
self.addEventListener("message", event => {
  const message = event as MessageEvent;
  if (message.data?.type === "kandelo-test-storage-guards") {
    event.stopImmediatePropagation();
    for (const [name, guard] of message.data.guards) guards.set(name, guard);
    return;
  }
  if (message.data?.type !== "kandelo-test-storage-stats") return;
  event.stopImmediatePropagation();
  message.ports[0].postMessage([...reads]);
  message.ports[0].close();
}, true);
