import { readFileSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = join(__dirname, "../bootstrap.js");

function loadPunycodeShim() {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const start = bootstrap.indexOf("const punycode = (() => {");
  const end = bootstrap.indexOf("// ============================================================\n// Module system", start);
  if (start === -1 || end === -1) {
    throw new Error("could not locate node-compat punycode module");
  }
  const source = `${bootstrap.slice(start, end)}\npunycode;`;
  return vm.runInNewContext(source, {});
}

function loadRequireWithPunycodeBuiltin() {
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const start = bootstrap.indexOf("const _moduleCache = Object.create(null);");
  const end = bootstrap.indexOf("function _nearestPackageType", start);
  if (start === -1 || end === -1) {
    throw new Error("could not locate node-compat module system");
  }

  const punycode = { marker: "punycode" };
  const warnings: Array<{ message: string; type: string; code: string }> = [];
  const processShim = {
    env: {},
    cwd: () => "/work",
    emitWarning(message: string, type: string, code: string) {
      warnings.push({ message, type, code });
    },
  };
  const source = `
const _builtinModules = { punycode };
${bootstrap.slice(start, end)}
({ require: _makeRequire('/work/main.js'), punycode, warnings });
`;

  return vm.runInNewContext(source, {
    path: path.posix,
    punycode,
    warnings,
    process: processShim,
    std: { getenv: () => null, loadFile: () => null },
    os: {
      realpath: (p: string) => [p, 0],
      stat: () => [null, 2],
    },
    util,
    url: {},
    _makeInvalidArgTypeError(name: string, expected: string, actual: unknown) {
      return new TypeError(`${name} must be ${expected}; got ${typeof actual}`);
    },
    _makeInvalidArgValueError(name: string, value: unknown) {
      return new TypeError(`${name} has invalid value ${String(value)}`);
    },
  });
}

describe("node-compat punycode shim", () => {
  const punycode = loadPunycodeShim();

  it("exposes the legacy Node punycode API surface", () => {
    expect(Object.keys(punycode)).toEqual([
      "version",
      "ucs2",
      "decode",
      "encode",
      "toASCII",
      "toUnicode",
    ]);
    expect(punycode.version).toBe("2.1.0");
    expect(Object.keys(punycode.ucs2)).toEqual(["decode", "encode"]);
    expect(punycode.encode).toHaveLength(1);
    expect(punycode.decode).toHaveLength(1);
    expect(punycode.toASCII).toHaveLength(1);
    expect(punycode.toUnicode).toHaveLength(1);
  });

  it("encodes and decodes RFC 3492 labels", () => {
    expect(punycode.encode("mañana")).toBe("maana-pta");
    expect(punycode.decode("maana-pta")).toBe("mañana");
    expect(punycode.encode("bücher")).toBe("bcher-kva");
    expect(punycode.decode("bcher-kva")).toBe("bücher");
    expect(punycode.encode("☃-⌘")).toBe("--dqo34k");
    expect(punycode.decode("--dqo34k")).toBe("☃-⌘");
    expect(punycode.encode("💩")).toBe("ls8h");
    expect(punycode.decode("ls8h")).toBe("💩");
  });

  it("throws Node-compatible errors for malformed punycode input", () => {
    expect(() => punycode.decode("mañana")).toThrow("Invalid input");
    expect(() => punycode.decode("xn--maana-pta.com")).toThrow("Invalid input");
    expect(() => punycode.decode("-")).toThrow("Invalid input");
  });

  it("converts international domain labels to and from ASCII", () => {
    expect(punycode.toASCII("mañana.com")).toBe("xn--maana-pta.com");
    expect(punycode.toUnicode("xn--maana-pta.com")).toBe("mañana.com");
    expect(punycode.toASCII("مثال.إختبار")).toBe("xn--mgbh0fb.xn--kgbechtv");
    expect(punycode.toUnicode("xn--mgbh0fb.xn--kgbechtv")).toBe("مثال.إختبار");
    expect(punycode.toASCII("例え.テスト")).toBe("xn--r8jz45g.xn--zckzah");
    expect(punycode.toUnicode("xn--r8jz45g.xn--zckzah")).toBe("例え.テスト");
  });

  it("matches Node's domain separator and prefix casing behavior", () => {
    expect(punycode.toASCII("mañana。com")).toBe("xn--maana-pta.com");
    expect(punycode.toASCII("mañana．com")).toBe("xn--maana-pta.com");
    expect(punycode.toASCII("mañana｡com")).toBe("xn--maana-pta.com");
    expect(punycode.toASCII("mañana.com.")).toBe("xn--maana-pta.com.");
    expect(punycode.toUnicode("xn--MAANA-PTA.COM")).toBe("mañana.COM");
    expect(punycode.toUnicode("XN--MAANA-PTA.COM")).toBe("XN--MAANA-PTA.COM");
  });

  it("preserves legacy email-domain mapping quirks", () => {
    expect(punycode.toASCII("user@mañana.com")).toBe("user@xn--maana-pta.com");
    expect(punycode.toUnicode("user@xn--maana-pta.com")).toBe("user@mañana.com");
    expect(punycode.toASCII("a@b@mañana.com")).toBe("a@b");
  });

  it("converts between JavaScript UCS-2 strings and code points", () => {
    expect(punycode.ucs2.decode("abc💩")).toEqual([97, 98, 99, 128169]);
    expect(punycode.ucs2.encode([97, 98, 99, 128169])).toBe("abc💩");
    expect(punycode.ucs2.encode([0xd800])).toBe("\ud800");
    expect(() => punycode.ucs2.encode([0x110000])).toThrow("Invalid code point 1114112");
  });

  it("emits the legacy DEP0040 warning once when required as a builtin", () => {
    const loaded = loadRequireWithPunycodeBuiltin();

    expect(loaded.require("punycode")).toBe(loaded.punycode);
    expect(loaded.require("punycode")).toBe(loaded.punycode);
    expect(loaded.require("node:punycode")).toBe(loaded.punycode);
    expect(loaded.warnings).toEqual([
      {
        message:
          "The `punycode` module is deprecated. Please use a userland alternative instead.",
        type: "DeprecationWarning",
        code: "DEP0040",
      },
    ]);
  });
});
