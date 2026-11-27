/**
 * A single-producer, single-consumer byte ring over a SharedArrayBuffer,
 * between the kernel worker and one device worker.
 *
 * Ownership: whoever creates the ring owns its buffer and hands it to the
 * other side; each side attaches with `new ByteRing(buffer)` and uses only
 * its own half of the API (producer: `push`, `wakeConsumer`, `blocked`;
 * consumer: `pop`, `idle`, `wakeProducer`). The ring carries host-transport
 * bytes only, never guest memory or a guest Memory.
 *
 * WHY a ring plus doorbells, and no `Atomics.wait`: a device worker must
 * never block (it owns a renderer and its own event loop), and the kernel
 * never waits on a device. So neither side sleeps on the ring; each sleeps
 * in its event loop and is woken by a payload-free MessagePort message (a
 * doorbell). The two flag words make the doorbell edge exact: the consumer
 * marks itself idle only after it re-checks that the ring is empty, and the
 * producer rings only when it takes that mark after a push, so a record can
 * never land unseen between the consumer's last pop and its going idle. The
 * same handshake runs in reverse for a producer waiting for room.
 *
 * Layout: four Int32 words -- head, tail (free-running byte counters, mod
 * 2^32), consumer-idle, producer-blocked -- then the data region. Each
 * record is a 4-byte little-endian length and its bytes, either of which may
 * wrap around the end of the data region.
 */

/** Data capacity of a device ring. */
export const RING_DATA_BYTES = 64 * 1024;

const HEAD = 0, TAIL = 1, CONSUMER_IDLE = 2, PRODUCER_BLOCKED = 3;
const CONTROL_BYTES = 16;
const PREFIX = 4;

export class ByteRing {
  readonly buffer: SharedArrayBuffer;
  readonly #words: Int32Array;
  readonly #data: Uint8Array;
  readonly #capacity: number;

  /** A fresh ring whose consumer counts as idle until it first runs, so the
   * first push asks for a doorbell. */
  static create(dataBytes = RING_DATA_BYTES): ByteRing {
    const ring = new ByteRing(new SharedArrayBuffer(CONTROL_BYTES + dataBytes));
    Atomics.store(ring.#words, CONSUMER_IDLE, 1);
    return ring;
  }

  /** The largest record a ring of `dataBytes` can ever hold. */
  static maxRecordBytes(dataBytes = RING_DATA_BYTES): number {
    return dataBytes - PREFIX;
  }

  constructor(buffer: SharedArrayBuffer) {
    const capacity = buffer.byteLength - CONTROL_BYTES;
    // A power of two keeps every byte counter's wrap consistent with the
    // data index (counter mod capacity) across the 2^32 counter wrap.
    if (!(buffer instanceof SharedArrayBuffer) || capacity < 64 || (capacity & (capacity - 1)) !== 0) {
      throw new RangeError("device ring buffer must be 16 control bytes plus a power-of-two data region");
    }
    this.buffer = buffer;
    this.#words = new Int32Array(buffer, 0, 4);
    this.#data = new Uint8Array(buffer, CONTROL_BYTES, capacity);
    this.#capacity = capacity;
  }

  #used(head: number, tail: number): number {
    return (tail - head) >>> 0;
  }

