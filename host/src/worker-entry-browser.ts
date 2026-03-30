import { centralizedWorkerMain, centralizedThreadWorkerMain } from "./worker-main";
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage } from "./worker-protocol";

// Web Worker global scope
const sw = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

sw.onmessage = (e: MessageEvent) => {
  const data = e.data as { type: string };
  const port = {
    postMessage: (msg: unknown, transfer?: unknown[]) =>
      sw.postMessage(msg, transfer as Transferable[]),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "message") {
        sw.onmessage = (ev: MessageEvent) => handler(ev.data);
      }
    },
  };
  if (data.type === "centralized_init") {
    centralizedWorkerMain(port, e.data as CentralizedWorkerInitMessage);
  } else if (data.type === "centralized_thread_init") {
    centralizedThreadWorkerMain(port, e.data as CentralizedThreadInitMessage).catch((err) => {
      console.error(`[worker-entry-browser] centralizedThreadWorkerMain error:`, err);
    });
  } else {
    throw new Error(`Unknown worker init type: ${data.type}`);
  }
};
