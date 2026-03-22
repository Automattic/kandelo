import { centralizedWorkerMain } from "./worker-main";
import type { CentralizedWorkerInitMessage } from "./worker-protocol";

// Web Worker / Service Worker global scope
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
  } else {
    throw new Error(`Unknown worker init type: ${data.type}`);
  }
};
