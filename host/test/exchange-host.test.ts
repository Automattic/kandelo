import { describe, expect, it } from "vitest";
import {
  decodeNotifications,
  encodeEntryRecord,
  ExchangeSourceCache,
  formatExchangeId,
  parseExchangeId,
} from "../src/exchange-host";

const text = (s: string) => new TextEncoder().encode(s);

describe("exchange host layouts", () => {
  it("encodes entry records in the kernel's layout", () => {
    const batch = new Uint8Array(16).fill(7);
    const record = encodeEntryRecord({
      batch,
      kind: "file",
      source: 42n,
      size: 9n,
      path: [text("dir"), text("a.txt")],
      mtimeMs: 1_700_000_000_500,
      index: 0,
      mimeType: text("text/plain"),
    });
    const view = new DataView(record.buffer);
    expect(Array.from(record.subarray(0, 16))).toEqual(Array.from(batch));
    expect(record[16]).toBe(1);
    expect(view.getBigUint64(20, true)).toBe(42n);
    expect(view.getBigUint64(28, true)).toBe(9n);
    expect(view.getBigUint64(36, true)).toBe(1_700_000_000n);
    expect(view.getUint32(44, true)).toBe(500_000_000);
    expect(view.getUint32(48, true)).toBe(0);
    // count 2, "dir", "a.txt", mime, absent url, absent original name
    const tail = Array.from(record.subarray(52));
    expect(tail).toEqual([
      2, 0, 3, 0, ...text("dir"), 5, 0, ...text("a.txt"),
      10, 0, ...text("text/plain"), 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("decodes every notification kind and refuses malformed records", () => {
    const id = new Uint8Array(16).fill(1);
    const record = (kind: number, body: number[]) => [3 + body.length, 0, kind, ...body];
    const bytes = new Uint8Array([
      ...record(7, [1]),
      ...record(2, [...id, 1, 4, 0, ...text("done")]),
      ...record(4, [5, 0, 0, 0, 0, 0, 0, 0]),
      ...record(5, [...id, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, ...text("a"), 0xff, 0xff, 1, 0, ...id]),
      ...record(5, [...id, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, ...text("s"), 0xff, 0xff, 0, 0]),
      ...record(8, [6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]),
      ...record(9, [...id]),
    ]);
    const decoded = decodeNotifications(bytes);
    expect(decoded[0]).toEqual({ kind: "consumer", present: true });
    expect(decoded[1]).toMatchObject({ kind: "settled", outcome: "removed", status: text("done") });
    expect(decoded[2]).toEqual({ kind: "source-released", source: 5n });
    expect(decoded[3]).toMatchObject({ kind: "output-published", stream: false, size: 3n, name: text("a") });
    expect(decoded[4]).toMatchObject({ kind: "output-published", stream: true, size: 0n, derivedFrom: [] });
    expect(decoded[5]).toEqual({ kind: "stream-demand", source: 6n, free: 65536 });
    expect(decoded[6]).toEqual({ kind: "stream-readable", output: id });
    expect(decodeNotifications(new Uint8Array())).toEqual([]);
    expect(() => decodeNotifications(new Uint8Array([4, 0, 99, 0]))).toThrow();
    // An output kind other than stored (1) or stream (2).
    expect(() => decodeNotifications(new Uint8Array(record(5, [...id, 3, ...new Array(12).fill(0)])))).toThrow();
    expect(() => decodeNotifications(new Uint8Array([9, 0, 7, 1]))).toThrow();
  });

  it("round-trips exchange IDs in canonical form only", () => {
    const id = new Uint8Array([0x01, 0x92, 0xf3, 0xa1, 0x7c, 0x4e, 0x8a, 0x2b, 0x8f, 0, 0x3c, 0x1d, 0x9e, 0x5b, 0x4a, 0x10]);
    const textForm = formatExchangeId(id);
    expect(textForm).toBe("0192f3a1-7c4e-8a2b-8f00-3c1d9e5b4a10");
    expect(Array.from(parseExchangeId(textForm))).toEqual(Array.from(id));
    expect(() => parseExchangeId(textForm.toUpperCase())).toThrow();
  });
});

describe("exchange source cache", () => {
  it("answers EAGAIN on a miss, asks once per window, then serves hits", () => {
    const requests: Array<[bigint, bigint, number]> = [];
    const cache = new ExchangeSourceCache((s, o, n) => requests.push([s, o, n]), 8);
    const dest = new Uint8Array(4);
    expect(cache.read(1n, 0n, dest)).toBe(-11);
    expect(cache.read(1n, 0n, dest)).toBe(-11);
    expect(requests).toEqual([[1n, 0n, 8]]);
    cache.fulfill(1n, 0n, 8, text("abcdefgh"));
    expect(cache.read(1n, 0n, dest)).toBe(4);
    expect(new TextDecoder().decode(dest)).toBe("abcd");
    expect(cache.read(1n, 6n, dest)).toBe(2);
    expect(cache.read(1n, 8n, dest)).toBe(-11);
    expect(requests.at(-1)).toEqual([1n, 8n, 8]);
  });

  it("treats a source shorter than requested as an I/O error and remembers failures", () => {
    const cache = new ExchangeSourceCache(() => {}, 8);
    const dest = new Uint8Array(4);
    cache.read(2n, 0n, dest);
    cache.fulfill(2n, 0n, 8, text("ab"));
    expect(cache.read(2n, 0n, dest)).toBe(2);
    expect(cache.read(2n, 2n, dest)).toBe(-5);
    cache.fail(3n);
    expect(cache.read(3n, 0n, dest)).toBe(-5);
    cache.release(3n);
    expect(cache.read(3n, 0n, dest)).toBe(-11);
  });
});
