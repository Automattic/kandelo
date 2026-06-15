import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

function generatedBootstrapSource(
  options: { withoutEventGlobalAfterAdapter?: boolean } = {},
): string {
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
  const preBootstrap = options.withoutEventGlobalAfterAdapter
    ? "try { globalThis.Event = undefined; } catch {}\n"
    : "";
  return `${adapter}\n${preBootstrap}${bootstrap}\n${suffix}`;
}

function runBootstrapSmoke(
  source: string,
  options: { withoutEventGlobal?: boolean } = {},
): void {
  const smoke = `
globalThis.evalInWorker = function() {};
${generatedBootstrapSource({ withoutEventGlobalAfterAdapter: options.withoutEventGlobal })}
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

function runBootstrapCli(args: string[], options: {
  cwd?: string;
  env?: Record<string, string>;
} = {}): { status: number | null; stdout: string; stderr: string } {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? {};
  const source = `
const nodeProcess = process;
const nodeFs = require('node:fs');
const nodePath = require('node:path');
globalThis.quit = (code) => nodeProcess.exit(code | 0);
globalThis.drainJobQueue = () => {
  if (typeof nodeProcess._tickCallback === 'function') nodeProcess._tickCallback();
};
globalThis.scriptArgs = ${JSON.stringify(args)};
globalThis.argv0 = '/usr/bin/node';
let currentCwd = ${JSON.stringify(cwd)};
const env = ${JSON.stringify(env)};
let nextFd = 100;
const fdMap = new Map();
function toMode(stats) {
  return stats.isDirectory() ? 0o40000 : stats.isSymbolicLink() ? 0o120000 : 0o100000;
}
function toStat(path) {
  const stats = nodeFs.statSync(path);
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: toMode(stats) | (stats.mode & 0o777),
    nlink: stats.nlink,
    uid: stats.uid,
    gid: stats.gid,
    rdev: stats.rdev,
    size: stats.size,
    blocks: stats.blocks || 0,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
    ctime: Math.floor(stats.ctimeMs / 1000),
  };
}
globalThis.os = {
  getenv(name) {
    if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
    return nodeProcess.env[name] ?? null;
  },
  getcwd() { return currentCwd; },
  chdir(path) { currentCwd = nodePath.resolve(currentCwd, String(path)); return 0; },
  getpid() { return nodeProcess.pid; },
  open(path, flags, mode) {
    let nodeFlag = 'r';
    if (flags & 0o2000) nodeFlag = 'a';
    else if (flags & 0o1000) nodeFlag = 'w';
    else if (flags & 1 || flags & 2) nodeFlag = 'r+';
    if (flags & 0o100 && nodeFlag === 'r+') nodeFlag = 'w+';
    try {
      const fd = nodeFs.openSync(String(path), nodeFlag, mode || 0o666);
      const virtualFd = nextFd++;
      fdMap.set(virtualFd, fd);
      return virtualFd;
    } catch {
      return -2;
    }
  },
  close(fd) {
    if (fdMap.has(fd)) {
      nodeFs.closeSync(fdMap.get(fd));
      fdMap.delete(fd);
    }
    return 0;
  },
  write(fd, buffer, byteOffset, length) {
    const bytes = Buffer.from(new Uint8Array(buffer, byteOffset || 0, length));
    if (fdMap.has(fd)) {
      nodeFs.writeSync(fdMap.get(fd), bytes);
      return bytes.length;
    }
    if (fd === 2) nodeProcess.stderr.write(bytes);
    else nodeProcess.stdout.write(bytes);
    return bytes.length;
  },
  file: {
    readFile(path, mode) {
      path = String(path);
      return mode === 'binary' ? nodeFs.readFileSync(path) : nodeFs.readFileSync(path, 'utf8');
    },
    stat: toStat,
    lstat(path) {
      const stats = nodeFs.lstatSync(path);
      return {
        dev: stats.dev,
        ino: stats.ino,
        mode: toMode(stats) | (stats.mode & 0o777),
        nlink: stats.nlink,
        uid: stats.uid,
        gid: stats.gid,
        rdev: stats.rdev,
        size: stats.size,
        blocks: stats.blocks || 0,
        atime: Math.floor(stats.atimeMs / 1000),
        mtime: Math.floor(stats.mtimeMs / 1000),
        ctime: Math.floor(stats.ctimeMs / 1000),
      };
    },
    listDir(path) { return nodeFs.readdirSync(path); },
    mkdir(path) { nodeFs.mkdirSync(path, { recursive: false }); return 0; },
    realpath(path) { return nodeFs.realpathSync(path); },
  },
};
globalThis.evalInWorker = function() {};
${generatedBootstrapSource()}
`;
  const child = spawnSync(process.execPath, ["-"], {
    input: source,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe("SpiderMonkey Node bootstrap source", () => {
  it("constructs internal worker MessageEvent after installing Event globals", () => {
    const bootstrap = readFileSync(
      join(repoRoot, "packages/registry/node-compat/bootstrap.js"),
      "utf8",
    );
    const factoryIndex = bootstrap.indexOf("function _createInternalWorkerIo()");
    const placeholderIndex = bootstrap.indexOf("'internal/worker/io': null");
    const eventGlobalIndex = bootstrap.indexOf("_defineGlobal('Event', KandeloEvent);");
    const installIndex = bootstrap.indexOf("_builtinModules['internal/worker/io'] = _createInternalWorkerIo();");

    expect(factoryIndex).toBeGreaterThanOrEqual(0);
    expect(placeholderIndex).toBeGreaterThan(factoryIndex);
    expect(eventGlobalIndex).toBeGreaterThan(placeholderIndex);
    expect(installIndex).toBeGreaterThan(eventGlobalIndex);
  });

  it("drains eval-mode Node work through the generated event-loop hook", () => {
    runBootstrapSmoke(`
