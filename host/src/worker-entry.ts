import { parentPort, workerData } from "node:worker_threads";
import { centralizedWorkerMain } from "./worker-main";
import type { CentralizedWorkerInitMessage } from "./worker-protocol";

if (parentPort) {
  const data = workerData as { type: string };
  if (data.type === "centralized_init") {
    centralizedWorkerMain(parentPort, workerData as CentralizedWorkerInitMessage).catch((e) => {
      console.error(`[worker-entry] centralizedWorkerMain error: ${e}`);
    });
  } else {
    throw new Error(`Unknown worker init type: ${data.type}`);
  }
}
