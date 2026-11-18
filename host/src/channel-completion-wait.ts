import { CHANNEL_STATUS_PENDING } from "./generated/abi";

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
 * and heap-safepoint policy; these JavaScript-generated waits stay unbounded.
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
  for (;;) {
    const result = wait32(statusAddress, CHANNEL_STATUS_PENDING, -1n);
    if (result === 1) return; // The status no longer matches PENDING.
    if (result !== 0 && result !== 2) throw new Error('Invalid translated channel wait result');
    // Notifications can be spurious. The next native helper checks the word
    // again and supplies its replica checkpoint even for an early completion.
  }
}
