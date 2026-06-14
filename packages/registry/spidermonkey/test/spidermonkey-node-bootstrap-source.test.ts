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

  it("matches Node module metadata, global paths, cache, and package-main edge cases", () => {
    const smoke = `
var hostRequire = require;
var hostFs = hostRequire("node:fs");
var hostPath = hostRequire("node:path");
var hostOs = hostRequire("node:os");
var root = hostFs.mkdtempSync(hostPath.join(hostOs.tmpdir(), "kandelo-module-loader-"));
var nodePathDir = hostPath.join(root, "node-path");
var homeDir = hostPath.join(root, "home");
hostFs.mkdirSync(hostPath.join(nodePathDir, "global-pkg"), { recursive: true });
hostFs.writeFileSync(hostPath.join(nodePathDir, "global-pkg", "index.js"), "module.exports = 'node-path';\\n");
hostFs.mkdirSync(hostPath.join(homeDir, ".node_modules", "home-pkg"), { recursive: true });
hostFs.writeFileSync(hostPath.join(homeDir, ".node_modules", "home-pkg", "index.js"), "module.exports = 'home';\\n");
var noMainDir = hostPath.join(root, "node_modules", "no-main-field");
hostFs.mkdirSync(noMainDir, { recursive: true });
hostFs.writeFileSync(hostPath.join(noMainDir, "package.json"), "{}\\n");
hostFs.writeFileSync(hostPath.join(noMainDir, "index.js"), "module.exports = 'no main field';\\n");
var stubDir = hostPath.join(root, "module-stub");
hostFs.mkdirSync(hostPath.join(stubDir, "one-trailing-slash", "two"), { recursive: true });
hostFs.writeFileSync(hostPath.join(root, "module-stub.json"), JSON.stringify({ rocko: "artischocko" }));
hostFs.writeFileSync(hostPath.join(stubDir, "package.json"), JSON.stringify({ main: "./index.js" }));
hostFs.writeFileSync(hostPath.join(stubDir, "index.js"), "module.exports = 'hello from module-stub!';\\n");
hostFs.writeFileSync(
  hostPath.join(stubDir, "one-trailing-slash", "two", "three.js"),
  "module.exports = require('../../');\\n",
);

globalThis.os = {
  file: {
    readFile(path, mode) {
      return mode === "binary" ? hostFs.readFileSync(String(path)) : hostFs.readFileSync(String(path), "utf8");
    },
    stat(path) {
      var st = hostFs.statSync(String(path));
      return { mode: st.mode, size: st.size, atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000, ctime: st.ctimeMs / 1000 };
    },
    lstat(path) {
      var st = hostFs.lstatSync(String(path));
      return { mode: st.mode, size: st.size, atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000, ctime: st.ctimeMs / 1000 };
    },
    listDir(path) { return hostFs.readdirSync(String(path)); },
    realpath(path) { return hostFs.realpathSync(String(path)); },
  },
  getenv(key) {
    if (key === "HOME") return homeDir;
    if (key === "NODE_PATH") return nodePathDir + ":";
    if (key === "PATH") return "/usr/bin:/bin";
    return null;
  },
  getcwd() { return root; },
  realpath(path) { return [hostFs.realpathSync(String(path)), 0]; },
};
globalThis.__kandeloNodeNative = {
  evalScriptAsFunction(source, filename) {
    return (0, eval)(source + "\\n//# sourceURL=" + filename);
  },
};
globalThis.evalInWorker = function() {};
${generatedBootstrapSource()}

var assert = require("assert");
var Module = require("module");
assert(Module.builtinModules.includes("http"));
assert(Module.builtinModules.includes("sys"));
assert(Module.builtinModules.includes("node:test"));
assert.deepStrictEqual(Module.builtinModules.filter((name) => name.startsWith("internal/")), []);
assert.strictEqual(Module.isBuiltin("http"), true);
assert.strictEqual(Module.isBuiltin("node:fs"), true);
assert.strictEqual(Module.isBuiltin("node:test"), true);
assert.strictEqual(Module.isBuiltin("test"), false);
assert.strictEqual(Module.isBuiltin("internal/errors"), false);
assert.throws(() => Module.createRequire("../"), { code: "ERR_INVALID_ARG_VALUE" });
assert.throws(() => Module.createRequire({}), {
  code: "ERR_INVALID_ARG_VALUE",
  message: "The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received {}",
});
Module._initPaths();
assert(Module.globalPaths.includes(nodePathDir));
assert(Module.globalPaths.includes(hostPath.join(homeDir, ".node_modules")));
assert.strictEqual(Module._resolveLookupPaths("./x")[0], ".");
assert.notStrictEqual(Module._resolveLookupPaths(".\\\\\\\\x")[0], ".");
assert.strictEqual(require("global-pkg"), "node-path");
assert.strictEqual(require("home-pkg"), "home");
var fakeFs = {};
require.cache.fs = { exports: fakeFs };
assert.strictEqual(require("fs"), fakeFs);
assert.notStrictEqual(require("node:fs"), fakeFs);
delete require.cache.fs;
Object.defineProperty(Object.prototype, "main", {
  configurable: true,
  get() { throw new Error("Object.prototype.main getter was reached"); },
});
try {
  assert.strictEqual(require("no-main-field"), "no main field");
  assert.strictEqual(require(hostPath.join(stubDir, "one-trailing-slash", "two", "three.js")), "hello from module-stub!");
} finally {
  delete Object.prototype.main;
  hostFs.rmSync(root, { recursive: true, force: true });
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