const assert = require("assert");
assert.strictEqual(__kandeloRunNodeEventLoop(), 0);
`);
  });

  it("emits process exit diagnostics on natural SpiderMonkey completion", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const events = [];
process.on("beforeExit", (code) => events.push(["beforeExit", code]));
process.on("exit", (code) => events.push(["exit", code]));
assert.strictEqual(__kandeloRunNodeEventLoop(), 0);
assert.deepStrictEqual(events, [["beforeExit", 0], ["exit", 0]]);
`);
  });

  it("serializes URLSearchParams unpaired surrogates as replacement characters", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const url = require("url");
const values = [
  "a",
  1,
  true,
  undefined,
  null,
  "\\uD83D",
  "\\uDE00",
  "\\uD83D\\uDE00",
  "\\uDE00\\uD83D",
  {},
];
const normalized = [
  "a",
  "1",
  "true",
  "undefined",
  "null",
  "\\uFFFD",
  "\\uFFFD",
  "\\uD83D\\uDE00",
  "\\uFFFD\\uFFFD",
  "[object Object]",
];
const serialized = "a=a&a=1&a=true&a=undefined&a=null&a=%EF%BF%BD" +
  "&a=%EF%BF%BD&a=%F0%9F%98%80&a=%EF%BF%BD%EF%BF%BD" +
  "&a=%5Bobject+Object%5D";

for (const SearchParams of [URLSearchParams, url.URLSearchParams]) {
  const params = new SearchParams();
  for (const value of values) params.append("a", value);
  assert.strictEqual(String(params), serialized);
  assert.deepStrictEqual(params.getAll("a"), normalized);
  assert.strictEqual(String(new SearchParams([["a", "\\uD83D"]])), "a=%EF%BF%BD");
  assert.strictEqual(String(new SearchParams({ a: "\\uDE00" })), "a=%EF%BF%BD");
}

const parsed = new URL("http://example.org");
for (const value of values) parsed.searchParams.append("a", value);
assert.strictEqual(parsed.search, "?" + serialized);
assert.strictEqual(parsed.href, "http://example.org/?" + serialized);
assert.deepStrictEqual(parsed.searchParams.getAll("a"), normalized);

parsed.search = "my%20weird%20field=q1!2%22'w%245%267%2Fz8)%3F";
assert.strictEqual(
  String(parsed.searchParams),
  "my+weird+field=q1%212%22%27w%245%267%2Fz8%29%3F",
);
assert.deepStrictEqual(Array.from(parsed.searchParams), [
  ["my weird field", "q1!2\\"'w$5&7/z8)?"],
]);
`);
  });

  it("parses Node self-exec CLI options from scriptArgs", () => {
    expect(runBootstrapCli(["--eval", "console.log(123)"])).toEqual({
      status: 0,
      stdout: "123\n",
      stderr: "",
    });

    expect(
      runBootstrapCli([
        "--eval",
        "console.log(require('path').basename('/tmp/demo.js'), module.id, __filename)",
      ]),
    ).toEqual({
      status: 0,
      stdout: "demo.js [eval] [eval]\n",
      stderr: "",
    });

    expect(
      runBootstrapCli([
        "--print",
        "process.argv.slice(1).join(',')",
        "--",
        "alpha",
        "--",
        "beta",
      ]),
    ).toEqual({
      status: 0,
      stdout: "alpha,--,beta\n",
      stderr: "",
    });

    expect(
      runBootstrapCli(["--use-strict", "-p", "process.execArgv"]),
    ).toEqual({
      status: 0,
      stdout: "[ '--use-strict', '-p', 'process.execArgv' ]\n",
      stderr: "",
    });

    expect(runBootstrapCli(["--eval"])).toEqual({
      status: 9,
      stdout: "",
      stderr: "/usr/bin/node: --eval requires an argument\n",
    });

    expect(runBootstrapCli(["--eval="])).toEqual({
      status: 9,
      stdout: "",
      stderr: "/usr/bin/node: --eval= requires an argument\n",
    });

    expect(runBootstrapCli(["--inspect-port="])).toEqual({
      status: 9,
      stdout: "",
      stderr: "/usr/bin/node: --inspect-port= requires an argument\n",
    });

    expect(runBootstrapCli(["--bad-kandelo-option"])).toEqual({
      status: 9,
      stdout: "",
      stderr: "/usr/bin/node: bad option: --bad-kandelo-option\n",
    });

    expect(
      runBootstrapCli(
        [
          "--eval",
          "console.log(require('internal/options').getOptionValue('--redirect-warnings'))",
        ],
        { env: { NODE_OPTIONS: "--redirect-warnings=foó" } },
      ),
    ).toEqual({
      status: 0,
      stdout: "foó\n",
      stderr: "",
    });

    expect(runBootstrapCli([], { env: { NODE_OPTIONS: "--eval" } })).toEqual({
      status: 9,
      stdout: "",
      stderr: "/usr/bin/node: --eval is not allowed in NODE_OPTIONS\n",
    });
  });

  it("loads CLI dotenv files before applying NODE_OPTIONS", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-node-dotenv-"));
    try {
      writeFileSync(
        join(root, "node-options.env"),
        [
          "NODE_OPTIONS=\"--experimental-permission --allow-fs-read=*\"",
          "NODE_NO_WARNINGS=1",
        ].join("\n"),
      );

      const result = runBootstrapCli(
        [
          "--env-file",
          "node-options.env",
          "--eval",
          "console.log(JSON.stringify({ warn: process.env.NODE_NO_WARNINGS, canRead: process.permission.has('fs.read', process.cwd()) }))",
        ],
        { cwd: root },
      );

      expect(result).toEqual({
        status: 0,
        stdout: "{\"warn\":\"1\",\"canRead\":true}\n",
        stderr: "",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs CLI preload modules before the main script with package self references", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-node-preload-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "self_ref", exports: "./index.js" }));
      writeFileSync(join(root, "index.js"), "console.log('self-ref:' + __filename);");
      writeFileSync(join(root, "preload.js"), "console.log('preload:' + JSON.stringify({ argv: process.argv, execArgv: process.execArgv }));");
      writeFileSync(join(root, "main.js"), "console.log('main:' + JSON.stringify({ argv: process.argv, execArgv: process.execArgv }));");

      const result = runBootstrapCli(
        ["node", "-r", "./preload.js", "-r", "self_ref", "main.js", "alpha"],
        { cwd: root },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        `preload:${JSON.stringify({ argv: ["/usr/bin/node", join(root, "main.js"), "alpha"], execArgv: ["-r", "./preload.js", "-r", "self_ref"] })}`,
        `self-ref:${realpathSync(join(root, "index.js"))}`,
        `main:${JSON.stringify({ argv: ["/usr/bin/node", join(root, "main.js"), "alpha"], execArgv: ["-r", "./preload.js", "-r", "self_ref"] })}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs CLI preloads before print-eval expressions", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-node-print-preload-"));
    try {
      writeFileSync(join(root, "preload.js"), "console.log('preload:' + JSON.stringify({ argv: process.argv, execArgv: process.execArgv }));");
      const result = runBootstrapCli(["node", "-r", "./preload.js", "-pe", "1+1", "tail"], { cwd: root });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        `preload:${JSON.stringify({ argv: ["/usr/bin/node", "tail"], execArgv: ["-r", "./preload.js", "-pe", "1+1"] })}`,
        "2",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inserts the SpiderMonkey argument separator for Node child self-exec", () => {
    const smoke = `
globalThis.evalInWorker = function() {};
const commands = [];
globalThis.os = {
  getenv() { return null; },
  getpid() { return 1; },
  getcwd() { return ["/work", 0]; },
  chdir() { return 0; },
  popenRead(command) {
    commands.push(String(command));
    return { output: "", status: 0 };
  },
};
${generatedBootstrapSource()}
const assert = require("assert");
const cp = require("child_process");
const spawned = cp.spawnSync(process.execPath, ["--eval", "console.log(1)"], {
  encoding: "utf8",
  stdio: ["pipe", "pipe", "inherit"],
});
assert.strictEqual(spawned.status, 0, JSON.stringify({
  status: spawned.status,
  stdout: spawned.stdout && String(spawned.stdout),
  stderr: spawned.stderr && String(spawned.stderr),
}));
assert.strictEqual(spawned.stdout, "1\\n");
cp.execSync(JSON.stringify(process.execPath) + " --print \\"40 + 2\\"", {
  stdio: ["pipe", "pipe", "inherit"],
});
assert.strictEqual(commands.length, 1, JSON.stringify(commands));
assert(/--\\s+--print\\b/.test(commands[0]), JSON.stringify(commands[0]));
`;
    const child = spawnSync(process.execPath, ["-"], {
      input: smoke,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
  });

  it("defers child_process async completion on the immediate turn", () => {
    const source = generatedBootstrapSource();

    expect(source).toContain("function deferChildProcess(fn)");
    expect(source).toContain("timers.setImmediate(fn)");
    expect(source).toContain("deferChildProcess(() => {");
  });

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
  "__kandeloFinalizeProcessExit",
  "__kandeloRunDueTimers",
  "__kandeloNextTimerDelay",
  "__kandeloCreateWorkerThreads",
  "__kandeloAsyncHooksPromise",
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
function expectPath(label, actual, expected) {
  if (actual !== expected) failures.push(label + ": " + JSON.stringify(actual) + " !== " + JSON.stringify(expected));
}
const bs = String.fromCharCode(92);
const nodePath = require("path");
expectPath("path.basename", nodePath.basename("/dir/basename.ext"), "basename.ext");
expectPath("path.basename trailing slash", nodePath.basename("basename.ext//"), "basename.ext");
expectPath("path.dirname", nodePath.dirname("/a/b/"), "/a");
expectPath("path.extname dotfile", nodePath.extname(".."), "");
expectPath("path.join trailing slash", nodePath.join("foo/", ""), "foo/");
expectPath("path.posix export", require("path/posix").join("a", "b"), "a/b");
expectPath("node:path/posix export", require("node:path/posix").dirname("/a/b/"), "/a");
expectPath("path.win32 export", require("path/win32").sep, bs);
expectPath("node:path/win32 export", require("node:path/win32").delimiter, ";");
expectPath("path.win32.basename", nodePath.win32.basename(bs + "dir" + bs + "basename.ext"), "basename.ext");
expectPath("path.win32.dirname", nodePath.win32.dirname("c:" + bs + "foo" + bs + "bar" + bs), "c:" + bs + "foo");
expectPath("path.win32.extname", nodePath.win32.extname(bs + "path.to" + bs + "file"), "");
expectPath("path.win32.join unc", nodePath.win32.join("//foo", "bar"), bs + bs + "foo" + bs + "bar" + bs);
expectPath("path.win32.normalize", nodePath.win32.normalize("fixtures///b/../b/c.js"), "fixtures" + bs + "b" + bs + "c.js");
expectPath("path.win32.resolve drive", nodePath.win32.resolve("c:/blah" + bs + "blah", "d:/games", "c:../a"), "c:" + bs + "blah" + bs + "a");
expectPath("path.win32.resolve unc", nodePath.win32.resolve("//server/share", "..", "relative" + bs), bs + bs + "server" + bs + "share" + bs + "relative");
expectPath("path.win32.relative case-insensitive", nodePath.win32.relative("c:/AaAa/bbbb", "c:/aaaa/bbbb"), "");
expectPath("path.win32.relative child", nodePath.win32.relative("C:" + bs + "foo" + bs + "test", "C:" + bs + "foo" + bs + "test" + bs + "bar" + bs + "package.json"), "bar" + bs + "package.json");
expectPath("path.win32.isAbsolute unc", nodePath.win32.isAbsolute(bs + bs + "server"), true);
expectPath("path.win32.isAbsolute drive-relative", nodePath.win32.isAbsolute("C:foo"), false);
expectPath("path.posix.parse", JSON.stringify(nodePath.posix.parse("/home/user/file.txt")), JSON.stringify({ root: "/", dir: "/home/user", base: "file.txt", ext: ".txt", name: "file" }));
expectPath("path.posix.format", nodePath.posix.format({ dir: "/home/user", base: "file.txt" }), "/home/user/file.txt");
expectPath("path.win32.parse", JSON.stringify(nodePath.win32.parse("C:" + bs + "path" + bs + "dir" + bs + "index.html")), JSON.stringify({ root: "C:" + bs, dir: "C:" + bs + "path" + bs + "dir", base: "index.html", ext: ".html", name: "index" }));
expectPath("path.win32.format", nodePath.win32.format({ dir: "C:" + bs + "path" + bs + "dir", base: "index.html" }), "C:" + bs + "path" + bs + "dir" + bs + "index.html");
expectPath("path.win32.toNamespacedPath drive", nodePath.win32.toNamespacedPath("C:/foo"), bs + bs + "?" + bs + "C:" + bs + "foo");
expectPath("path.win32.toNamespacedPath unc", nodePath.win32.toNamespacedPath("//foo//bar"), bs + bs + "?" + bs + "UNC" + bs + "foo" + bs + "bar" + bs);
expectPath("path.toNamespacedPath posix non-string", nodePath.toNamespacedPath(null), null);
expectPath("path.posix._makeLong", nodePath.posix._makeLong("/tmp/x"), "/tmp/x");
if (failures.length) throw new Error(failures.join("\\n"));
`);
  });

  it("matches diagnostics_channel bootstrap semantics", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const dc = require("diagnostics_channel");
const { AsyncLocalStorage } = require("async_hooks");

assert.deepStrictEqual(Object.keys(dc).sort(), [
  "Channel",
  "channel",
  "hasSubscribers",
  "subscribe",
  "tracingChannel",
  "unsubscribe",
]);
assert.strictEqual("TracingChannel" in dc, false);

const seen = [];
const channel = dc.channel("probe");
assert.strictEqual(channel, dc.channel("probe"));
assert.ok(channel instanceof dc.Channel);
assert.strictEqual(channel.hasSubscribers, false);
assert.strictEqual(dc.hasSubscribers("probe"), false);
const subscriber = (message, name) => seen.push([message.value, name]);
assert.strictEqual(dc.subscribe("probe", subscriber), undefined);
assert.strictEqual(channel.hasSubscribers, true);
assert.strictEqual(dc.hasSubscribers("probe"), true);
channel.publish({ value: 1 });
assert.strictEqual(dc.unsubscribe("probe", subscriber), true);
assert.strictEqual(dc.unsubscribe("probe", subscriber), false);
assert.strictEqual(channel.hasSubscribers, false);
channel.publish({ value: 2 });

const symbol = Symbol("named");
dc.channel(symbol).subscribe((message, name) => seen.push([message.value, name === symbol]));
dc.channel(symbol).publish({ value: 3 });
assert.throws(() => channel.subscribe(null), { code: "ERR_INVALID_ARG_TYPE" });
assert.deepStrictEqual(seen, [
  [1, "probe"],
  [3, true],
]);

const tracing = dc.tracingChannel("trace");
assert.strictEqual(tracing.start.name, "tracing:trace:start");
assert.deepStrictEqual(Object.keys(tracing), []);
const startDescriptor = Object.getOwnPropertyDescriptor(tracing, "start");
assert.deepStrictEqual({
  writable: startDescriptor.writable,
  enumerable: startDescriptor.enumerable,
  configurable: startDescriptor.configurable,
}, {
  writable: false,
  enumerable: false,
  configurable: false,
});
assert.throws(() => dc.tracingChannel(0), { code: "ERR_INVALID_ARG_TYPE" });
assert.throws(() => dc.tracingChannel({ start: "" }), { code: "ERR_INVALID_ARG_TYPE" });
assert.throws(() => dc.tracingChannel({}), /Cannot convert undefined or null to object/);
assert.throws(() => tracing.subscribe(undefined), /Cannot read properties of undefined/);
assert.throws(() => tracing.unsubscribe(undefined), /Cannot read properties of undefined/);

const store = new AsyncLocalStorage();
const storesChannel = dc.channel("stores");
storesChannel.bindStore(store, (data) => ({ data }));
assert.strictEqual(storesChannel.hasSubscribers, true);
storesChannel.runStores("outer", function(arg) {
  assert.deepStrictEqual([this.label, arg, store.getStore().data], ["thisArg", "arg", "outer"]);
}, { label: "thisArg" }, "arg");

const ordered = dc.channel("ordered-stores");
const firstStore = new AsyncLocalStorage();
const secondStore = new AsyncLocalStorage();
const orderedSeen = [];
ordered.bindStore(firstStore, () => {
  orderedSeen.push(["transform", "first"]);
  return "first";
});
ordered.bindStore(secondStore, () => {
  orderedSeen.push(["transform", "second"]);
  return "second";
});
ordered.runStores("ordered", () => {
  orderedSeen.push(["ordered", firstStore.getStore(), secondStore.getStore()]);
});
assert.deepStrictEqual(orderedSeen, [
  ["transform", "second"],
  ["transform", "first"],
  ["ordered", "first", "second"],
]);

const traceSeen = [];
tracing.start.bindStore(store, () => ({ phase: "start" }));
tracing.asyncStart.bindStore(store, () => ({ phase: "asyncStart" }));
tracing.subscribe({
  start: (ctx) => traceSeen.push(["start", ctx.input, store.getStore().phase]),
  end: (ctx) => traceSeen.push(["end", ctx.result ?? null]),
  asyncStart: (ctx) => traceSeen.push(["asyncStart", ctx.result, store.getStore().phase]),
  asyncEnd: (ctx) => traceSeen.push(["asyncEnd", ctx.result]),
  error: (ctx) => traceSeen.push(["error", ctx.error && ctx.error.message]),
});
const syncResult = tracing.traceSync(function(value) {
  traceSeen.push(["body", value, store.getStore().phase]);
  return "sync-result";
}, { input: "sync" }, null, 42);
assert.strictEqual(syncResult, "sync-result");

await new Promise((resolve) => {
  tracing.traceCallback(function(cb) {
    traceSeen.push(["callback-body", store.getStore().phase]);
    setImmediate(cb, null, "callback-result");
  }, 0, { input: "callback" }, null, (err, value) => {
    assert.strictEqual(err, null);
    traceSeen.push(["callback", value, store.getStore().phase]);
    resolve();
  });
});

assert.deepStrictEqual(traceSeen, [
  ["start", "sync", "start"],
  ["body", 42, "start"],
  ["end", "sync-result"],
  ["start", "callback", "start"],
  ["callback-body", "start"],
  ["end", null],
  ["asyncStart", "callback-result", "asyncStart"],
  ["callback", "callback-result", "asyncStart"],
  ["asyncEnd", "callback-result"],
]);

const custom = dc.tracingChannel({
  start: dc.channel("custom:start"),
  end: dc.channel("custom:end"),
  asyncStart: dc.channel("custom:asyncStart"),
  asyncEnd: dc.channel("custom:asyncEnd"),
  error: dc.channel("custom:error"),
});
const errorSeen = [];
custom.subscribe({
  start: (ctx) => errorSeen.push(["start", ctx.kind]),
  end: (ctx) => errorSeen.push(["end", ctx.kind]),
  asyncStart: (ctx) => errorSeen.push(["asyncStart", ctx.kind, ctx.result || ctx.error.message]),
  asyncEnd: (ctx) => errorSeen.push(["asyncEnd", ctx.kind]),
  error: (ctx) => errorSeen.push(["error", ctx.kind, ctx.error.message]),
});
const expected = new Error("boom");
try {
  custom.traceSync(() => { throw expected; }, { kind: "sync-error" });
} catch (err) {
  assert.strictEqual(err, expected);
}
await custom.tracePromise(() => Promise.resolve("ok"), { kind: "promise-ok" });
await custom.tracePromise(() => Promise.reject(expected), { kind: "promise-error" }).catch((err) => {
  assert.strictEqual(err, expected);
});
assert.deepStrictEqual(errorSeen, [
  ["start", "sync-error"],
  ["error", "sync-error", "boom"],
  ["end", "sync-error"],
  ["start", "promise-ok"],
  ["end", "promise-ok"],
  ["asyncStart", "promise-ok", "ok"],
  ["asyncEnd", "promise-ok"],
  ["start", "promise-error"],
  ["end", "promise-error"],
  ["error", "promise-error", "boom"],
  ["asyncStart", "promise-error", "boom"],
  ["asyncEnd", "promise-error"],
]);
`);
  });

  it("matches HTTP message internal prototype helpers", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const http = require("http");
const stream = require("stream");
const { kOutHeaders } = require("internal/http");

{
  const incoming = new http.IncomingMessage();
  const dest = {};
  incoming._addHeaderLine("Content-Type", "text/plain", dest);
  incoming._addHeaderLine("content-type", "application/json", dest);
  incoming._addHeaderLine("Set-Cookie", "a=1", dest);
  incoming._addHeaderLine("set-cookie", "b=2", dest);
  incoming._addHeaderLine("Cookie", "a=1", dest);
  incoming._addHeaderLine("cookie", "b=2", dest);
  incoming._addHeaderLine("X-Test", "one", dest);
  incoming._addHeaderLine("x-test", "two", dest);
  assert.deepStrictEqual(dest, {
    "content-type": "text/plain",
    "set-cookie": ["a=1", "b=2"],
    cookie: "a=1; b=2",
    "x-test": "one, two",
  });
}

{
  const outgoing = new http.OutgoingMessage();
  assert.strictEqual(typeof outgoing._renderHeaders, "function");
  assert.strictEqual(typeof outgoing._implicitHeader, "function");
  assert.strictEqual(typeof outgoing.flushHeaders, "function");
  assert.strictEqual(typeof outgoing.setTimeout, "function");
  assert.throws(() => outgoing.pipe(outgoing), { code: "ERR_STREAM_CANNOT_PIPE" });
  outgoing[kOutHeaders] = {
    host: ["host", "nodejs.org"],
    origin: ["Origin", "localhost"],
  };
  assert.deepStrictEqual(outgoing._renderHeaders(), {
    host: "nodejs.org",
    Origin: "localhost",
  });
}

{
  const outgoing = new http.OutgoingMessage();
  assert.throws(() => outgoing.setHeader(), { code: "ERR_INVALID_HTTP_TOKEN" });
  assert.throws(() => outgoing.setHeader("test"), { code: "ERR_HTTP_INVALID_HEADER_VALUE" });
  assert.throws(() => outgoing.setHeader("200", "あ"), { code: "ERR_INVALID_CHAR" });
  outgoing._implicitHeader = function() {};
  assert.strictEqual(outgoing.outputSize, 0);
  while (outgoing.write("asd"));
  assert(outgoing.outputSize >= outgoing.writableHighWaterMark);
  let timeoutValue = 0;
  outgoing.setTimeout(42);
  outgoing.emit("socket", { setTimeout(value) { timeoutValue = value; } });
  assert.strictEqual(timeoutValue, 42);
  let wrote = "";
  const dest = new stream.Writable({
    write(chunk, _encoding, callback) {
      wrote += chunk.toString();
      callback();
    },
  });
  const assigned = new http.ServerResponse({ method: "GET" });
  assigned.assignSocket(dest);
  assigned.write("ok", () => { wrote += ":cb"; });
  assigned.end(() => { wrote += ":end"; });
  assert.strictEqual(assigned.writable, true);
  assert.strictEqual(assigned.writableEnded, true);
  assert.strictEqual(assigned.writableFinished, true);
  assert(wrote.includes("ok"));
}
`);
  });

  it("implements Node os module sandbox semantics", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const os = require("os");
const { internalBinding } = require("internal/test/binding");

process.env.TMPDIR = "/tmpdir";
process.env.TMP = "/tmp";
process.env.TEMP = "/temp";
assert.strictEqual(os.tmpdir(), "/tmpdir");
process.env.TMPDIR = "";
assert.strictEqual(os.tmpdir(), "/tmp");
process.env.TMP = "";
assert.strictEqual(os.tmpdir(), "/temp");
process.env.TEMP = "";
assert.strictEqual(os.tmpdir(), "/tmp");
process.env.TMPDIR = "/tmpdir/";
assert.strictEqual(os.tmpdir(), "/tmpdir");
process.env.TMPDIR = "/tmpdir\\\\";
assert.strictEqual(os.tmpdir(), "/tmpdir\\\\");
process.env.TMPDIR = "/";
assert.strictEqual(os.tmpdir(), "/");

const originalHome = process.env.HOME;
process.env.HOME = "/home/kandelo";
assert.strictEqual(os.homedir(), "/home/kandelo");
delete process.env.HOME;
assert.strictEqual(os.homedir(), "/root");

const osBinding = internalBinding("os");
const originalGetHomeDirectory = osBinding.getHomeDirectory;
try {
  process.env.HOME = "/home/ignored";
  osBinding.getHomeDirectory = function(ctx) {
    ctx.syscall = "foo";
    ctx.code = "bar";
    ctx.message = "baz";
  };
  assert.throws(os.homedir, {
    message: /^A system error occurred: foo returned bar \\(baz\\)$/,
    name: "SystemError",
  });
} finally {
  osBinding.getHomeDirectory = originalGetHomeDirectory;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}

assert.strictEqual(os.EOL, "\\n");
assert.throws(() => { os.EOL = "x"; }, TypeError);
Object.defineProperty(os, "EOL", {
  configurable: true,
  enumerable: true,
  writable: false,
  value: "foo",
});
assert.strictEqual(os.EOL, "foo");

const {
  PRIORITY_LOW,
  PRIORITY_NORMAL,
  PRIORITY_HIGHEST,
} = os.constants.priority;
assert.strictEqual(PRIORITY_LOW, 19);
assert.strictEqual(PRIORITY_NORMAL, 0);
assert.strictEqual(PRIORITY_HIGHEST, -20);
os.setPriority(10);
assert.strictEqual(os.getPriority(), 10);
os.setPriority(process.pid, PRIORITY_NORMAL);
assert.strictEqual(os.getPriority(process.pid), PRIORITY_NORMAL);
assert.throws(() => os.getPriority(null), { code: "ERR_INVALID_ARG_TYPE" });
assert.throws(() => os.setPriority(0, PRIORITY_LOW + 1), { code: "ERR_OUT_OF_RANGE" });
assert.throws(() => os.getPriority(-1), {
  code: "ERR_SYSTEM_ERROR",
  name: "SystemError",
});

assert.ok(os.availableParallelism() > 0);
assert.strictEqual(+os.availableParallelism, os.availableParallelism());
assert.strictEqual(String(os.tmpdir), os.tmpdir());
assert.strictEqual(String(os.homedir), os.homedir());
assert.strictEqual(String(os.machine), os.machine());
`);
  });

  it("bootstraps internal worker MessageEvent without host DOM globals", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const { MessageEvent } = require("internal/worker/io");
const event = new MessageEvent("message", { data: 42 });
assert(event instanceof Event);
assert.strictEqual(event.type, "message");
assert.strictEqual(event.data, 42);
`, { withoutEventGlobal: true });
  });

  it("matches Node events listener bookkeeping and EventTarget helper semantics", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const events = require("events");
const { NodeEventTarget, kEvents } = require("internal/event_target");
const { EventEmitter, getEventListeners, getMaxListeners, setMaxListeners, once } = events;

const emitter = new EventEmitter();
const calls = [];
function handler(value) { calls.push(value); }
assert.throws(() => emitter.on("bad", {}), { code: "ERR_INVALID_ARG_TYPE" });
emitter.once("event", handler);
emitter.on("event", handler);
assert.strictEqual(emitter.listenerCount("event"), 2);
assert.strictEqual(emitter.listenerCount("event", handler), 2);
assert.strictEqual(emitter.rawListeners("event")[0].listener, handler);
assert.deepStrictEqual(emitter.listeners("event"), [handler, handler]);
emitter.emit("event", "first");
assert.deepStrictEqual(calls, ["first", "first"]);
assert.strictEqual(emitter.listenerCount("event", handler), 1);
emitter.removeListener("event", handler);
assert.strictEqual(emitter.listenerCount("event"), 0);

const sideEffects = [];
function side() {}
emitter.on("newListener", (name, fn) => sideEffects.push("new:" + String(name) + ":" + (fn === side)));
emitter.on("removeListener", (name, fn) => sideEffects.push("remove:" + String(name) + ":" + (fn === side)));
emitter.once("side", side);
emitter.emit("side");
assert.deepStrictEqual(sideEffects.slice(-2), ["new:side:true", "remove:side:true"]);

const target = new EventTarget();
function targetListener() {}
target.addEventListener("foo", targetListener);
target.addEventListener("foo", targetListener);
assert.deepStrictEqual(getEventListeners(target, "foo"), [targetListener]);
assert.strictEqual(getMaxListeners(target), events.defaultMaxListeners);
setMaxListeners(101, emitter, target);
assert.strictEqual(getMaxListeners(emitter), 101);
assert.strictEqual(getMaxListeners(target), 101);

const ac = new AbortController();
const aborted = once(emitter, "never", { signal: ac.signal }).catch((err) => err.name);
assert.strictEqual(ac.signal[kEvents].size, 1);
ac.abort();
if (typeof drainJobQueue === "function") drainJobQueue();
assert.strictEqual(await aborted, "AbortError");
assert.strictEqual(ac.signal[kEvents].size, 0);

const captured = [];
const rejecting = new EventEmitter({ captureRejections: true });
rejecting.on("error", (err) => captured.push(err.message));
rejecting.on("boom", async () => { throw new Error("captured"); });
rejecting.emit("boom");
if (typeof drainJobQueue === "function") drainJobQueue();
await Promise.resolve();
if (typeof drainJobQueue === "function") drainJobQueue();
assert.deepStrictEqual(captured, ["captured"]);

const nodeTarget = new NodeEventTarget();
const payloads = [];
function nodeListener(value) { payloads.push(value); }
nodeTarget.on("foo", nodeListener);
nodeTarget.addEventListener("foo", (event) => payloads.push(event.detail));
assert.strictEqual(nodeTarget.listenerCount("foo", nodeListener), 1);
nodeTarget.emit("foo", "bar", "ignored");
assert.deepStrictEqual(payloads, ["bar", "bar"]);
nodeTarget.removeListener("foo", nodeListener);
assert.strictEqual(nodeTarget.listenerCount("foo", nodeListener), 0);
assert.throws(() => Reflect.apply(NodeEventTarget.prototype.getMaxListeners, {}, []), {
  code: "ERR_INVALID_THIS",
});
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

  it("drains timers scheduled by eval-mode code after bootstrap startup", () => {
    const smoke = `
const nativeProcess = process;
globalThis.evalInWorker = function() {};
globalThis.quit = (code) => nativeProcess.exit(code | 0);
globalThis.putstr = (text) => nativeProcess.stdout.write(String(text));
globalThis.printErr = (text) => nativeProcess.stderr.write(String(text) + "\\n");
globalThis.scriptArgs = ["node", "-e", "setImmediate(() => process.stdout.write('eval-loop-ok'))"];
globalThis.os = {
  getenv() { return null; },
  getcwd() { return "/"; },
  getpid() { return 1; },
  kill() { return 0; },
  file: {
    readFile() { throw new Error("ENOENT"); },
    stat() { throw new Error("ENOENT"); },
    lstat() { throw new Error("ENOENT"); },
    realpath(path) { return String(path); },
  },
};
${generatedBootstrapSource()}
setImmediate(() => process.stdout.write("eval-loop-ok"));
`;
    const child = spawnSync(process.execPath, ["-"], {
      input: smoke,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("eval-loop-ok");
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

  it("matches Node fs option, watcher, stream, and require-cache semantics", () => {
    const smoke = `
const nativeRequire = require;
const nativeProcess = nativeRequire("node:process");
(async () => {
const nativeAssert = nativeRequire("node:assert");
const nativeFs = nativeRequire("node:fs");
const nativeOs = nativeRequire("node:os");
const nativePath = nativeRequire("node:path");
const tmpRoot = nativeFs.mkdtempSync(nativePath.join(nativeOs.tmpdir(), "kandelo-node-fs-"));
const fdPositions = new Map();

function errno(error, fallback) {
  const table = { ENOENT: 2, EIO: 5, EBADF: 9, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOTEMPTY: 39 };
  return table[error && error.code] || fallback;
}

function statShape(st) {
  return {
    dev: st.dev,
    ino: st.ino,
    mode: st.mode,
    nlink: st.nlink,
    uid: st.uid,
    gid: st.gid,
    rdev: st.rdev,
    size: st.size,
    blocks: st.blocks,
    atime: st.atimeMs / 1000,
    mtime: st.mtimeMs / 1000,
    ctime: st.ctimeMs / 1000,
  };
}

function fileCall(fn, fallback) {
  try { return fn(); } catch (error) { throw Object.assign(error, { errno: errno(error, fallback) }); }
}

function flagsToNode(flags) {
  const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0o100, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000;
  const writable = (flags & O_WRONLY) || (flags & O_RDWR);
  if (flags & O_APPEND) return (flags & O_RDWR) ? ((flags & O_EXCL) ? "ax+" : "a+") : ((flags & O_EXCL) ? "ax" : "a");
  if (flags & O_TRUNC) return (flags & O_RDWR) ? ((flags & O_EXCL) ? "wx+" : "w+") : ((flags & O_EXCL) ? "wx" : "w");
  if ((flags & O_CREAT) && writable) return (flags & O_RDWR) ? "w+" : "w";
  if (flags & O_RDWR) return "r+";
  if (flags & O_WRONLY) return "r+";
  return "r";
}

globalThis.os = {
  getcwd() { return tmpRoot; },
  chdir(dir) { process.chdir(String(dir)); return 0; },
  getpid() { return process.pid; },
  getenv(key) { return process.env[String(key)] ?? null; },
  file: {
    readFile(path, mode) { return mode === "binary" ? nativeFs.readFileSync(String(path)) : nativeFs.readFileSync(String(path), "utf8"); },
    stat(path) { return statShape(nativeFs.statSync(String(path))); },
    lstat(path) { return statShape(nativeFs.lstatSync(String(path))); },
    listDir(path) { return nativeFs.readdirSync(String(path)); },
    mkdir(path, mode) { try { nativeFs.mkdirSync(String(path), { mode }); return 0; } catch (error) { return -errno(error, 5); } },
    remove(path) { try { nativeFs.rmSync(String(path), { recursive: false }); return 0; } catch (error) { return -errno(error, 5); } },
    rename(oldPath, newPath) { try { nativeFs.renameSync(String(oldPath), String(newPath)); return 0; } catch (error) { return -errno(error, 5); } },
    link(oldPath, newPath) { try { nativeFs.linkSync(String(oldPath), String(newPath)); return 0; } catch (error) { return -errno(error, 5); } },
    symlink(target, linkPath) { try { nativeFs.symlinkSync(String(target), String(linkPath)); return 0; } catch (error) { return -errno(error, 5); } },
    readlink(path) { return nativeFs.readlinkSync(String(path), "utf8"); },
    realpath(path) { return nativeFs.realpathSync(String(path)); },
    lchown() { return 0; },
    utimes(path, atime, mtime) { nativeFs.utimesSync(String(path), atime, mtime); return 0; },
  },
  open(path, flags, mode) {
    try {
      const fd = nativeFs.openSync(String(path), flagsToNode(flags), mode);
      fdPositions.set(fd, (flags & 0o2000) ? nativeFs.fstatSync(fd).size : 0);
      return fd;
    } catch (error) {
      return -errno(error, 5);
    }
  },
  close(fd) { nativeFs.closeSync(fd); fdPositions.delete(fd); return 0; },
  read(fd, buffer, byteOffset, length) {
    const out = Buffer.alloc(length);
    const pos = fdPositions.get(fd) || 0;
    const n = nativeFs.readSync(fd, out, 0, length, pos);
    new Uint8Array(buffer, byteOffset || 0, n).set(out.subarray(0, n));
    fdPositions.set(fd, pos + n);
    return n;
  },
  write(fd, buffer, byteOffset, length) {
    const bytes = Buffer.from(new Uint8Array(buffer, byteOffset || 0, length));
    const pos = fdPositions.get(fd) || 0;
    const n = nativeFs.writeSync(fd, bytes, 0, bytes.byteLength, pos);
    fdPositions.set(fd, pos + n);
    return n;
  },
  seek(fd, offset, whence) {
    let pos = offset;
    if (whence === 1) pos = (fdPositions.get(fd) || 0) + offset;
    if (whence === 2) pos = nativeFs.fstatSync(fd).size + offset;
    fdPositions.set(fd, pos);
    return 0;
  },
  fstat(fd) { return [statShape(nativeFs.fstatSync(fd)), 0]; },
  isatty() { return false; },
};
globalThis.evalInWorker = function() {};
${generatedBootstrapSource()}

const krequire = globalThis.require;
const fs = krequire("fs");
const fsPromises = krequire("fs/promises");
const events = krequire("events");
const fixtures = nativePath.join(tmpRoot, "fixtures.txt");
const line = "xyz" + String.fromCharCode(10);
fs.writeFileSync(fixtures, line);

const appendOptions = {};
fs.appendFileSync(fixtures, "!", appendOptions);
nativeAssert.deepStrictEqual(appendOptions, {});
nativeAssert.strictEqual(fs.existsSync({}), false);
fs.exists(new URL("https://example.test"), (exists) => nativeAssert.strictEqual(exists, false));

const linked = nativePath.join(tmpRoot, "linked.txt");
fs.linkSync(fixtures, linked);
nativeAssert.strictEqual(fs.readFileSync(linked, "utf8"), line + "!");
const enosysLinked = nativePath.join(tmpRoot, "linked-enosys.txt");
const originalOsLink = os.link;
os.link = () => -38;
try {
  fs.linkSync(fixtures, enosysLinked);
} finally {
  os.link = originalOsLink;
}
nativeAssert.strictEqual(fs.readFileSync(enosysLinked, "utf8"), line + "!");
nativeAssert.throws(() => fs.link({}, linked, () => {}), { code: "ERR_INVALID_ARG_TYPE" });
nativeAssert.throws(() => fs.link(fixtures, {}, () => {}), { code: "ERR_INVALID_ARG_TYPE" });
await fsPromises.lchown(linked, 0, 0);
nativeAssert.throws(() => fs.lchown({}, 0, 0, () => {}), { code: "ERR_INVALID_ARG_TYPE" });
nativeAssert.throws(() => fs.lchown(linked, "bad", 0, () => {}), { code: "ERR_INVALID_ARG_TYPE" });
nativeAssert.strictEqual(fsPromises.constants, fs.constants);

const fd = fs.openSync(fixtures, "r");
const readBuffer = Buffer.alloc(4);
nativeAssert.strictEqual(fs.readSync(fd, readBuffer, { offset: 0, length: 4, position: 0n }), 4);
nativeAssert.strictEqual(readBuffer.toString(), line);
fs.closeSync(fd);

const watcher = fs.watchFile(fixtures, () => { throw new Error("watchFile change should not fire"); });
nativeAssert.strictEqual(watcher instanceof events.EventEmitter, true);
watcher.unref().ref();
let stopped = false;
watcher.once("stop", () => { stopped = true; });
watcher.stop();
nativeAssert.strictEqual(stopped, false);
await Promise.resolve();
nativeAssert.strictEqual(stopped, true);

const readStream = fs.createReadStream(fixtures);
nativeAssert.strictEqual(readStream.pending, true);
await new Promise((resolve) => readStream.once("ready", resolve));
nativeAssert.strictEqual(readStream.pending, false);
readStream.destroy();

const out = nativePath.join(tmpRoot, "out.txt");
const writeStream = fs.createWriteStream(out);
nativeAssert.strictEqual(writeStream.pending, true);
await new Promise((resolve) => writeStream.once("ready", resolve));
nativeAssert.strictEqual(writeStream.pending, false);
await new Promise((resolve, reject) => {
  writeStream.once("error", reject);
  writeStream.end("stream-data", "utf8", resolve);
});
nativeAssert.strictEqual(fs.readFileSync(out, "utf8"), "stream-data");

const fakeFs = {};
krequire.cache.fs = { exports: fakeFs };
nativeAssert.strictEqual(krequire("fs"), fakeFs);
nativeAssert.notStrictEqual(krequire("node:fs"), fakeFs);
delete krequire.cache.fs;
nativeAssert.throws(() => krequire("node:unknown"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
nativeAssert.throws(() => krequire("node:internal/test/binding"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
nativeFs.rmSync(tmpRoot, { recursive: true, force: true });
})().catch((error) => {
  nativeProcess.stderr.write(String(error && error.stack || error) + "\\n");
  nativeProcess.exit(1);
});
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

  it("matches supported node:test mock and helper API surface", () => {
    runBootstrapSmoke(`
const assert = require("assert");
const { mock, test, describe, it } = require("node:test");
const { convertStringToRegExp } = require("internal/test_runner/utils");
const { MockTracker } = require("internal/test_runner/mock/mock");

assert.strictEqual(typeof test.only, "function");
assert.strictEqual(typeof test.skip, "function");
assert.strictEqual(typeof test.todo, "function");
assert.strictEqual(typeof describe.only, "function");
assert.strictEqual(typeof it.todo, "function");
assert.strictEqual(MockTracker, mock.constructor);
assert.deepStrictEqual(convertStringToRegExp("/baz/gi", "x"), /baz/gi);
assert.deepStrictEqual(convertStringToRegExp("/foo/9", "x"), /\\/foo\\/9/);
assert.throws(
  () => convertStringToRegExp("/foo/abcdefghijk", "x"),
  { code: "ERR_INVALID_ARG_VALUE" },
);

const fn = mock.fn((a, b) => a + b, (a, b) => a * b, { times: 1 });
assert.strictEqual(fn(2, 3), 6);
assert.strictEqual(fn(2, 3), 5);
assert.strictEqual(fn.mock.callCount(), 2);
assert.deepStrictEqual(fn.mock.calls[0].arguments, [2, 3]);
fn.mock.mockImplementation((a, b) => a - b);
assert.strictEqual(fn(5, 2), 3);
fn.mock.resetCalls();
assert.strictEqual(fn.mock.callCount(), 0);

const obj = {
  value: 4,
  add(x) { return this.value + x; },
};
const method = mock.method(obj, "add", function(x) { return this.value * x; });
assert.strictEqual(obj.add(3), 12);
assert.strictEqual(method.mock.calls[0].this, obj);
method.mock.restore();
assert.strictEqual(obj.add(3), 7);
`);
  });

  it("runs the node:test CLI with discovery, sharding, reporters, and validation", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-node-test-"));
    try {
      mkdirSync(join(root, "subdir"), { recursive: true });
      mkdirSync(join(root, "test"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, "index.test.js"), `
const test = require('node:test');
test('this should pass');
`);
      writeFileSync(join(root, "random.test.mjs"), `
import test from 'node:test';
test('this should fail', () => { throw new Error('boom'); });
`);
      writeFileSync(join(root, "subdir", "subdir_test.js"), "");
      writeFileSync(join(root, "test", "random.cjs"), `
const test = require('node:test');
test('nested test dir pass');
`);
      writeFileSync(join(root, "test", "skip_by_name.cjs"), `
const test = require('node:test');
test('this should be skipped');
test('this should be executed');
`);
      writeFileSync(join(root, "node_modules", "test-nm.js"), "throw new Error('ignored');");

      const discovered = runBootstrapCli(["--test"], { cwd: root });
      expect(discovered.status).toBe(1);
      expect(discovered.stderr).toBe("");
      expect(discovered.stdout).toMatch(/TAP version 13/);
      expect(discovered.stdout).toMatch(/ok 1 - this should pass/);
      expect(discovered.stdout).toMatch(/not ok 2 - this should fail/);
      expect(discovered.stdout).toMatch(/ok 3 - .*subdir_test\.js/);
      expect(discovered.stdout).toMatch(/ok 4 - nested test dir pass/);
      expect(discovered.stdout).toMatch(/ok 5 - this should be skipped/);
      expect(discovered.stdout).toMatch(/ok 6 - this should be executed/);
      expect(discovered.stdout).not.toContain("ignored");

      const debug = runBootstrapCli(["--test", "--test-concurrency=2", "--test-timeout", "10"], {
        cwd: root,
        env: { NODE_DEBUG: "test_runner" },
      });
      expect(debug.stderr).toMatch(/concurrency: 2,/);
      expect(debug.stderr).toMatch(/timeout: 10,/);

      const invalidShard = runBootstrapCli(["--test", "--test-shard=0/3", join(root, "index.test.js")]);
      expect(invalidShard.status).toBe(1);
      expect(invalidShard.stdout).toBe("");
      expect(invalidShard.stderr).toMatch(/options\.shard\.index/);

      const shards = join(root, "shards");
      mkdirSync(shards);
      for (const name of ["a", "b", "c"]) {
        writeFileSync(join(shards, `${name}.cjs`), `
const test = require('node:test');
test('${name}.cjs this should pass');
`);
      }
      const dotFile = join(root, "dot.out");
      const sharded = runBootstrapCli([
        "--test",
        "--test-reporter", "dot",
        "--test-reporter-destination", dotFile,
        "--test-shard=2/2",
        join(shards, "*.cjs"),
      ]);
      expect(sharded.status).toBe(0);
      expect(sharded.stdout).toBe("");
      expect(sharded.stderr).toBe("");
      expect(readFileSync(dotFile, "utf8")).toBe(".\n");

      const reporterFile = join(root, "reporters.js");
      writeFileSync(reporterFile, `
const test = require('node:test');
test('nested', { concurrency: 4 }, async (t) => {
  t.test('ok', () => {});
  t.test('failing', () => { throw new Error('error'); });
});
test('top level', () => {});
`);
      const dot = runBootstrapCli(["--test", "--test-reporter", "dot", reporterFile]);
      expect(dot.status).toBe(1);
      expect(dot.stdout).toBe(".XX.\n");
      expect(dot.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
