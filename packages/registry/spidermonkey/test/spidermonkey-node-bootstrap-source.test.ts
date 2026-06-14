import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../..");

const historicalMissingBuiltins = [
  "_http_agent",
  "_http_common",
  "_http_outgoing",
  "_http_server",
  "_stream_readable",
  "_stream_wrap",
  "async_hooks",
  "dgram",
  "dns",
  "dns/promises",
  "domain",
  "fs",
  "inspector",
  "internal/assert",
  "internal/async_hooks",
  "internal/child_process",
  "internal/cluster/round_robin_handle",
  "internal/console/constructor",
  "internal/dgram",
  "internal/encoding",
  "internal/errors",
  "internal/event_target",
  "internal/fixed_queue",
  "internal/freelist",
  "internal/fs/promises",
  "internal/fs/sync_write_stream",
  "internal/fs/utils",
  "internal/http",
  "internal/http2/util",
  "internal/js_stream_socket",
  "internal/linkedlist",
  "internal/navigator",
  "internal/net",
  "internal/options",
  "internal/priority_queue",
  "internal/readline/utils",
  "internal/repl",
  "internal/repl/await",
  "internal/socket_list",
  "internal/socketaddress",
  "internal/streams/add-abort-signal",
  "internal/streams/compose",
  "internal/streams/state",
  "internal/test/binding",
  "internal/test/transfer",
  "internal/test_runner/harness",
  "internal/test_runner/mock/mock",
  "internal/test_runner/mock/mock_timers",
  "internal/test_runner/runner",
  "internal/test_runner/utils",
  "internal/timers",
  "internal/url",
  "internal/util",
  "internal/util/inspect",
  "internal/util/inspector",
  "internal/util/iterable_weak_map",
  "internal/v8_prof_polyfill",
  "internal/validators",
  "internal/webidl",
  "internal/webstreams/adapters",
  "internal/webstreams/readablestream",
  "internal/webstreams/util",
  "internal/worker",
  "internal/worker/io",
  "internal/worker/js_transferable",
  "node:test",
  "path/posix",
  "path/win32",
  "readline/promises",
  "repl",
  "sys",
  "trace_events",
];

function generatedBootstrapSource(): string {
  const adapter = readFileSync(
    join(repoRoot, "packages/registry/spidermonkey/node-compat/adapter.js"),
    "utf8",
  );
  const bootstrap = readFileSync(
    join(repoRoot, "packages/registry/node-compat/bootstrap.js"),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.startsWith("import * as "))
    .join("\n");
  const suffix = readFileSync(
    join(repoRoot, "packages/registry/spidermonkey/node-compat/suffix.js"),
    "utf8",
  );
  return `${adapter}\n${bootstrap}\n${suffix}`;
}

