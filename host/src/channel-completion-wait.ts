import { CHANNEL_STATUS_PENDING } from "./generated/abi";
import { createHeapSafepointImport, HEAP_SAFEPOINT_INTERVAL_NS } from "./heap-safepoint";

/**
 * Wait synchronously on one caller-borrowed channel status word.
 *
 * WHY: a notify can be spurious while the request remains pending. Re-enter
 * the native wait until it observes another status, without resetting the
 * mailbox or interpreting its result, signal, retirement, or error fields.
 * The view belongs to this call only; it is neither cached nor retained.
 *
 * This routine supplies no execution hold, writer registration, or proof that
 * process memory is unchanged. The C glue retains its separate bounded wait
 * and heap-safepoint policy; this ordinary JavaScript helper stays unbounded.
 */
export function waitForChannelCompletion(
  words: Int32Array,
  statusIndex: number,
): void {
  while (Atomics.wait(words, statusIndex, CHANNEL_STATUS_PENDING) === "ok") {
    // A wake alone does not complete the request.
  }
}

/** Internal grouped Worker path. Bind the admitted instance's native C export
 * to its exact root and replica. It translates this virtual byte address on
 * every call, registers an owned queue node and checks pause/stop before source
 * re-entry. A plain native wait on group storage would evade those controls.
 */
export function waitForGroupedChannelCompletion(
  wait32: (address: number, expected: number, timeout: bigint) => number,
  statusAddress: number,
): void {
  // [RUNTIME-WORKAROUND: JSC-BLOCKED-WAIT-GC-STARVATION] Match the libc
  // channel's heap policy for this private IPC wait. This is not a guest
  // atomic-wait operation: its request remains pending across safepoints;
  // translated source waits keep their original native timeout and FIFO.
  let bound = HEAP_SAFEPOINT_INTERVAL_NS;
  let heapSafepoint: (() => bigint) | undefined;
  for (;;) {
    const result = wait32(statusAddress, CHANNEL_STATUS_PENDING, bound);
    if (result === 1) return; // The status no longer matches PENDING.
    if (result !== 0 && result !== 2) throw new Error('Invalid translated channel wait result');
    if (result === 2) bound = (heapSafepoint ??= createHeapSafepointImport())();
    // Notifications can be spurious. The next native helper checks the word
    // again and supplies its replica checkpoint even for an early completion.
  }
}
