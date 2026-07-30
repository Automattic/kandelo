import { parentPort, workerData } from "node:worker_threads";
import { centralizedWorkerMain, centralizedThreadWorkerMain } from "./worker-main";
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage } from "./worker-protocol";
import { runWithProcessWorkerQuiescence } from "./worker-quiescence";
import { isNodeWorkerInitByMessage } from "./node-worker-initialization";

/** @internal Exported so one-shot process-init ownership can be tested. */
export function receiveNodeWorkerInit(
  port: {
    once(event: "message", listener: (value: unknown) => void): unknown;
  },
  workerDataValue: unknown,
): Promise<unknown> {
  // WHY: `wasm-posix-host/worker-entry` is a public entry point. Existing
  // embedders may start it directly with workerData, while Kandelo's built-in
  // adapter deliberately keeps process memory out of Node's workerData startup
  // path and sends one message instead.
  if (isNodeWorkerInitByMessage(workerDataValue)) {
    return new Promise<unknown>((resolve) => port.once("message", resolve));
  }
  if (workerDataValue === undefined) {
    return Promise.reject(new Error("Node worker initialization is missing"));
  }
  return Promise.resolve(workerDataValue);
}

if (parentPort) {
  // Capture the narrowed port for the asynchronous closure. The top-level
  // import remains nullable because this module can be evaluated outside a
  // worker during tooling, but this activation cannot change realms.
  const port = parentPort;
  const run = async (): Promise<void> => {
    // WHY: default process init carries Shared WebAssembly.Memory through one
    // ordinary message, so its listener is gone before guest execution. The
    // public entry also accepts workerData from existing direct callers.
    const initData = await receiveNodeWorkerInit(port, workerData);
    const data = initData as { type: string };
    if (data.type === "centralized_init") {
      const init = initData as CentralizedWorkerInitMessage;
      await runWithProcessWorkerQuiescence(
        port,
        { pid: init.pid },
        () => centralizedWorkerMain(port, init),
        (error) =>
          console.error(`[worker-entry] worker main error: ${error}`),
      );
    } else if (data.type === "centralized_thread_init") {
      const init = initData as CentralizedThreadInitMessage;
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
