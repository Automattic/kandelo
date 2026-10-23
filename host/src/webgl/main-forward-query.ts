// Adapted from Brandon Payton's generic-kms-gles-runtime query transport.
// One reusable, independent device mailbox per channel. Never put guest
// memory or a view of it in the persistent browser realm.
export const GL_FORWARD_QUERY_MAX_BYTES = 64 * 1024; // shared::gl query caps
export const GL_FORWARD_QUERY_TIMEOUT_MS = 30_000;
const HEADER_BYTES = 20;
const STATE = 0, RC = 1, CAPACITY = 2, REQUESTED = 3, WRITTEN = 4;
const IDLE = 0, PENDING = 1, COMPLETE = 2, RETIRED = 3;

function header(mailbox: SharedArrayBuffer): Int32Array {
  if (!(mailbox instanceof SharedArrayBuffer) || mailbox.byteLength < HEADER_BYTES) {
    throw new RangeError("invalid GL query mailbox");
  }
  const words = new Int32Array(mailbox, 0, HEADER_BYTES / 4);
  const capacity = Atomics.load(words, CAPACITY);
  if (capacity < 0 || capacity > GL_FORWARD_QUERY_MAX_BYTES
      || mailbox.byteLength !== HEADER_BYTES + capacity) {
    throw new RangeError("invalid GL query mailbox capacity");
  }
  return words;
}

export function createGlForwardQueryMailbox(): SharedArrayBuffer {
  const mailbox = new SharedArrayBuffer(HEADER_BYTES + GL_FORWARD_QUERY_MAX_BYTES);
  Atomics.store(new Int32Array(mailbox, 0, 5), CAPACITY, GL_FORWARD_QUERY_MAX_BYTES);
  return mailbox;
}

export function prepareGlForwardQuery(mailbox: SharedArrayBuffer, outLen: number): void {
  const words = header(mailbox);
  const state = Atomics.load(words, STATE);
  if (state !== IDLE && state !== COMPLETE) throw new Error("GL query mailbox is busy or retired");
  if (!Number.isSafeInteger(outLen) || outLen < 0 || outLen > Atomics.load(words, CAPACITY)) {
    throw new RangeError("GL query output exceeds the kernel query cap");
  }
  Atomics.store(words, REQUESTED, outLen);
  Atomics.store(words, RC, 0);
  Atomics.store(words, WRITTEN, 0);
  Atomics.store(words, STATE, PENDING);
}

export function glForwardQueryCapacity(mailbox: SharedArrayBuffer): number {
  const words = header(mailbox);
  const requested = Atomics.load(words, REQUESTED);
  if (requested < 0 || requested > Atomics.load(words, CAPACITY)) {
    throw new RangeError("invalid GL query output length");
  }
  return requested;
}

export function completeGlForwardQuery(mailbox: SharedArrayBuffer, rc: number, bytes: Uint8Array): void {
  const words = header(mailbox);
  // A late completion has no authority to revive a timed-out channel.
  if (Atomics.load(words, STATE) === RETIRED) return;
  if (Atomics.load(words, STATE) !== PENDING) throw new Error("GL query is not pending");
  if (!Number.isSafeInteger(rc) || rc < -0x8000_0000 || rc > 0x7fff_ffff) {
    throw new RangeError("invalid GL query result");
  }
  const written = Math.max(0, rc);
  if (written > glForwardQueryCapacity(mailbox) || written > bytes.byteLength) {
    throw new RangeError("GL query result exceeds capacity");
  }
  new Uint8Array(mailbox, HEADER_BYTES, written).set(bytes.subarray(0, written));
  Atomics.store(words, RC, rc);
  Atomics.store(words, WRITTEN, written);
  Atomics.compareExchange(words, STATE, PENDING, COMPLETE);
  Atomics.notify(words, STATE);
}

export function retireGlForwardQuery(mailbox: SharedArrayBuffer): void {
  const words = header(mailbox);
  Atomics.store(words, STATE, RETIRED);
  Atomics.notify(words, STATE);
}

/** Called only in the dedicated kernel worker; the main thread completes. */
export function waitForGlForwardQuery(mailbox: SharedArrayBuffer): { rc: number; bytes: Uint8Array } {
  const words = header(mailbox);
  const failure = () => ({ rc: -5, bytes: new Uint8Array() });
  const deadline = performance.now() + GL_FORWARD_QUERY_TIMEOUT_MS;
  while (Atomics.load(words, STATE) === PENDING) {
    const remaining = deadline - performance.now();
    if (remaining <= 0 || Atomics.wait(words, STATE, PENDING, remaining) === "timed-out") {
      // If completion won the race, consume it. Otherwise permanently retire;
      // reusing after a timeout could confuse a late reply with a new query.
      Atomics.compareExchange(words, STATE, PENDING, RETIRED);
      break;
    }
  }
  if (Atomics.load(words, STATE) !== COMPLETE) return failure();
  const rc = Atomics.load(words, RC), written = Atomics.load(words, WRITTEN);
  if (written !== Math.max(0, rc) || written > glForwardQueryCapacity(mailbox)) {
    retireGlForwardQuery(mailbox);
    return failure();
  }
  return { rc, bytes: new Uint8Array(mailbox, HEADER_BYTES, written).slice() };
}
