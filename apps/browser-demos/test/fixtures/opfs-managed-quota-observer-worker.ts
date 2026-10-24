import "../../../../host/src/browser-kernel-worker-entry";

const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...parameters: Parameters<typeof open>) {
  const handle = await open.apply(this, parameters);
  if (!this.name.endsWith(".journal")) return handle;
  const name = this.name;
  let observed = false;
  const report = (operation: string, error: unknown) => {
    if (observed || !(error instanceof DOMException) || error.name !== "QuotaExceededError") return;
    observed = true;
    self.postMessage({ type: "kandelo-test-managed-quota", name, operation, exception: error.name });
  };
  const write = handle.write;
  handle.write = (...arguments_: Parameters<typeof write>) => {
    try { return write.apply(handle, arguments_); }
    catch (error) { report("write", error); throw error; }
  };
  const truncate = handle.truncate;
  handle.truncate = (...arguments_: Parameters<typeof truncate>) => {
    try { return truncate.apply(handle, arguments_); }
    catch (error) { report("truncate", error); throw error; }
  };
  const flush = handle.flush;
  handle.flush = () => {
    try { return flush.call(handle); }
    catch (error) { report("flush", error); throw error; }
  };
  return handle;
};
