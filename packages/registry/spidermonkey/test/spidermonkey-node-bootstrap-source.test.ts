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
`;
    const child = spawnSync(process.execPath, ["-"], {
      input: smoke,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
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
});
