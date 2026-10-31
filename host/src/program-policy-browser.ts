import workerEntryUrl from "./program-policy-browser-worker.ts?worker&url";
import { initializeBrowserWorker } from "./worker-adapter-browser";
import { ProgramPolicyError, type PolicyWorkerFactory } from "./program-policy";

const MAX_BOOTSTRAP_BYTES = 256 * 1024;

export async function createBrowserPolicyWorkerFactory(): Promise<PolicyWorkerFactory> {
  const response = await fetch(workerEntryUrl);
  if (!response.ok || !response.body) throw new ProgramPolicyError("protocol", `Worker bootstrap fetch failed: ${response.status}`);
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_BOOTSTRAP_BYTES) throw new ProgramPolicyError("workspace", "Worker bootstrap exceeds its limit");
      parts.push(Uint8Array.from(result.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const url = URL.createObjectURL(new Blob(parts, { type: "text/javascript" }));
  let disposed = false;
  return Object.assign((request: Parameters<PolicyWorkerFactory>[0]) => {
    if (disposed) throw new ProgramPolicyError("closed");
    return initializeBrowserWorker(new Worker(url, { type: "module" }), request);
  }, {
    workspaceOverheadBytes: MAX_BOOTSTRAP_BYTES,
    dispose() {
      if (disposed) return;
      URL.revokeObjectURL(url);
      disposed = true;
    },
  });
}
