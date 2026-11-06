import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import * as nativeUrl from "node:url";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Exercise the actual shared compatibility functions without a package build.
// The base-shell fixture separately verifies their integration on both hosts.
const source = readFileSync(new URL("../../packages/registry/node-compat/bootstrap.js", import.meta.url), "utf8");
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error(`Missing source boundaries: ${start}, ${end}`);
  return source.slice(a, b);
}
const vendor = readFileSync(new URL("../../third_party/node-web-platform/node-web-platform.js", import.meta.url), "utf8");
const web = runInNewContext(`${vendor};_createNodeWebPlatform()`, { TextEncoder, TextDecoder });
const url = runInNewContext(`${section("const url = (() => {", "url.domainToASCII")};url`,
  { _nodeWebPlatform: web, path });
const pathToString = runInNewContext(`${section("    function _pathToString(p)", "    function _flagsToMode")};_pathToString`,
  { URL: url.URL, url, Buffer });
const posixUrlOptions = { windows: false };
function outcome(fn: () => unknown) {
  try { return { value: fn() }; }
  catch (error: any) { return { name: error.name, code: error.code }; }
}
function guestProcess() {
  let status: number | undefined;
  const context = {
    events: { EventEmitter }, os: { getcwd: () => ["/tmp"], getpid: () => 1 },
    std: { getenv: () => undefined, exit: (code: number) => { status = code; } },
  };
  const proc = runInNewContext(`${section("const process = (() => {", "const _startTime")};process`, context);
  const naturalExit = runInNewContext(`${section("function _runNaturalExit()", "function _runCommonJsMain(")};_runNaturalExit`,
    { process: proc, std: context.std });
  return { proc, naturalExit, status: () => status };
}

describe("shared Node URL and exit contracts", () => {
  it("converts POSIX file URLs using validated, decoded pathnames", () => {
    for (const value of ["file:///tmp/a%20b", "file:///tmp/%E6%B8%AC%E8%A9%A6", "file:///tmp/%2520%23%3F",
      "file://localhost/tmp/a?query#hash", "file:///tmp/%5c", "file://host/tmp/a", "https://example.org/a",
      "file:///tmp/%2F", "file:///tmp/%2f", "file:///tmp/%FF", "file:///tmp/%"]) {
      expect(outcome(() => url.fileURLToPath(value))).toEqual(outcome(() => nativeUrl.fileURLToPath(value, posixUrlOptions)));
    }
    for (const value of ["/tmp/a b", "/tmp/測試", "/tmp/%20#?", "/tmp/a\\b", "/tmp/line\n\t\r", "/tmp/dir/", "relative", "//tmp/a"]) {
      expect(url.pathToFileURL(value).href).toBe(nativeUrl.pathToFileURL(value, posixUrlOptions).href);
    }
  });

  it("uses fileURLToPath in the filesystem adapter and rejects NUL bytes", () => {
    expect(pathToString(new url.URL("file:///tmp/a%20b"))).toBe("/tmp/a b");
    expect(outcome(() => pathToString(new url.URL("file:///tmp/a%00b")))).toEqual({ name: "TypeError", code: "ERR_INVALID_ARG_VALUE" });
    expect(outcome(() => pathToString(new url.URL("https://host/a")))).toEqual({ name: "TypeError", code: "ERR_INVALID_URL_SCHEME" });
  });

  it("formats WHATWG credentials, options and opaque paths without mutating input", () => {
    for (const input of ["https://u%40x:p%3Ass@xn--g6w251d:8443/a?b=1#frag", "https://:pass@host/?#", "mailto:a@example.org", "https://[::1]/?q#f"]) {
      for (const options of [undefined, null, { auth: false }, { unicode: true }, { fragment: false, search: false },
        { unicode: true, auth: false, search: false, fragment: false }, { auth: 0, search: null }, 1, []]) {
        const value = new url.URL(input);
        expect(outcome(() => url.format(value, options))).toEqual(outcome(() => nativeUrl.format(new nativeUrl.URL(input), options as any)));
        expect(value.href).toBe(new nativeUrl.URL(input).href);
      }
    }
    const legacy = { protocol: "https:", hostname: "example.org", auth: "user:pass", pathname: "/a" };
    expect(url.format(legacy)).toBe(nativeUrl.format(legacy));
  });

  it("validates exitCode assignments and restores absence on null", () => {
    const { proc } = guestProcess();
    const original = process.exitCode;
    try {
      for (const value of [undefined, null, 0, 7, -1, "7", " ", "", "bad", true, {}, 1.5, NaN, Infinity,
        Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 4294967296]) {
        proc.exitCode = undefined;
        process.exitCode = undefined;
        expect(outcome(() => { proc.exitCode = value; return proc.exitCode; }))
          .toEqual(outcome(() => { process.exitCode = value as any; return process.exitCode; }));
      }
    } finally { process.exitCode = original; }
  });

  it("distinguishes natural exit from explicit exit and avoids duplicate exit events", () => {
    for (const natural of [true, false]) {
      const { proc, naturalExit, status } = guestProcess();
      proc.exitCode = 7;
      const emitted: unknown[] = [];
      proc.on("exit", (code: unknown) => { emitted.push(code); proc.exitCode = null; });
      if (natural) naturalExit(); else proc.exit();
      expect(emitted).toEqual([7]);
      expect(status()).toBe(natural ? 7 : 0);
      proc.exit();
      expect(emitted).toEqual([7]);
    }
    const { proc, status } = guestProcess();
    proc.exitCode = 7;
    proc.exit(undefined);
    expect(status()).toBe(0);
  });
});
