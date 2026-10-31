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
