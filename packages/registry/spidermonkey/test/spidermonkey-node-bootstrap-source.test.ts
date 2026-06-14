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

function runBootstrapSmoke(source: string): void {
  const smoke = `
globalThis.evalInWorker = function() {};
${generatedBootstrapSource()}
(async () => {
${source}
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
`;
  const child = spawnSync(process.execPath, ["-"], {
    input: smoke,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
}

describe("SpiderMonkey Node bootstrap source", () => {
  it("resolves the full-suite missing built-in and internal module surface", () => {
    runBootstrapSmoke(`
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
const v8 = require("v8");
const heapStats = v8.getHeapStatistics();
if (typeof heapStats.heap_size_limit !== "number" ||
    typeof heapStats.used_heap_size !== "number" ||
    typeof heapStats.external_memory !== "number") {
  failures.push("v8.getHeapStatistics shape");
}
const codeStats = v8.getHeapCodeStatistics();
if (typeof codeStats.code_and_metadata_size !== "number" ||
    typeof codeStats.bytecode_and_metadata_size !== "number") {
  failures.push("v8.getHeapCodeStatistics shape");
}
if (!Array.isArray(v8.getHeapSpaceStatistics()) ||
    !v8.getHeapSpaceStatistics().every((entry) => typeof entry.space_name === "string")) {
  failures.push("v8.getHeapSpaceStatistics shape");
}
const versionTag1 = v8.cachedDataVersionTag();
v8.setFlagsFromString("--expose-gc");
const versionTag2 = v8.cachedDataVersionTag();
if (typeof versionTag1 !== "number" || typeof versionTag2 !== "number" || versionTag1 === versionTag2) {
  failures.push("v8.cachedDataVersionTag/setFlagsFromString compatibility");
}
const heapSnapshot = v8.getHeapSnapshot();
if (!heapSnapshot || typeof heapSnapshot.on !== "function") {
  failures.push("v8.getHeapSnapshot stream shape");
}
if (v8.startupSnapshot.isBuildingSnapshot() !== false) {
  failures.push("v8.startupSnapshot.isBuildingSnapshot");
}
for (const [name, fn] of [
  ["addSerializeCallback", () => v8.startupSnapshot.addSerializeCallback(() => {})],
  ["addDeserializeCallback", () => v8.startupSnapshot.addDeserializeCallback(() => {})],
  ["setDeserializeMainFunction", () => v8.startupSnapshot.setDeserializeMainFunction(() => {})],
]) {
  try {
    fn();
    failures.push("v8.startupSnapshot." + name + " did not throw");
  } catch (error) {
    if (!error || error.code !== "ERR_NOT_BUILDING_SNAPSHOT") {
      failures.push("v8.startupSnapshot." + name + ": " + (error && error.code || error));
    }
  }
}
for (const [name, fn] of [
  ["serialize", () => v8.serialize({ value: 1 })],
  ["deserialize", () => v8.deserialize(Buffer.from([]))],
  ["queryObjects", () => v8.queryObjects(function Probe() {})],
  ["GCProfiler.start", () => new v8.GCProfiler().start()],
  ["writeHeapSnapshot", () => v8.writeHeapSnapshot()],
]) {
  try {
    fn();
    failures.push("v8." + name + " did not report support boundary");
  } catch (error) {
    if (!error || error.code !== "ERR_KANDELO_UNSUPPORTED_NODE_API") {
      failures.push("v8." + name + ": " + (error && error.code || error));
    }
  }
}
if (failures.length) throw new Error(failures.join("\\n"));
`);
  });

  it("matches supported worker_threads MessagePort semantics", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const util = require("util");
const {
  MessageChannel,
  MessagePort,
  markAsUntransferable,
  isMarkedAsUntransferable,
  moveMessagePortToContext,
  receiveMessageOnPort,
} = require("worker_threads");

const { port1, port2 } = new MessageChannel();
assert(port1 instanceof MessagePort);
assert.strictEqual(port1.constructor, MessagePort);
assert.throws(() => MessagePort(), { constructor: TypeError, code: "ERR_CONSTRUCT_CALL_INVALID" });
assert.throws(() => new MessagePort(), { constructor: TypeError, code: "ERR_CONSTRUCT_CALL_INVALID" });
assert.throws(() => MessageChannel(), { constructor: TypeError, code: "ERR_CONSTRUCT_CALL_REQUIRED" });
assert.deepStrictEqual(Object.getOwnPropertyNames(MessagePort.prototype).sort(), [
  "close", "constructor", "hasRef", "onmessage", "onmessageerror",
  "postMessage", "ref", "start", "unref",
]);

assert.strictEqual(receiveMessageOnPort(port2), undefined);
port1.postMessage({ hello: "world" });
port1.postMessage({ foo: "bar" });
assert.deepStrictEqual(receiveMessageOnPort(port2), { message: { hello: "world" } });
assert.deepStrictEqual(receiveMessageOnPort(port2), { message: { foo: "bar" } });
assert.strictEqual(receiveMessageOnPort(port2), undefined);

port2.on("message", () => { throw new Error("message handler should not run before receiveMessageOnPort"); });
port1.postMessage({ later: true });
assert.deepStrictEqual(receiveMessageOnPort(port2), { message: { later: true } });

let eventTargetCalls = 0;
let eventEmitterCalls = 0;
port2.addEventListener("foo", (event) => {
  eventTargetCalls++;
  assert.strictEqual(event.type, "foo");
  assert.strictEqual(event.detail, "bar");
});
port2.on("foo", (value) => {
  eventEmitterCalls++;
  assert.strictEqual(value, "bar");
});
port2.emit("foo", "bar");
assert.strictEqual(eventTargetCalls, 1);
assert.strictEqual(eventEmitterCalls, 1);

for (const value of [null, 0, -1, {}, []]) {
  assert.throws(() => receiveMessageOnPort(value), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
    message: "The \\"port\\" argument must be a MessagePort instance",
  });
}

const invalidTransferList = {
  constructor: TypeError,
  code: "ERR_INVALID_ARG_TYPE",
  message: "Optional transferList argument must be an iterable",
};
for (const value of [0, false, "X", Symbol("X")]) {
  assert.throws(() => port1.postMessage(5, value), invalidTransferList);
}
const invalidTransferOption = {
  constructor: TypeError,
  code: "ERR_INVALID_ARG_TYPE",
  message: "Optional options.transfer argument must be an iterable",
};
for (const value of [null, 0, false, {}]) {
  assert.throws(() => port1.postMessage(5, { transfer: value }), invalidTransferOption);
}

const ab = new ArrayBuffer(8);
markAsUntransferable(ab);
assert.ok(isMarkedAsUntransferable(ab));
assert.throws(() => port1.postMessage(ab, [ab]), { code: 25, name: "DataCloneError" });
assert.strictEqual(ab.byteLength, 8);

const duplicatePort = new MessageChannel().port1;
assert.throws(() => port1.postMessage(duplicatePort, [duplicatePort, duplicatePort]), {
  code: 25,
  name: "DataCloneError",
  message: "Transfer list contains duplicate MessagePort",
});
const duplicateBuffer = new ArrayBuffer(4);
assert.throws(() => port1.postMessage(duplicateBuffer, [duplicateBuffer, duplicateBuffer]), {
  code: 25,
  name: "DataCloneError",
  message: "Transfer list contains duplicate ArrayBuffer",
});
assert.throws(() => port1.postMessage(null, [port1]), {
  code: 25,
  name: "DataCloneError",
  message: "Transfer list contains source port",
});
const closed = new MessageChannel();
closed.port1.close();
const notDetached = new ArrayBuffer(10);
assert.throws(() => closed.port2.postMessage(null, [notDetached, closed.port1]), {
  code: 25,
  name: "DataCloneError",
  message: "MessagePort in transfer list is already detached",
});
assert.strictEqual(notDetached.byteLength, 10);
assert.throws(() => moveMessagePortToContext(closed.port1, {}), {
  code: "ERR_CLOSED_MESSAGE_PORT",
  message: "Cannot send data on closed MessagePort",
});
assert.match(util.inspect(port1), /active: true/);
port1.close();
assert.match(util.inspect(port1), /active: false/);
`);
  });

  it("matches supported worker_threads MessageEvent and BroadcastChannel semantics", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const { inspect } = require("util");
const {
  BroadcastChannel,
  MessageChannel,
  receiveMessageOnPort,
} = require("worker_threads");
const { MessageEvent: KandeloMessageEvent } = require("internal/worker/io");

const dummyPort = new MessageChannel().port1;
for (const [args, expected] of [
  [["message"], { type: "message", data: null, origin: "", lastEventId: "", source: null, ports: [] }],
  [["message", { data: undefined, origin: "foo" }], { type: "message", data: null, origin: "foo", lastEventId: "", source: null, ports: [] }],
  [["message", { data: 2, origin: 1, lastEventId: 0 }], { type: "message", data: 2, origin: "1", lastEventId: "0", source: null, ports: [] }],
  [["messageerror", { lastEventId: "foo", source: dummyPort }], { type: "messageerror", data: null, origin: "", lastEventId: "foo", source: dummyPort, ports: [] }],
  [["message", { ports: [dummyPort], source: null }], { type: "message", data: null, origin: "", lastEventId: "", source: null, ports: [dummyPort] }],
]) {
  const ev = new KandeloMessageEvent(...args);
  const { type, data, origin, lastEventId, source, ports } = ev;
  assert.deepStrictEqual({ type, data, origin, lastEventId, source, ports }, expected);
  assert(ev instanceof Event);
}
assert.throws(() => new KandeloMessageEvent("message", { source: 1 }), {
  code: "ERR_INVALID_ARG_TYPE",
  message: /The "init\\.source" property must be an instance of MessagePort/,
});
assert.throws(() => new KandeloMessageEvent("message", { ports: 0 }), {
  message: /ports is not iterable/,
});
assert.throws(() => new KandeloMessageEvent("message", { ports: [null] }), {
  code: "ERR_INVALID_ARG_TYPE",
  message: /The "init\\.ports\\[0\\]" property must be an instance of MessagePort/,
});

assert.throws(() => new BroadcastChannel(Symbol("test")), {
  message: /Cannot convert a Symbol value to a string/,
});
assert.throws(() => new BroadcastChannel(), {
  message: /The "name" argument must be specified/,
});
for (const value of [undefined, 1, null, "test", 1n, false, Infinity]) {
  const bc = new BroadcastChannel(value);
  assert.strictEqual(bc.name, String(value));
  bc.close();
}

const bc = new BroadcastChannel("name");
assert.throws(() => bc[inspect.custom].call(), { code: "ERR_INVALID_THIS" });
assert.strictEqual(inspect(bc, { depth: -1 }), "BroadcastChannel");
assert.strictEqual(inspect(bc), "BroadcastChannel { name: 'name', active: true }");
bc.close();
assert.strictEqual(inspect(bc.ref()), "BroadcastChannel { name: 'name', active: false }");

const bc1 = new BroadcastChannel("channel");
const bc2 = new BroadcastChannel("channel");
bc1.postMessage("some data");
assert.strictEqual(receiveMessageOnPort(bc2).message, "some data");
assert.strictEqual(receiveMessageOnPort(bc2), undefined);
bc1.close();
bc2.close();
assert.throws(() => bc1.postMessage(null), { message: /BroadcastChannel is closed/ });
assert.throws(() => Reflect.get(BroadcastChannel.prototype, "name", {}), { code: "ERR_INVALID_THIS" });
for (const name of ["close", "postMessage", "ref", "unref"]) {
  assert.throws(() => Reflect.apply(BroadcastChannel.prototype[name], [], {}), { code: "ERR_INVALID_THIS" });
}

const c1 = new BroadcastChannel("order");
const c2 = new BroadcastChannel("order");
const c3 = new BroadcastChannel("order");
const events = [];
c1.onmessage = (event) => events.push(event.data);
c2.onmessage = (event) => events.push(event.data);
c3.onmessage = (event) => events.push(event.data);
c1.postMessage("from c1");
c3.postMessage("from c3");
c2.postMessage("done");
await Promise.resolve();
assert.deepStrictEqual(events, ["from c3", "done", "from c1", "from c3", "from c1", "done"]);
c1.close();
c2.close();
c3.close();
`);
  });

  it("tracks worker hasRef state through async_hooks resources", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const { Worker } = require("worker_threads");
const { createHook } = require("async_hooks");
const resources = new Map();

createHook({
  init(asyncId, type, triggerAsyncId, resource) {
    if (type === "WORKER" || type === "MESSAGEPORT") resources.set(asyncId, { type, resource });
  },
  destroy(asyncId) {
    resources.delete(asyncId);
  },
}).enable();

function activeTypes() {
  const active = [];
  for (const { type, resource } of resources.values()) {
    if (typeof resource.hasRef !== "function" || resource.hasRef() === true) active.push(type);
  }
  return active;
}

const worker = new Worker("", { eval: true });
assert.deepStrictEqual(activeTypes(), ["WORKER"]);
worker.unref();
assert.deepStrictEqual(activeTypes(), []);
worker.ref();
assert.deepStrictEqual(activeTypes(), ["WORKER", "MESSAGEPORT"]);

let sawExit = false;
worker.on("exit", (code) => {
  sawExit = true;
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(activeTypes(), ["WORKER"]);
});
await Promise.resolve();
assert.strictEqual(sawExit, true);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepStrictEqual(activeTypes(), []);
`);
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
