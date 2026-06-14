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

  it("implements readline interface, keypress, and raw-mode basics", () => {
    const smoke = `
globalThis.evalInWorker = function() {};
${generatedBootstrapSource()}
const assert = require("assert");
const { PassThrough, Stream } = require("stream");
const readline = require("readline");

assert.strictEqual(readline.Interface, readline.InterfaceConstructor);

{
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = readline.createInterface({ input, output, terminal: true, prompt: "" });
  assert(rl instanceof readline.Interface);
  const lines = [];
  const keys = [];
  rl.on("line", (line) => lines.push(line));
  input.on("keypress", (_sequence, key) => keys.push(key));
  input.write("foo");
  assert.deepStrictEqual(keys.map((key) => key.name), ["f", "o", "o"]);
  assert.strictEqual(rl.line, "foo");
  assert.strictEqual(rl.cursor, 3);
  rl.write(null, { ctrl: true, name: "a" });
  assert.strictEqual(rl.cursor, 0);
  rl.write(null, { meta: true, name: "f" });
  assert.strictEqual(rl.cursor, 3);
  input.write("\\n");
  assert.deepStrictEqual(lines, ["foo"]);
  rl.close();
}

{
  const input = new PassThrough();
  const keys = [];
  readline.emitKeypressEvents(input);
  input.on("keypress", (_sequence, key) => keys.push(key));
  input.write("\\x1b[D");
  input.write("\\x1b\\x1b ");
  assert.deepStrictEqual(keys.map((key) => [key.name, key.code, key.sequence]), [
    ["left", "[D", "\\x1b[D"],
    ["space", undefined, "\\x1b\\x1b "],
  ]);
}

{
  const input = new Stream();
  let rawMode = null;
  let resumed = 0;
  let paused = 0;
  input.setRawMode = (value) => { rawMode = value; };
  input.resume = () => { resumed++; };
  input.pause = () => { paused++; };
  const rl = readline.createInterface({ input, output: input, terminal: true });
  assert.strictEqual(rawMode, true);
  assert.strictEqual(resumed, 1);
  rl.pause();
  assert.strictEqual(paused, 1);
  rl.resume();
  assert.strictEqual(resumed, 2);
  rl.close();
  assert.strictEqual(rawMode, false);
}

{
  const { CSI } = require("internal/readline/utils");
  assert.strictEqual(CSI.kClearLine, "\\x1b[2K");
  assert.strictEqual(CSI\`1\${2}3\`, "\\x1b[123");
}
`;
    const child = spawnSync(process.execPath, ["-"], {
      input: smoke,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
  });
});
