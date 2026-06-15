import { readFileSync } from "node:fs";
import { Buffer as NodeBuffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(__dirname, "../bootstrap.js");

function sliceBetween(source: string, startText: string, endText: string): string {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  if (start === -1 || end === -1) {
    throw new Error(`could not locate bootstrap section: ${startText}`);
  }
  return source.slice(start, end);
}

function loadBufferShim() {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const invalidArgType = sliceBetween(
    bootstrap,
    "function _makeInvalidArgTypeError",
    "function _validateString",
  );
  const bufferSection = sliceBetween(
    bootstrap,
    "const _BUFFER_MAX_LENGTH =",
    "// ============================================================\n// process module",
  );
  const utilSection = sliceBetween(
    bootstrap,
    "const util = (() => {",
    "// ============================================================\n// assert module",
  );

  return vm.runInNewContext(
    `${invalidArgType}\n${bufferSection}\n${utilSection}\n({ nodeBuffer, util });`,
    {
      ArrayBuffer,
      Array,
      BigInt,
      DataView,
      Date,
      Error,
      Infinity,
      Map,
      Math,
      NaN,
      Number,
      Object,
      Promise,
      RangeError,
      RegExp,
      Set,
      SharedArrayBuffer,
      String,
      Symbol,
      TextDecoder,
      TextEncoder,
      TypeError,
      Uint8Array,
      Uint16Array,
      WeakMap,
      WeakSet,
      atob: (value: string) => NodeBuffer.from(value, "base64").toString("binary"),
      btoa: (value: string) => NodeBuffer.from(value, "binary").toString("base64"),
      console,
      parseFloat,
      parseInt,
      process: { env: {}, pid: 1, stderr: { write() {} } },
    },
  ) as {
    nodeBuffer: {
      Buffer: typeof Buffer;
      SlowBuffer(size?: unknown): Buffer;
      INSPECT_MAX_BYTES: number;
      isAscii(input: unknown): boolean;
      isUtf8(input: unknown): boolean;
    };
    util: { inspect(value: unknown): string };
  };
}

describe("node-compat Buffer shim", () => {
  const { nodeBuffer, util } = loadBufferShim();
  const { Buffer } = nodeBuffer;

  it("supports base64url and Node encoding aliases", () => {
    expect(Buffer.isEncoding("base64url")).toBe(true);
    expect(Buffer.from("Zm9v", "base64url").toString()).toBe("foo");
    expect(Buffer.from("foo").toString("base64url")).toBe("Zm9v");
    expect(Buffer.from("foo", "utf-8").toString("utf-8")).toBe("foo");
    expect(Buffer.from("foo", "binary").toString("binary")).toBe("foo");
    expect(() => Buffer.from("", "buffer")).toThrow(
      expect.objectContaining({ code: "ERR_UNKNOWN_ENCODING", message: "Unknown encoding: buffer" }),
    );
    expect(Buffer.from("T \x80W\xffFu", "base64").toString("ascii")).toBe("Man");
    expect(Buffer.from("=bad".repeat(10), "base64").length).toBe(0);
  });

  it("matches Node ASCII decoding and bad hex truncation", () => {
    expect(Buffer.from("hérité").toString("ascii")).toBe("hC)ritC)");
    expect(Buffer.from("ab\ud800cd")).toEqual(
      Buffer.from([0x61, 0x62, 0xef, 0xbf, 0xbd, 0x63, 0x64]),
    );

    const buf = Buffer.alloc(4);
    expect(buf.write("abcdxx", 0, "hex")).toBe(2);
    expect(buf.toString("hex")).toBe("abcd0000");
    expect(Buffer.from("abxxcd", "hex").toString("hex")).toBe("ab");
  });

  it("handles array-like values, SharedArrayBuffer, and copyBytesFrom", () => {
    const sab = new SharedArrayBuffer(4);
    const words = new Uint16Array(sab);
    words[0] = 5000;
    words[1] = 4000;

    const buf = Buffer.from(sab);
    expect(buf.length).toBe(4);
    expect(buf.parent).toBe(sab);
    expect(Buffer.prototype.parent).toBeUndefined();
    expect(Buffer.prototype.offset).toBeUndefined();
    words[1] = 6000;
    expect(new Uint16Array(buf.buffer, buf.byteOffset, 2)[1]).toBe(6000);

    expect(Buffer.byteLength(sab)).toBe(4);
    expect(Buffer.from({ buffer: sab }).length).toBe(0);
    expect(Buffer.from({ length: 3, 0: 257, 1: -1, 2: Number.NaN })).toEqual(
      Buffer.from([1, 255, 0]),
    );
    expect(Buffer.from({ length: 3.3 }).length).toBe(3);
    expect(Buffer.from({ length: "BAM" }).length).toBe(0);
    expect(Buffer.from({ length: -100 }).length).toBe(0);

    const foreignArrayBuffer = vm.runInNewContext("new ArrayBuffer(2)");
    expect(Buffer.from(foreignArrayBuffer).length).toBe(2);
    expect(Buffer.from({ buffer: foreignArrayBuffer }).length).toBe(0);
    expect(() => Buffer.from(new ArrayBuffer(0), -1 >>> 0)).toThrow(
      expect.objectContaining({
        code: "ERR_BUFFER_OUT_OF_BOUNDS",
        message: "\"offset\" is outside of buffer bounds",
      }),
    );

    const u16 = new Uint16Array([0, 0xffff]);
    expect(Buffer.copyBytesFrom(u16, 1, 5)).toEqual(Buffer.from([255, 255]));

    const detached = new ArrayBuffer(4);
    structuredClone(detached, { transfer: [detached] });
    expect(() => nodeBuffer.isAscii(detached)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_STATE" }),
    );
    expect(() => nodeBuffer.isUtf8(detached)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_STATE" }),
    );
  });

  it("matches Node generic integer reads, writes, ranges, and aliases", () => {
    const wide = Buffer.allocUnsafe(5);
    wide.writeUIntLE(0x1234567890, 0, 5);
    expect([...wide]).toEqual([0x90, 0x78, 0x56, 0x34, 0x12]);
    expect(wide.readUIntLE(0, 5)).toBe(0x1234567890);

    wide.fill(0xff);
    wide.writeIntBE(-0x1234567890, 0, 5);
    expect([...wide]).toEqual([0xed, 0xcb, 0xa9, 0x87, 0x70]);
    expect(wide.readIntBE(0, 5)).toBe(-0x1234567890);

    const buf = Buffer.alloc(8);
    expect(() => Buffer.alloc(0).readUInt8(0)).toThrow(
      expect.objectContaining({
        code: "ERR_BUFFER_OUT_OF_BOUNDS",
        message: "Attempt to access memory outside buffer bounds",
      }),
    );
    expect(() => Buffer.alloc(1).writeFloatLE(0, "" as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => Buffer.alloc(1).writeFloatLE(0, 0)).toThrow(
      expect.objectContaining({ code: "ERR_BUFFER_OUT_OF_BOUNDS" }),
    );
    expect(() => buf.writeFloatLE(0, 5)).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE", name: "RangeError" }),
    );
    expect(() => buf.readUIntLE(undefined as never, 1)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => buf.writeIntLE(0, undefined as never, 1)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => Buffer.alloc(9).write("foo", -1)).toThrow(
      expect.objectContaining({
        code: "ERR_OUT_OF_RANGE",
        message: "The value of \"offset\" is out of range. It must be >= 0 && <= 9. Received -1",
      }),
    );
    expect(() => buf.writeUIntLE(2 ** 40, 0, 5)).toThrow(
      expect.objectContaining({
        code: "ERR_OUT_OF_RANGE",
        message: "The value of \"value\" is out of range. It must be >= 0 and < 2 ** 40. Received 1_099_511_627_776",
      }),
    );
    expect(() => buf.writeIntLE(2 ** 39, 0, 5)).toThrow(
      expect.objectContaining({
        code: "ERR_OUT_OF_RANGE",
        message: "The value of \"value\" is out of range. It must be >= -(2 ** 39) and < 2 ** 39. Received 549_755_813_888",
      }),
    );
    expect(() => buf.readUIntLE(0, Number.NaN)).toThrow(
      expect.objectContaining({
        code: "ERR_OUT_OF_RANGE",
        message: "The value of \"byteLength\" is out of range. It must be an integer. Received NaN",
      }),
    );

    expect(Buffer.prototype.writeUintLE).toBe(Buffer.prototype.writeUIntLE);
    expect(Buffer.prototype.readUint32BE).toBe(Buffer.prototype.readUInt32BE);
    expect(Buffer.prototype.writeBigUint64LE).toBe(Buffer.prototype.writeBigUInt64LE);
    expect(Buffer.prototype.toLocaleString).toBe(Buffer.prototype.toString);
  });

  it("provides BigInt read/write methods and validates BigInt inputs", () => {
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigInt64LE(-123456789n, 0);
    expect(buf.readBigInt64LE(0)).toBe(-123456789n);

    buf.writeBigUInt64BE(123456789n, 0);
    expect(buf.readBigUInt64BE(0)).toBe(123456789n);

    expect(() => buf.writeBigUInt64LE(0x10000000000000000n, 0)).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
    expect(() => buf.writeBigInt64LE("bad" as never, 0)).toThrow(TypeError);
  });

  it("implements swap methods in-place", () => {
    const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(buf.swap16()).toBe(buf);
    expect(buf).toEqual(Buffer.from([2, 1, 4, 3, 6, 5, 8, 7]));
    expect(() => Buffer.from([1, 2, 3]).swap16()).toThrow(/multiple of 16-bits/);
  });

  it("exposes SlowBuffer, isAscii, isUtf8, and mutable inspect limits", () => {
    const slow = nodeBuffer.SlowBuffer(4);
    expect(slow).toBeInstanceOf(Buffer);
    expect(slow.buffer.byteLength).toBe(4);
    expect(() => nodeBuffer.SlowBuffer("4")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => nodeBuffer.SlowBuffer(Number.NaN)).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );

    expect(nodeBuffer.isAscii(new TextEncoder().encode("hello"))).toBe(true);
    expect(nodeBuffer.isAscii(new TextEncoder().encode("ğ"))).toBe(false);
    expect(nodeBuffer.isUtf8(Buffer.from([0xc4, 0x9f]))).toBe(true);
    expect(nodeBuffer.isUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBe(false);

    nodeBuffer.INSPECT_MAX_BYTES = 2;
    const inspected = Buffer.from("1234");
    expect(util.inspect(inspected)).toBe("<Buffer 31 32 ... 2 more bytes>");

    const filled = Buffer.allocUnsafe(4);
    filled.fill("1234");
    expect(util.inspect(filled)).toBe("<Buffer 31 32 ... 2 more bytes>");

    nodeBuffer.INSPECT_MAX_BYTES = Infinity;
    expect(util.inspect(filled)).toBe("<Buffer 31 32 33 34>");

    inspected.inspect = undefined as never;
    inspected.prop = new Uint8Array(0) as never;
    expect(util.inspect(inspected)).toBe(
      "<Buffer 31 32 33 34, inspect: undefined, prop: Uint8Array(0) []>",
    );
  });

  it("matches Node invalid argument wording for Buffer.from", () => {
    expect(() => Buffer.from({})).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message:
          "The first argument must be of type string or an instance of Buffer, " +
          "ArrayBuffer, or Array or an Array-like Object. Received an instance of Object",
      }),
    );
    expect(() => Buffer.from(Object.create(null))).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message:
          "The first argument must be of type string or an instance of Buffer, " +
          "ArrayBuffer, or Array or an Array-like Object. Received {  }",
      }),
    );
    expect(() => Buffer.from(Symbol())).toThrow(
      expect.objectContaining({ message: expect.stringContaining("Received type symbol (Symbol())") }),
    );
    expect(() => Buffer.from(5n)).toThrow(
      expect.objectContaining({ message: expect.stringContaining("Received type bigint (5)") }),
    );
    expect(() => Buffer.from(() => {})).toThrow(
      expect.objectContaining({ message: expect.stringContaining("Received function ") }),
    );
  });

  it("rejects unsupported Buffer.write argument combinations", () => {
    const buf = Buffer.alloc(8);
    expect(() => buf.write("test", "utf8", 0)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );

    const partial = Buffer.from([0, 0, 0, 0, 0]);
    expect(partial.write("あいうえお", "utf16le")).toBe(4);
    expect(partial).toEqual(Buffer.from([0x42, 0x30, 0x44, 0x30, 0x00]));

    const shortUtf8 = Buffer.allocUnsafe(2);
    expect(shortUtf8.write("あ")).toBe(0);
    expect(shortUtf8.write("\0あ")).toBe(1);
    expect(shortUtf8.write("\0\0あ")).toBe(2);
  });

  it("provides allocUnsafeSlow", () => {
    const buf = Buffer.allocUnsafeSlow(5);
    const nested = buf.slice(0, 4).slice(0, 2);
    expect(buf.length).toBe(5);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(Buffer.isBuffer(nested)).toBe(true);
    expect(() => Buffer.alloc({ valueOf: () => 1 } as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => Buffer.alloc(0x1000, "c", "hex")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
    expect(() => Buffer.alloc(1, Buffer.alloc(0))).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
    expect(() => Buffer.alloc(40, "x", 20 as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => Buffer.allocUnsafe(10).copy()).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: "The \"target\" argument must be an instance of Buffer or Uint8Array. Received undefined",
      }),
    );
  });
});
