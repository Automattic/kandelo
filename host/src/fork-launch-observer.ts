import type { WorkerHandle } from "./worker-adapter";
import type { WorkerToHostMessage } from "./worker-protocol";

/**
 * Watch an ordinary fork child's Worker until the kernel decides its launch.
 *
 * The kernel owns the launch: the child's replay reports
 * `SYS_FORK_REPLAY_READY`, or the child dies first, and either way the kernel
 * completes the parent (`launchDecided`). What the kernel cannot see is a
 * Worker that failed or exited before its replay got there. This turns that
 * into a rejection, so the launch can be reported with
 * `kernel_fork_launch_failed` and the parent's fork() returns an errno
 * instead of waiting forever. `onFailure` runs synchronously, before the
 * host's ordinary exit listeners, so they do not also treat the Worker as a
 * process death. Once the kernel has decided, a Worker ending is ordinary.
 */
export function observeForkLaunchWorker(
  worker: WorkerHandle,
  pid: number,
  launchDecided: Promise<number>,
  onFailure: () => void,
): Promise<never> {
  let decided = false;
  void launchDecided.then(() => { decided = true; });
  const failure = new Promise<never>((_resolve, reject) => {
    const fail = (detail: string): void => {
      if (decided) return;
      decided = true;
      onFailure();
      reject(new Error(`fork child pid=${pid}: ${detail} before replay readiness`));
    };
    worker.on("message", (raw: unknown) => {
      const message = raw as Partial<WorkerToHostMessage>;
      if (message.type === "error" && message.pid === pid) {
        fail(`Worker failed: ${message.message ?? "unknown error"}`);
      } else if (message.type === "exit" && message.pid === pid) {
        fail(`Worker exited (status=${String(message.status)})`);
      }
    });
    worker.on("error", (error: Error) => fail(`Worker error: ${error.message}`));
    worker.on("exit", (code: number) => fail(`Worker exited (code=${code})`));
  });
  // A launch the host abandons (a stale or dead start) terminates the Worker
  // without awaiting this; that rejection is expected, not unhandled.
  void failure.catch(() => {});
  return failure;
}
