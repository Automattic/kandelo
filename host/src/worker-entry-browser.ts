import { centralizedWorkerMain, centralizedThreadWorkerMain } from "./worker-main";
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage } from "./worker-protocol";
import { runWithProcessWorkerQuiescence } from "./worker-quiescence";
import { isJavaScriptCoreUserAgent } from "./runtime-memory-profile";
import { retainWasmInstancesUntilWorkerEnds } from "./wasm-instance-retention";

// Web Worker global scope
const sw = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  close(): void;
};

// [RUNTIME-WORKAROUND: JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN]
// JavaScriptCore crashes when a sibling grows process memory while an
// instance importing it is destroyed. There, instances live until their
// Worker ends, and an exited thread's Worker stays open (idle) until the
// kernel terminates it with its process. The kernel worker makes the same
// decision from the same user agent.
const instancesOutliveThreads = isJavaScriptCoreUserAgent(navigator.userAgent);
if (instancesOutliveThreads) retainWasmInstancesUntilWorkerEnds();

// Process exit is cooperative through the existing syscall channel: the kernel
// completes the exit syscall, worker-main returns, and this entry publishes an
// exact memory-quiescence fence. There is no separate shutdown postMessage
// handler because a running guest can remain parked inside Wasm Atomics.wait.
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
    close: () => sw.close(),
  };
  if (data.type === "centralized_init") {
    const init = e.data as CentralizedWorkerInitMessage;
    void runWithProcessWorkerQuiescence(
      port,
      { pid: init.pid },
      () => centralizedWorkerMain(port, init),
      (error) =>
        console.error(
          `[worker-entry-browser] worker main error pid=${init.pid}`,
          error,
        ),
    );
  } else if (data.type === "centralized_thread_init") {
    const init = e.data as CentralizedThreadInitMessage;
    void runWithProcessWorkerQuiescence(
      instancesOutliveThreads ? { ...port, close: () => {} } : port,
      { pid: init.pid, tid: init.tid },
      () => centralizedThreadWorkerMain(port, init),
      (error) =>
        console.error(
          `[worker-entry-browser] thread worker main error`
            + ` pid=${init.pid} tid=${init.tid}`,
          error,
        ),
    );
  } else {
    throw new Error(`Unknown worker init type: ${data.type}`);
  }
};
