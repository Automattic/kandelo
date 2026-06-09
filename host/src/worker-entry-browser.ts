import { centralizedWorkerMain, centralizedThreadWorkerMain } from "./worker-main";
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage } from "./worker-protocol";

const WORKER_SHUTDOWN_MESSAGE = "__kandelo_worker_shutdown";
const WORKER_SHUTDOWN_ACK_MESSAGE = "__kandelo_worker_shutdown_ack";

// Web Worker global scope
const sw = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  close?: () => void;
};

sw.onmessage = (e: MessageEvent) => {
  const data = e.data as { type: string };
  if (data.type === WORKER_SHUTDOWN_MESSAGE) {
    sw.postMessage({ type: WORKER_SHUTDOWN_ACK_MESSAGE });
    sw.close?.();
    return;
  }

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
    centralizedWorkerMain(port, e.data as CentralizedWorkerInitMessage).catch((err) => {
      console.error(`[worker-entry-browser] centralizedWorkerMain error pid=${(data as any).pid}:`, err);
    });
  } else if (data.type === "centralized_thread_init") {
    centralizedThreadWorkerMain(port, e.data as CentralizedThreadInitMessage).catch((err) => {
      console.error(`[worker-entry-browser] centralizedThreadWorkerMain error:`, err);
    });
  } else {
    throw new Error(`Unknown worker init type: ${data.type}`);
  }
};
