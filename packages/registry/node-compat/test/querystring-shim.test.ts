import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(__dirname, "../bootstrap.js");

function loadQuerystringShim() {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const start = bootstrap.indexOf("const querystring = (() => {");
  const end = bootstrap.indexOf("// ============================================================\n// string_decoder module", start);
  if (start === -1 || end === -1) {
    throw new Error("could not locate node-compat querystring module");
  }
  const source = `${bootstrap.slice(start, end)}\nquerystring;`;
  return vm.runInNewContext(source, {
    Array,
    Buffer,
    Number,
    Object,
    RegExp,
    String,
    TypeError,
    URIError,
    decodeURIComponent,
    encodeURIComponent,
    parseInt,
  });
}

function createManyParams(count: number) {
  let str = "";
  if (count === 0) return str;
  str += "0=0";
  for (let i = 1; i < count; i++) {
    const n = i.toString(36);
    str += `&${n}=${n}`;
  }
  return str;
}

describe("node-compat querystring shim", () => {
  const querystring = loadQuerystringShim();

  it("matches Node querystring.escape malformed-surrogate semantics", () => {
    expect(querystring.escape(5)).toBe("5");
    expect(querystring.escape("test")).toBe("test");
    expect(querystring.escape({})).toBe("%5Bobject%20Object%5D");
    expect(querystring.escape([5, 10])).toBe("5%2C10");
    expect(querystring.escape("Ŋōđĕ")).toBe("%C5%8A%C5%8D%C4%91%C4%95");
    expect(querystring.escape("testŊōđĕ")).toBe("test%C5%8A%C5%8D%C4%91%C4%95");
    expect(querystring.escape(`${String.fromCharCode(0xd800 + 1)}test`)).toBe("%F0%90%91%B4est");

    expect(() => querystring.escape(String.fromCharCode(0xd800 + 1))).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_URI",
        name: "URIError",
        message: "URI malformed",
      }),
    );

    expect(querystring.escape({ test: 5, toString: () => "test", valueOf: () => 10 })).toBe("test");
    expect(() => querystring.escape({ toString: 5 })).toThrow(TypeError);
    expect(querystring.escape({ toString: 5, valueOf: () => "test" })).toBe("test");
    expect(() => querystring.escape(Symbol("test"))).toThrow(
      expect.objectContaining({ name: "TypeError" }),
    );
  });

  it("matches Node querystring.parse maxKeys non-finite handling", () => {
    const count = 10000;
    const params = createManyParams(count);

    expect(Object.keys(querystring.parse(params))).toHaveLength(1000);
    expect(Object.keys(querystring.parse(params, undefined, undefined, { maxKeys: 5 }))).toHaveLength(5);
    expect(Object.keys(querystring.parse(params, undefined, undefined, { maxKeys: 5.5 }))).toHaveLength(count);
    expect(Object.keys(querystring.parse(params, undefined, undefined, { maxKeys: Infinity }))).toHaveLength(count);
    expect(Object.keys(querystring.parse(params, undefined, undefined, { maxKeys: NaN }))).toHaveLength(count);
    expect(Object.keys(querystring.parse(params, undefined, undefined, { maxKeys: "Infinity" }))).toHaveLength(1000);
    expect(Object.keys(querystring.parse(params, undefined, undefined, { maxKeys: "NaN" }))).toHaveLength(1000);
  });
});