  #fits(length: number): boolean {
    const used = this.#used(Atomics.load(this.#words, HEAD), Atomics.load(this.#words, TAIL));
    return this.#capacity - used >= PREFIX + length;
  }

  isEmpty(): boolean {
    return Atomics.load(this.#words, HEAD) === Atomics.load(this.#words, TAIL);
  }

  /** Producer: append one whole record, or return false (and change
   * nothing) when it does not fit now. An empty record, or one the ring
   * could never hold, is a caller error. */
  push(record: Uint8Array): boolean {
    if (record.byteLength === 0 || record.byteLength > this.#capacity - PREFIX) {
      throw new RangeError(`device ring record of ${record.byteLength} bytes does not fit a ${this.#capacity}-byte ring`);
    }
    const head = Atomics.load(this.#words, HEAD) >>> 0;
    const tail = Atomics.load(this.#words, TAIL) >>> 0;
    if (this.#capacity - this.#used(head, tail) < PREFIX + record.byteLength) return false;
    const prefix = new Uint8Array(PREFIX);
    new DataView(prefix.buffer).setUint32(0, record.byteLength, true);
    this.#write(tail, prefix);
    this.#write((tail + PREFIX) >>> 0, record);
    // Publishing the tail last releases the bytes written above.
    Atomics.store(this.#words, TAIL, (tail + PREFIX + record.byteLength) | 0);
    return true;
  }

  /** Consumer: take the oldest record into `out`; returns its length, or 0
   * when the ring is empty. `out` too small for the record is a caller
   * error and consumes nothing. */
  pop(out: Uint8Array): number {
    const head = Atomics.load(this.#words, HEAD) >>> 0;
    const tail = Atomics.load(this.#words, TAIL) >>> 0;
    const used = this.#used(head, tail);
    if (used === 0) return 0;
    const prefix = new Uint8Array(PREFIX);
    this.#read(head, prefix);
    const length = new DataView(prefix.buffer).getUint32(0, true);
    if (length === 0 || PREFIX + length > used) {
      throw new RangeError("device ring holds a corrupt record length");
    }
    if (out.byteLength < length) {
      throw new RangeError(`device ring record of ${length} bytes does not fit a ${out.byteLength}-byte buffer`);
    }
    this.#read((head + PREFIX) >>> 0, out.subarray(0, length));
    // Advancing the head last releases the room only after the copy.
    Atomics.store(this.#words, HEAD, (head + PREFIX + length) | 0);
    return length;
  }

  /** Consumer, after `pop` returned 0: mark itself idle. Returns true if the
   * ring is still empty (wait for a doorbell), false if a record arrived
   * meanwhile (keep popping; any doorbell already sent is harmless). */
  idle(): boolean {
    Atomics.store(this.#words, CONSUMER_IDLE, 1);
    if (this.isEmpty()) return true;
    Atomics.store(this.#words, CONSUMER_IDLE, 0);
    return false;
  }

  /** Producer, after pushing: whether the consumer was idle, so this side
   * must ring its doorbell. Takes the mark, so one doorbell answers it. */
  wakeConsumer(): boolean {
    return Atomics.exchange(this.#words, CONSUMER_IDLE, 0) === 1;
  }

  /** Producer, after `push` refused a `length`-byte record: mark itself
   * blocked. Returns true if there is still no room (wait for a doorbell),
   * false if room appeared meanwhile (push again). */
  blocked(length: number): boolean {
    Atomics.store(this.#words, PRODUCER_BLOCKED, 1);
    if (!this.#fits(length)) return true;
    Atomics.store(this.#words, PRODUCER_BLOCKED, 0);
    return false;
  }

  /** Consumer, after popping: whether the producer was blocked, so this side
   * must ring its doorbell. */
  wakeProducer(): boolean {
    return Atomics.exchange(this.#words, PRODUCER_BLOCKED, 0) === 1;
  }

  #write(position: number, bytes: Uint8Array): void {
    const at = position & (this.#capacity - 1);
    const first = Math.min(bytes.byteLength, this.#capacity - at);
    this.#data.set(bytes.subarray(0, first), at);
    if (first < bytes.byteLength) this.#data.set(bytes.subarray(first), 0);
  }

  #read(position: number, out: Uint8Array): void {
    const at = position & (this.#capacity - 1);
    const first = Math.min(out.byteLength, this.#capacity - at);
    out.set(this.#data.subarray(at, at + first), 0);
    if (first < out.byteLength) out.set(this.#data.subarray(0, out.byteLength - first), first);
  }
}
