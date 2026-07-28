import { parentPort, workerData } from "node:worker_threads";
import { centralizedWorkerMain, centralizedThreadWorkerMain } from "./worker-main";
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage } from "./worker-protocol";
import { runWithProcessWorkerQuiescence } from "./worker-quiescence";

if (parentPort) {
  // Capture the narrowed port for the asynchronous closure. The top-level
  // import remains nullable because this module can be evaluated outside a
  // worker during tooling, but this activation cannot change realms.
  const port = parentPort;
  const run = async (): Promise<void> => {
    const data = workerData as { type: string };
    if (data.type === "centralized_init") {
      const init = workerData as CentralizedWorkerInitMessage;
      await runWithProcessWorkerQuiescence(
        port,
        { pid: init.pid },
        () => centralizedWorkerMain(port, init),
        (error) =>
          console.error(`[worker-entry] worker main error: ${error}`),
      );
    } else if (data.type === "centralized_thread_init") {
      const init = workerData as CentralizedThreadInitMessage;
      await runWithProcessWorkerQuiescence(
        port,
        { pid: init.pid, tid: init.tid },
        () => centralizedThreadWorkerMain(port, init),
        (error) =>
          console.error(`[worker-entry] thread worker main error: ${error}`),
      );
    } else {
      throw new Error(`Unknown worker init type: ${data.type}`);
    }
  };
  void run();
}
