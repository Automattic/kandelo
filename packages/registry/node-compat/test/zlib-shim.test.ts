import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as nodeStream from "node:stream";
import * as hostZlib from "node:zlib";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(__dirname, "../bootstrap.js");

function optionsForLevel(level: number | undefined) {
  return level === undefined ? undefined : { level };
}

function bufferedNativeTransform(fn: (input: Buffer) => Buffer) {
  const chunks: Buffer[] = [];
  return {
    write(input: Uint8Array, finish: boolean) {
      chunks.push(Buffer.from(input));
      if (!finish) return new Uint8Array(0);
      return new Uint8Array(fn(Buffer.concat(chunks)));
    },
  };
}

function loadZlibShim() {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const start = bootstrap.indexOf("    'zlib': (() => {");
  const exprStart = bootstrap.indexOf("(() => {", start);
  const end = bootstrap.indexOf("    'tty':", exprStart);
  if (start === -1 || exprStart === -1 || end === -1) {
    throw new Error("could not locate node-compat zlib module");
  }
  const source = bootstrap.slice(exprStart, end).replace(/,\s*$/, "");
  const native = {
    createDeflate(level?: number) {
      return bufferedNativeTransform((input) =>
        hostZlib.deflateSync(input, optionsForLevel(level)));
    },
    createInflate() {
      return bufferedNativeTransform((input) => hostZlib.inflateSync(input));
    },
    createGzip(level?: number) {
      return bufferedNativeTransform((input) =>
        hostZlib.gzipSync(input, optionsForLevel(level)));
    },
    createGunzip() {
      return bufferedNativeTransform((input) => hostZlib.gunzipSync(input));
    },
    createUnzip() {
      return bufferedNativeTransform((input) => hostZlib.unzipSync(input));
    },
    createDeflateRaw(level?: number) {
      return bufferedNativeTransform((input) =>
        hostZlib.deflateRawSync(input, optionsForLevel(level)));
    },
    createInflateRaw() {
      return bufferedNativeTransform((input) => hostZlib.inflateRawSync(input));
    },
    deflateSync(input: Uint8Array, level?: number) {
      return hostZlib.deflateSync(input, optionsForLevel(level));
    },
    inflateSync(input: Uint8Array) {
      return hostZlib.inflateSync(input);
    },
    gzipSync(input: Uint8Array, level?: number) {
      return hostZlib.gzipSync(input, optionsForLevel(level));
    },
    gunzipSync(input: Uint8Array) {
      return hostZlib.gunzipSync(input);
    },
    unzipSync(input: Uint8Array) {
      return hostZlib.unzipSync(input);
    },
    deflateRawSync(input: Uint8Array, level?: number) {
      return hostZlib.deflateRawSync(input, optionsForLevel(level));
    },
    inflateRawSync(input: Uint8Array) {
      return hostZlib.inflateRawSync(input);
    },
  };
  return vm.runInNewContext(source, {
    ArrayBuffer,
    Buffer,
    Number,
    queueMicrotask,
    stream: nodeStream,
    Uint8Array,
    _nodeNative: native,
    _makeInvalidArgTypeError(name: string, expected: string, value: unknown) {
      const err = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${typeof value}`);
      (err as NodeJS.ErrnoException).code = "ERR_INVALID_ARG_TYPE";
      return err;
    },
    _makeNodeError(message: string, code: string) {
      const err = new Error(message);
      (err as NodeJS.ErrnoException).code = code;
      return err;
    },
  });
}

function callAsync(fn: Function, input: unknown, opts?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cb = (err: unknown, result: unknown) => err ? reject(err) : resolve(result);
    if (opts === undefined) fn(input, cb);
    else fn(input, opts, cb);
  });
}

describe("node-compat zlib shim", () => {
  const zlib = loadZlibShim();

  it("exports Node-style constants and callable constructors", () => {
    expect(zlib.constants.Z_FINISH).toBe(4);
    expect(zlib.Z_FINISH).toBe(4);
    expect(zlib.codes.Z_DATA_ERROR).toBe(-3);

    expect(zlib.Deflate()).toBeInstanceOf(zlib.Deflate);
    expect(new zlib.Gzip()).toBeInstanceOf(zlib.Gzip);
    expect(zlib.createInflate({ windowBits: 0 })).toBeInstanceOf(zlib.Inflate);
    expect(zlib.createGunzip({ windowBits: 0 })).toBeInstanceOf(zlib.Gunzip);
    expect(zlib.createUnzip({ windowBits: 0 })).toBeInstanceOf(zlib.Unzip);
    expect(() => zlib.createGzip({ windowBits: 0 })).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
  });

  it("round-trips gzip, unzip, and raw sync helpers with info engines", () => {
    const input = Buffer.from("abcdef");
    const gzip = zlib.gzipSync(input);
    expect(zlib.gunzipSync(gzip).toString()).toBe("abcdef");
    expect(zlib.unzipSync(gzip).toString()).toBe("abcdef");

    const raw = zlib.deflateRawSync(input);
    expect(zlib.inflateRawSync(raw).toString()).toBe("abcdef");

    const withInfo = zlib.gzipSync(input, { info: true });
    expect(withInfo.buffer).toBeInstanceOf(Buffer);
    expect(withInfo.engine).toBeInstanceOf(zlib.Gzip);
  });

  it("supports callback convenience helpers", async () => {
    const compressed = await callAsync(zlib.deflateRaw, "callback payload");
    const decompressed = await callAsync(zlib.inflateRaw, compressed);
    expect(Buffer.from(decompressed as Uint8Array).toString()).toBe("callback payload");
  });

  it("keeps brotli names present while reporting the current native boundary", () => {
    expect(typeof zlib.brotliCompress).toBe("function");
    expect(typeof zlib.BrotliCompress).toBe("function");
    expect(() => new zlib.BrotliCompress()).toThrow(
      expect.objectContaining({ code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" }),
    );
  });
});
