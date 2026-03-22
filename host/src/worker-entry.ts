import { parentPort, workerData } from "node:worker_threads";
import { centralizedWorkerMain, centralizedThreadWorkerMain } from "./worker-main";
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage } from "./worker-protocol";

if (parentPort) {
  // Keep the event loop alive while async work completes.
  // Without this, the Worker can exit before promises resolve
  // (e.g. WebAssembly.compile) since there are no active handles.
  parentPort.on("message", () => {});

  const data = workerData as { type: string };
  if (data.type === "centralized_init") {
    centralizedWorkerMain(parentPort, workerData as CentralizedWorkerInitMessage).catch((e) => {
      console.error(`[worker-entry] centralizedWorkerMain error: ${e}`);
    });
  } else if (data.type === "centralized_thread_init") {
    try {
      centralizedThreadWorkerMain(parentPort, workerData as CentralizedThreadInitMessage).catch((e) => {
        console.error(`[worker-entry] centralizedThreadWorkerMain rejected: ${e}`);
      });
    } catch (e) {
      console.error(`[worker-entry] centralizedThreadWorkerMain threw: ${e}`);
    }
  } else {
    throw new Error(`Unknown worker init type: ${data.type}`);
  }
}
