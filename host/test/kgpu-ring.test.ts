// The single-producer/single-consumer byte ring the kernel worker and a
// device worker share (host/src/device-worker/ring.ts): whole records arrive
// in order across wraparound, a full ring refuses rather than overwrites, and
// the idle/blocked flags never lose a doorbell.
import { describe, expect, it } from "vitest";
import { ByteRing, RING_DATA_BYTES } from "../src/device-worker/ring";

/** Byte equality without per-element matcher cost on 64 KiB records. */
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

function record(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (seed * 31 + i * 7) & 0xff;
  return bytes;
}

describe("ByteRing", () => {
  it("has 64 KiB of data behind head/tail words", () => {
    const ring = ByteRing.create();
    expect(RING_DATA_BYTES).toBe(64 * 1024);
    expect(ring.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(ring.buffer.byteLength).toBeGreaterThanOrEqual(RING_DATA_BYTES + 8);
    expect(ring.isEmpty()).toBe(true);
    expect(ring.pop(new Uint8Array(16))).toBe(0);
  });

  it("delivers whole records in order across wraparound", () => {
    const producer = ByteRing.create();
    // Both ends attach to the same buffer, as the two workers do.
    const consumer = new ByteRing(producer.buffer);
    const out = new Uint8Array(RING_DATA_BYTES);
    // Lengths that are not multiples of four put the length prefix itself
    // across the end of the data region on some laps.
    const lengths = [1, 3, 5, 4093, 24, 17, 40_000, 2, 9_999, 65_000];
    let pushed = 0, popped = 0, total = 0;
    for (let lap = 0; lap < 16; lap++) {
      for (const length of lengths) {
        const sent = record(length, pushed);
        while (!producer.push(sent)) {
          const n = consumer.pop(out);
          expect(n).toBeGreaterThan(0);
          if (!same(out.subarray(0, n), record(n, popped))) expect.fail(`record ${popped} arrived corrupt`);
          popped++;
        }
        pushed++;
        total += length;
      }
    }
    for (let n; (n = consumer.pop(out)) !== 0; popped++) {
      if (!same(out.subarray(0, n), record(n, popped))) expect.fail(`record ${popped} arrived corrupt`);
    }
    expect(popped).toBe(pushed);
    expect(total).toBeGreaterThan(20 * RING_DATA_BYTES);
    expect(consumer.isEmpty()).toBe(true);
  });

  it("refuses a push into a full ring and never overwrites", () => {
    const ring = ByteRing.create();
    const out = new Uint8Array(RING_DATA_BYTES);
    const sent: Uint8Array[] = [];
    for (let i = 0; ; i++) {
      const next = record(1000, i);
      if (!ring.push(next)) break;
      sent.push(next);
    }
    expect(sent.length).toBeGreaterThan(60);
    // Refusal is repeatable and leaves every queued record intact.
    expect(ring.push(record(1000, 999))).toBe(false);
    expect(ring.pop(out)).toBe(1000);
    expect(out.subarray(0, 1000)).toEqual(sent[0]);
    expect(ring.push(record(900, 1234))).toBe(true);
    for (const expected of sent.slice(1)) {
      expect(ring.pop(out)).toBe(1000);
      expect(out.subarray(0, 1000)).toEqual(expected);
    }
    expect(ring.pop(out)).toBe(900);
    expect(out.subarray(0, 900)).toEqual(record(900, 1234));
    expect(ring.pop(out)).toBe(0);
  });

  it("refuses records it could never hold and buffers too small to take one", () => {
    const ring = ByteRing.create();
    expect(() => ring.push(new Uint8Array(0))).toThrow(RangeError);
    expect(() => ring.push(new Uint8Array(ByteRing.maxRecordBytes(RING_DATA_BYTES) + 1))).toThrow(RangeError);
    expect(ring.push(new Uint8Array(ByteRing.maxRecordBytes(RING_DATA_BYTES)))).toBe(true);
    expect(() => ring.pop(new Uint8Array(8))).toThrow(RangeError);
    // The refused pop consumed nothing.
    expect(ring.pop(new Uint8Array(RING_DATA_BYTES))).toBe(ByteRing.maxRecordBytes(RING_DATA_BYTES));
  });

  it("wakes an idle consumer exactly when its ring turns non-empty", () => {
    const producer = ByteRing.create();
    const consumer = new ByteRing(producer.buffer);
    const out = new Uint8Array(64);
    // A new ring's consumer has not run yet: the first push must wake it.
    expect(producer.push(record(8, 1))).toBe(true);
    expect(producer.wakeConsumer()).toBe(true);
    expect(producer.push(record(8, 2))).toBe(true);
    expect(producer.wakeConsumer()).toBe(false);
    // The consumer drains to empty before it goes idle.
    expect(consumer.pop(out)).toBe(8);
    expect(consumer.idle()).toBe(false);
    expect(consumer.pop(out)).toBe(8);
    expect(consumer.idle()).toBe(true);
    expect(producer.push(record(8, 3))).toBe(true);
    expect(producer.wakeConsumer()).toBe(true);
    // A record that lands between the consumer's last empty pop and its
    // idle check is seen by that check, so no doorbell is needed.
    expect(consumer.pop(out)).toBe(8);
    expect(consumer.pop(out)).toBe(0);
    expect(producer.push(record(8, 4))).toBe(true);
    expect(consumer.idle()).toBe(false);
    expect(producer.wakeConsumer()).toBe(false);
  });

  it("wakes a blocked producer exactly when room is freed", () => {
    const producer = ByteRing.create();
    const consumer = new ByteRing(producer.buffer);
    const big = record(ByteRing.maxRecordBytes(RING_DATA_BYTES), 7);
    expect(producer.push(big)).toBe(true);
    expect(producer.push(record(16, 8))).toBe(false);
    expect(producer.blocked(16)).toBe(true);
    // The flag stays set until the consumer frees room and takes it.
    expect(producer.blocked(16)).toBe(true);
    expect(consumer.pop(new Uint8Array(RING_DATA_BYTES))).toBe(big.length);
    expect(consumer.wakeProducer()).toBe(true);
    expect(consumer.wakeProducer()).toBe(false);
    // Room that is already free is reported instead of waited for.
    expect(producer.blocked(16)).toBe(false);
    expect(consumer.wakeProducer()).toBe(false);
  });
});
