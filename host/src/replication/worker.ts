/**
 * The kernel worker's half of replication.
 *
 * Both worker entries own the same two jobs — publish the decisions a primary
 * makes, and take the decisions a replica follows — and the host runtime
 * contract says Node and the browser are peers. Keeping the two shapes here
 * is what stops one host from batching, waiting, or ending differently from
 * the other.
 */
import {
  ReplicationLogRecorder,
  type ReplicationLogEntry,
  type ReplicationLogExtender,
} from "./log.js";
import { ReplicationLogQueueReader } from "./log-queue.js";

/**
 * Record the machine's decisions and hand each one to the main thread.
 *
 * The recorder keeps nothing. A live replica joins at boot and needs the log
 * from sequence 0, so one holder must keep all of it; streaming makes that
 * holder the main thread, which is where the wire is, instead of leaving a
 * second copy here for as long as the machine runs.
 *
 * Decisions are batched to the microtask that follows them. A guest can read
 * the clock many times inside one syscall burst, and each `postMessage` is a
 * structured clone on a path the guest is waiting on.
 */
export function createStreamingRecorder(
  publish: (entries: readonly ReplicationLogEntry[]) => void,
): ReplicationLogRecorder {
  const recorder = new ReplicationLogRecorder(0, { retain: false });
  let batch: ReplicationLogEntry[] = [];
  recorder.onRecord((entry) => {
    batch.push(entry);
    if (batch.length > 1) return;
    queueMicrotask(() => {
      const sending = batch;
      batch = [];
      publish(sending);
    });
  });
  return recorder;
}

/**
 * Follow a primary that is still running, blocking when the replica catches up.
 *
 * Returns undefined for a replay of a recording that is already complete: that
 * replica has the whole log in hand and reaching its end is the end of the
 * replay, not something to wait for.
 */
export function createQueueExtender(
  queue: SharedArrayBuffer | undefined,
): ReplicationLogExtender | undefined {
  if (queue === undefined) return undefined;
  const reader = new ReplicationLogQueueReader(queue);
  return () => reader.take();
}