describe("SpiderMonkey Node bootstrap source", () => {
  it("resolves the full-suite missing built-in and internal module surface", () => {
    const smoke = `
globalThis.evalInWorker = function() {};
${generatedBootstrapSource()}
const names = ${JSON.stringify(historicalMissingBuiltins)};
const failures = [];
for (const name of names) {
  try {
    const mod = require(name);
    if (mod == null) failures.push(name + ": empty module");
  } catch (error) {
    failures.push(name + ": " + (error && error.message || error));
  }
}
const { Worker } = require("worker_threads");
try {
  new Worker("", { eval: true }).postMessage("x");
  failures.push("worker_threads.Worker.postMessage did not report a support boundary");
} catch (error) {
  if (!error || error.code !== "ERR_KANDELO_UNSUPPORTED_NODE_API") {
    failures.push("worker_threads.Worker.postMessage: " + (error && error.message || error));
  }
}
const hiddenGlobalNames = [
  "__kandeloRunDueTimers",
  "__kandeloNextTimerDelay",
  "__kandeloCreateWorkerThreads",
  "argv0",
  "execArgv",
  "TextEncoder",
  "TextDecoder",
  "btoa",
  "atob",
  "Blob",
  "File",
  "FormData",
  "MessagePort",
  "MessageChannel",
  "BroadcastChannel",
  "Event",
  "EventTarget",
  "MessageEvent",
  "CloseEvent",
  "ErrorEvent",
  "DOMException",
  "AbortSignal",
];
for (const name of hiddenGlobalNames) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, name);
  if (!desc) {
    failures.push(name + ": missing global");
  } else if (desc.enumerable) {
    failures.push(name + ": enumerable global");
  }
}
const qs = require("querystring");
for (const value of [undefined, null, 0, true, []]) {
  const actual = qs.stringify(value);
  if (actual !== "") failures.push("querystring.stringify(" + String(value) + "): " + actual);
}
if (qs.stringify([0n, 1n, 2n]) !== "0=0&1=1&2=2") {
  failures.push("querystring.stringify top-level bigint array");
}
if (qs.stringify({ aa: "aa", bb: "bb" }, null, null, { encodeURIComponent: (value) => value[0] }) !== "a=a&b=b") {
  failures.push("querystring.stringify custom encoder");
}
const decoded = qs.parse("a=a&b=b", null, null, { decodeURIComponent: (value) => value + value });
if (decoded.aa !== "aa" || decoded.bb !== "bb") {
  failures.push("querystring.parse custom decoder");
}
if (qs.unescapeBuffer("a+b", true).toString() !== "a b" ||
    qs.unescapeBuffer("a%20").toString() !== "a ") {
  failures.push("querystring.unescapeBuffer");
}
if (failures.length) throw new Error(failures.join("\\n"));
`;
    const child = spawnSync(process.execPath, ["-"], {
      input: smoke,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
  });

  it("drives Node timers and immediates through event-loop turns", () => {
    const main = `
const assert = require("assert");

let ticked = false;
let hit = 0;
const QUEUE = 10;
function runImmediateQueue() {
  if (hit === 0) {
    setTimeout(() => { ticked = true; }, 1);
    const now = Date.now();
    while (Date.now() - now < 2) {}
  }
  if (ticked) return;
  hit++;
  setImmediate(runImmediateQueue);
}
for (let i = 0; i < QUEUE; i++) setImmediate(runImmediateQueue);

let timeoutCalled = false;
setTimeout(function(a, b, c) {
  assert.strictEqual(a, "foo");
  assert.strictEqual(b, "bar");
  assert.strictEqual(c, "baz");
  timeoutCalled = true;
}, 0, "foo", "bar", "baz");

let remaining = 3;
const iv = setInterval(function(a, b, c) {
  assert.strictEqual(a, "foo");
  assert.strictEqual(b, "bar");
  assert.strictEqual(c, "baz");
  if (--remaining === 0) clearInterval(iv);
}, 0, "foo", "bar", "baz");

const inputs = [
  undefined, null, true, false, "", [], {}, NaN, +Infinity, -Infinity,
  (1.0 / 0.0), parseFloat("x"), -10, -1, -0.5, -0.1, -0.0,
  0, 0.0, 0.1, 0.5, 1, 1.0, 2147483648, 12345678901234,
];
const timeouts = [];
const intervals = [];
inputs.forEach((value, index) => {
  setTimeout(() => { timeouts[index] = true; }, value);
  const handle = setInterval(function() {
    clearInterval(this);
    intervals[index] = true;
    assert.strictEqual(this, handle);
  }, value);
});

setTimeout(() => {
  inputs.forEach((value, index) => {
    assert.strictEqual(timeouts[index], true, "timeout " + index + " " + value);
    assert.strictEqual(intervals[index], true, "interval " + index + " " + value);
  });
}, 2);

process.on("exit", () => {
  assert.strictEqual(hit, QUEUE);
  assert.strictEqual(timeoutCalled, true);
  assert.strictEqual(remaining, 0);
  console.log("timer-ok");
});
`;

    const smoke = `
const nativeProcess = process;
globalThis.evalInWorker = function() {};
globalThis.quit = (code) => nativeProcess.exit(code | 0);
globalThis.putstr = (text) => nativeProcess.stdout.write(String(text));
globalThis.printErr = (text) => nativeProcess.stderr.write(String(text) + "\\n");
globalThis.scriptPath = "/main.js";
globalThis.scriptArgs = [];
const files = new Map([["/main.js", ${JSON.stringify(main)}]]);
function statFor(path) {
  if (files.has(path)) return { mode: 0o100000, size: files.get(path).length };
  if (path === "/") return { mode: 0o40000, size: 0 };
  throw new Error("ENOENT: " + path);
}
globalThis.os = {
  getenv() { return null; },
  getcwd() { return "/"; },
  getpid() { return 1; },
  kill() { return 0; },
  file: {
    readFile(path) {
      if (files.has(String(path))) return files.get(String(path));
      throw new Error("ENOENT: " + path);
    },
    stat(path) { return statFor(String(path)); },
    lstat(path) { return statFor(String(path)); },
    realpath(path) {
      path = String(path);
      if (files.has(path) || path === "/") return path;
      throw new Error("ENOENT: " + path);
    },
  },
};
${generatedBootstrapSource()}
`;
    const child = spawnSync(process.execPath, ["-"], {
      input: smoke,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("timer-ok");
  });
});
