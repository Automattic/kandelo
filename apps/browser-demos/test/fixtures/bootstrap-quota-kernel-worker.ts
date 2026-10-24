import { BROWSER_MITM_CA_BUNDLE_PATH } from "../../../../host/src/networking/browser-mitm-ca-env";
import "../../../../host/src/browser-kernel-worker-entry";

let refuseFlush = false;
let refusedFlushes = 0;
const certificateName = BROWSER_MITM_CA_BUNDLE_PATH.split("/").at(-1)!;
const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
FileSystemFileHandle.prototype.createSyncAccessHandle = async function (...parameters: Parameters<typeof open>) {
  const handle = await open.apply(this, parameters);
  if (this.name.endsWith(".journal")) {
    const write = handle.write;
    handle.write = (source, position) => {
      const bytes = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
      if (new TextDecoder().decode(new Uint8Array(bytes)).includes(certificateName)) refuseFlush = true;
      return write.call(handle, source, position);
    };
    const flush = handle.flush;
    handle.flush = () => {
      if (refuseFlush) {
        refuseFlush = false;
        refusedFlushes++;
        self.postMessage({ type: "kandelo-test-bootstrap-quota", exception: "QuotaExceededError", refusedFlushes });
        throw new DOMException("injected bootstrap journal quota", "QuotaExceededError");
      }
      return flush.call(handle);
    };
  }
  return handle;
};
