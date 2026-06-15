import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { NodePlatformIO } from "../../../../host/src/platform/node";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageBuild = join(__dirname, "../bin/node.wasm");
const nodeWasm =
  tryResolveBinary("programs/spidermonkey-node.wasm") ??
  (existsSync(packageBuild) ? packageBuild : null);
const npmDist = join(__dirname, "../../../../packages/registry/npm/dist");
const hasNpm = existsSync(join(npmDist, "lib/cli.js"));

const DEFAULT_TIMEOUT = process.env.CI ? 120_000 : 20_000;
const DEFAULT_TEST_TIMEOUT = DEFAULT_TIMEOUT + 30_000;
const LONG_TIMEOUT = process.env.CI ? 180_000 : 30_000;
const LONG_TEST_TIMEOUT = LONG_TIMEOUT + 60_000;
const NPM_INSTALL_TIMEOUT = process.env.CI ? 360_000 : 180_000;
const NPM_INSTALL_TEST_TIMEOUT = NPM_INSTALL_TIMEOUT + 60_000;
const CI_PROGRESS_INTERVAL = 15_000;
let nodeModule: WebAssembly.Module | undefined;

const NPM_RUNNER = `const invoked = process.argv[2] || 'npm';
process.argv.splice(2, 1);
process.argv[1] = invoked === 'npx' ? '/usr/bin/npx' : '/usr/bin/npm';
if (invoked === 'npx') {
  process.argv[1] = '/npm/bin/npm-cli.js';
  process.argv.splice(2, 0, 'exec');
}
const run = require('/npm/lib/cli.js');
let settled = false;
let failure = null;
Promise.resolve(run(process)).then(
  () => { settled = true; },
  (err) => { failure = err; settled = true; }
);
const sleepView = typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object'
  ? new Int32Array(new SharedArrayBuffer(4))
  : null;
function pumpSpiderMonkeyJobs() {
  if (typeof drainJobQueue === 'function') drainJobQueue();
  if (typeof __kandeloRunDueTimers === 'function') __kandeloRunDueTimers();
  if (sleepView && typeof __kandeloNextTimerDelay === 'function') {
    const delay = __kandeloNextTimerDelay();
    if (delay > 0) {
      try { Atomics.wait(sleepView, 0, 0, Math.min(delay, 5)); } catch {}
    }
  }
}
let spins = 0;
const started = Date.now();
while (!settled && typeof drainJobQueue === 'function') {
  pumpSpiderMonkeyJobs();
  if (++spins > 500000 && Date.now() - started > 300000) {
    failure = new Error('npm did not settle after draining the SpiderMonkey job queue');
    settled = true;
  }
}
if (failure) {
  console.error(failure && failure.stack ? failure.stack : failure);
  process.exitCode = process.exitCode || 1;
}
pumpSpiderMonkeyJobs();
process.exit(process.exitCode || 0);
`;

const NPM_DISPLAY_SHIM = `function plain(...args) {
  return args.map((arg) => String(arg)).join(' ');
}
function makeChalk() {
  const fn = (...args) => plain(...args);
  return new Proxy(fn, {
    apply(_target, _thisArg, args) { return plain(...args); },
    get(target, prop) {
      if (prop === 'level') return 0;
      if (prop === 'supportsColor') return false;
      if (prop === 'constructor') return Chalk;
      if (prop === Symbol.toStringTag) return 'Function';
      return target;
    },
  });
}
class Chalk {
  constructor() {
    return makeChalk();
  }
}
function createSupportsColor() {
  return { level: 0, hasBasic: false, has256: false, has16m: false };
}
module.exports = { Chalk, createSupportsColor };
`;

const NPM_IS_CIDR_SHIM = `function isCidrV4(value) {
  const match = String(value).match(/^([0-9]{1,3}(?:\\.[0-9]{1,3}){3})\\/(3[0-2]|[12]?[0-9])$/);
  if (!match) return false;
  return match[1].split('.').every((part) => Number(part) <= 255);
}
function isCidrV6(value) {
  const text = String(value);
  const slash = text.lastIndexOf('/');
  if (slash < 0) return false;
  const prefix = Number(text.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
  const address = text.slice(0, slash);
  return /^[0-9a-fA-F:]+$/.test(address) && address.includes(':');
}
module.exports = { v4: isCidrV4, v6: isCidrV6 };
`;

interface PackedLocalPackage {
  tarballFilename: string;
  tarballPath: string;
}

function loadWasm(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function prepareNpmRuntime(root: string): {
  npmDir: string;
  helperDir: string;
} {
  const npmDir = join(root, "npm");
  const helperDir = join(root, "kandelo");
  cpSync(npmDist, npmDir, { recursive: true });
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "npm-runner.js"), NPM_RUNNER);
  writeFileSync(join(helperDir, "npm-display-shim.js"), NPM_DISPLAY_SHIM);
  writeFileSync(join(helperDir, "is-cidr-shim.js"), NPM_IS_CIDR_SHIM);
  patchNpmForSpiderMonkey(npmDir);
  return { npmDir, helperDir };
}

function patchNpmForSpiderMonkey(npmDir: string): void {
  patchHostText(join(npmDir, "lib/utils/display.js"), [
    [
      `const [{ Chalk }, { createSupportsColor }] = await Promise.all([
      import('chalk'),
      import('supports-color'),
    ])`,
      `const { Chalk, createSupportsColor } = require('/kandelo/npm-display-shim.js')`,
      "import('chalk')",
    ],
  ]);
  patchHostText(join(npmDir, "lib/commands/token.js"), [
    [
      `const { v4: isCidrV4, v6: isCidrV6 } = await import('is-cidr')`,
      `const { v4: isCidrV4, v6: isCidrV6 } = require('/kandelo/is-cidr-shim.js')`,
      "import('is-cidr')",
    ],
  ]);
  for (const path of [
    join(npmDir, "node_modules/cacache/lib/entry-index.js"),
    join(npmDir, "node_modules/cacache/lib/verify.js"),
  ]) {
    patchHostText(path, [
      [
        `const { default: pMap } = await import('p-map')`,
        `const pMap = require('p-map')`,
        "import('p-map')",
      ],
    ]);
  }
}

function patchHostText(
  path: string,
  replacements: Array<[from: string, to: string, probe: string]>,
): void {
  let source = readFileSync(path, "utf8");
  let changed = false;
  for (const [from, to, probe] of replacements) {
    if (source.includes(from)) {
      source = source.replace(from, to);
      changed = true;
    } else if (source.includes(probe)) {
      throw new Error(`npm compatibility patch did not match expected source in ${path}`);
    }
  }
  if (changed) writeFileSync(path, source);
}

function createLocalRegistryPackage(
  root: string,
  manifest: Record<string, unknown> & { name: string; version: string },
  files: Record<string, string>,
): PackedLocalPackage {
  const packageDir = join(root, `${manifest.name}-src`);
  const tarballDir = join(root, "registry");
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(tarballDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify(manifest, null, 2));
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(packageDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  const packJson = runHostNpm(
    ["pack", "--pack-destination", tarballDir, "--json"],
    packageDir,
  );
  const [{ filename }] = JSON.parse(packJson) as Array<{ filename: string }>;
  const tarballPath = join(tarballDir, filename);
  return {
    tarballFilename: filename,
    tarballPath,
  };
}

function runHostNpm(args: string[], cwd: string): string {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return execFileSync(process.execPath, [npmExecPath, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createCowsayPackages(root: string): {
  registryDir: string;
  cowsayTarballFilename: string;
} {
  const cowVoice = createLocalRegistryPackage(
    root,
    {
      name: "cow-voice",
      version: "1.0.0",
      main: "index.js",
    },
    {
      "index.js": `exports.message = (text) => 'Moo: ' + text;\n`,
    },
  );
  const cowsay = createLocalRegistryPackage(
    root,
    {
      name: "cowsay",
      version: "1.6.0",
      main: "index.js",
      bin: { cowsay: "cli.js" },
      dependencies: { "cow-voice": `file:///registry/${cowVoice.tarballFilename}` },
    },
    {
      "index.js": `const voice = require('cow-voice');
exports.say = ({ text }) => [
  ' ' + text,
  '< ' + voice.message(text) + ' >',
  '        \\\\   ^__^',
  '         \\\\  (oo)\\\\_______',
  '            (__)\\\\       )\\\\/\\\\',
  '                ||----w |',
  '                ||     ||',
].join('\\n');
`,
      "cli.js": `#!/usr/bin/env node
const cowsay = require('./');
const text = process.argv.slice(2).join(' ') || 'moo';
console.log(cowsay.say({ text }));
`,
    },
  );
  return {
    registryDir: dirname(cowsay.tarballPath),
    cowsayTarballFilename: cowsay.tarballFilename,
  };
}

async function runNode(
  source: string,
  timeout = DEFAULT_TIMEOUT,
  extraOptions: { execPrograms?: Map<string, string> } = {},
) {
  const label =
    expect.getState().currentTestName ?? "spidermonkey node program";
  return withCiProgress(
    label,
    runCentralizedProgram({
      programPath: nodeWasm!,
      programModule: nodeModule,
      argv: ["node", "-e", source],
      ...extraOptions,
      timeout,
    }),
  );
}

async function runNodeFile(source: string, timeout = DEFAULT_TIMEOUT) {
  const root = mkdtempSync(join(tmpdir(), "kandelo-node-main-"));
  const scriptPath = join(root, "main.js");
  writeFileSync(scriptPath, source);
  try {
    return await runCentralizedProgram({
      programPath: nodeWasm!,
      programModule: nodeModule,
      argv: ["node", scriptPath],
      io: new NodePlatformIO(),
      timeout,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withCiProgress<T>(label: string, promise: Promise<T>): Promise<T> {
  if (!process.env.CI) {
    return promise;
  }

  const start = Date.now();
  const elapsedSeconds = () => Math.round((Date.now() - start) / 1000);
  console.info(`[spidermonkey-node] ${label} started`);
  const interval = setInterval(() => {
    console.info(
      `[spidermonkey-node] ${label} still running after ${elapsedSeconds()}s`,
    );
  }, CI_PROGRESS_INTERVAL);

  try {
    return await promise;
  } finally {
    clearInterval(interval);
    console.info(
      `[spidermonkey-node] ${label} finished after ${elapsedSeconds()}s`,
    );
  }
}

describe.skipIf(!nodeWasm)("SpiderMonkey Node compatibility runtime", () => {
  beforeAll(async () => {
    nodeModule = await withCiProgress(
      "precompile node.wasm",
      WebAssembly.compile(loadWasm(nodeWasm!)),
    );
  }, DEFAULT_TEST_TIMEOUT);

  it("evaluates Node-style -e scripts with process and console globals", async () => {
    const result = await runNode(
      "console.log('hello', process.arch, process.platform, process.version)",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello wasm32 linux v22.0.0");
  }, DEFAULT_TEST_TIMEOUT);

  it("prints the Node compatibility version", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      programModule: nodeModule,
      argv: ["node", "--version"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("v22.0.0");
  }, DEFAULT_TEST_TIMEOUT);

  it("supports --disable-proto=delete in main, vm, and worker contexts", async () => {
    const source = [
      "const assert = require('assert')",
      "const vm = require('vm')",
      "const { Worker } = require('worker_threads')",
      "assert(process.execArgv.includes('--disable-proto=delete'))",
      "assert(!process.argv.includes('--disable-proto=delete'))",
      "assert.strictEqual(Object.prototype.__proto__, undefined)",
      "assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, '__proto__'), false)",
      "const ctxGlobal = vm.runInContext('this', vm.createContext())",
      "assert.strictEqual(ctxGlobal.Object.prototype.__proto__, undefined)",
      "assert.strictEqual(ctxGlobal.Object.prototype.hasOwnProperty.call(ctxGlobal.Object.prototype, '__proto__'), false)",
      "const sab = new SharedArrayBuffer(8)",
      "const view = new Int32Array(sab)",
      "const worker = new Worker(\"const view = new Int32Array(workerData); let ok = 0; try { ok = Object.prototype.__proto__ === undefined && !Object.prototype.hasOwnProperty.call(Object.prototype, '__proto__') ? 1 : -1; } catch (_) { ok = -2; } Atomics.store(view, 0, ok); Atomics.store(view, 1, 1); Atomics.notify(view, 1);\", { eval: true, workerData: sab })",
      "if (Atomics.load(view, 1) === 0) Atomics.wait(view, 1, 0, 10000)",
      "assert.strictEqual(Atomics.load(view, 0), 1)",
      "worker.terminate()",
      "console.log('delete-ok')",
    ].join("\n");
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      programModule: nodeModule,
      argv: ["node", "--disable-proto=delete", "-e", source],
      timeout: LONG_TIMEOUT,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("delete-ok");
  }, LONG_TEST_TIMEOUT);

  it("supports --disable-proto=throw in main, vm, and worker contexts", async () => {
    const source = [
      "const assert = require('assert')",
      "const vm = require('vm')",
      "const { Worker } = require('worker_threads')",
      "assert(process.execArgv.includes('--disable-proto=throw'))",
      "assert(!process.argv.includes('--disable-proto=throw'))",
      "assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, '__proto__'), true)",
      "function expectProtoAccessThrows(fn) { assert.throws(fn, { code: 'ERR_PROTO_ACCESS' }) }",
      "expectProtoAccessThrows(() => ({}).__proto__)",
      "expectProtoAccessThrows(() => { ({}).__proto__ = {} })",
      "const ctx = vm.createContext()",
      "expectProtoAccessThrows(() => vm.runInContext('({}).__proto__', ctx))",
      "expectProtoAccessThrows(() => vm.runInContext('({}).__proto__ = {}', ctx))",
      "const sab = new SharedArrayBuffer(8)",
      "const view = new Int32Array(sab)",
      "const worker = new Worker(\"const view = new Int32Array(workerData); let ok = 0; try { ({}).__proto__; ok = -1; } catch (e) { ok = e && e.code === 'ERR_PROTO_ACCESS' ? 1 : -2; } try { ({}).__proto__ = {}; ok = ok === 1 ? -3 : ok; } catch (e) { ok = ok === 1 && e && e.code === 'ERR_PROTO_ACCESS' ? 2 : -4; } Atomics.store(view, 0, ok); Atomics.store(view, 1, 1); Atomics.notify(view, 1);\", { eval: true, workerData: sab })",
      "if (Atomics.load(view, 1) === 0) Atomics.wait(view, 1, 0, 10000)",
      "assert.strictEqual(Atomics.load(view, 0), 2)",
      "worker.terminate()",
      "console.log('throw-ok')",
    ].join("\n");
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      programModule: nodeModule,
      argv: ["node", "--disable-proto=throw", "-e", source],
      timeout: LONG_TIMEOUT,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("throw-ok");
  }, LONG_TEST_TIMEOUT);

  it("rejects invalid NODE_OPTIONS even when CLI disable-proto is valid", async () => {
    const result = await runCentralizedProgram({
      programPath: nodeWasm!,
      programModule: nodeModule,
      argv: ["node", "--disable-proto=throw", "-e", "console.log('unreachable')"],
      env: ["NODE_OPTIONS=--disable-proto=invalid"],
      timeout: DEFAULT_TIMEOUT,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("invalid mode passed to --disable-proto");
    expect(result.stdout).toBe("");
  }, DEFAULT_TEST_TIMEOUT);

  it("keeps compatibility helper globals out of global enumeration", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "const leakCandidates = [",
        "  '__kandeloFinalizeProcessExit',",
        "  '__kandeloRunDueTimers', '__kandeloNextTimerDelay', '__kandeloCreateWorkerThreads',",
        "  '__kandeloAsyncHooksPromise',",
        "  'argv0', 'execArgv', 'TextEncoder', 'TextDecoder', 'btoa', 'atob',",
        "  'Blob', 'File', 'FormData', 'MessagePort', 'MessageChannel', 'BroadcastChannel',",
        "  'Event', 'EventTarget', 'MessageEvent', 'CloseEvent', 'ErrorEvent',",
        "  'DOMException', 'AbortSignal'",
        "]",
        "const enumerableGlobals = new Set(Object.keys(globalThis))",
        "const leaked = leakCandidates.filter((name) => enumerableGlobals.has(name) || Object.prototype.propertyIsEnumerable.call(globalThis, name))",
        "assert.deepStrictEqual(leaked, [])",
        "console.log('ok')",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("is not fork-instrumented so it can start in browser workers", () => {
    const exportNames = new Set(
      WebAssembly.Module.exports(nodeModule!).map((entry) => entry.name),
    );

    expect(exportNames.has("wpk_fork_state")).toBe(false);
  });

  it("provides Buffer, path, util, assert, and node: builtins", async () => {
    const result = await runNode(
      [
        "const assert = require('node:assert')",
        "const path = require('path')",
        "const util = require('util')",
        "const b = Buffer.from('hello')",
        "assert.strictEqual(Buffer.isBuffer(b), true)",
        "assert.strictEqual(b.toString('hex'), '68656c6c6f')",
        "assert.strictEqual(path.join('/usr', 'bin', 'node'), '/usr/bin/node')",
        "assert.strictEqual(path.win32.delimiter, ';')",
        "const invalidPathValues = [true, false, 7, null, {}, undefined, [], NaN]",
        "const pathMethods = ['join', 'resolve', 'normalize', 'isAbsolute', 'parse', 'dirname', 'basename', 'extname']",
        "for (const namespace of [path.posix, path.win32]) {",
        "  for (const value of invalidPathValues) {",
        "    for (const method of pathMethods) assert.throws(() => namespace[method](value), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' })",
        "    assert.throws(() => namespace.relative(value, 'foo'), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' })",
        "    assert.throws(() => namespace.relative('foo', value), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' })",
        "    if (value !== undefined) assert.throws(() => namespace.basename('foo', value), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' })",
        "  }",
        "}",
        "console.log(util.format('%s:%d', path.basename('/usr/bin/node'), b.length))",
      ].join(";"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("node:5");
  }, DEFAULT_TEST_TIMEOUT);

  it("aligns buffer.kMaxLength with the SpiderMonkey typed-array limit", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "const { constants, kMaxLength } = require('buffer')",
        "assert.strictEqual(kMaxLength, 0x7fffffff)",
        "assert.strictEqual(constants.MAX_LENGTH, kMaxLength)",
        "assert.throws(() => new Uint8Array(kMaxLength + 1))",
      ].join(";"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  }, DEFAULT_TEST_TIMEOUT);

  it("matches Node StringDecoder buffering and replacement semantics", async () => {
    const result = await runNode(
      [
        "const assert = require('node:assert')",
        "const { StringDecoder } = require('string_decoder')",
        "const called = {}",
        "StringDecoder.call(called)",
        "assert.strictEqual(called.encoding, 'utf8')",
        "assert.strictEqual(Buffer.from('ababc', 'ucs2').toString('ucs2'), 'ababc')",
        "assert.strictEqual(Buffer.from([0x41, 0x80, 0xff]).toString('latin1'), 'A\\u0080\\u00ff')",
        "assert.strictEqual(Buffer.from([0x41, 0x80, 0xff]).toString('ascii'), 'A\\u0000\\u007f')",
        "let decoder = new StringDecoder('utf8')",
        "assert.strictEqual(decoder.write(Buffer.from('C9B5A941', 'hex')), '\\u0275\\ufffdA')",
        "assert.strictEqual(decoder.end(), '')",
        "decoder = new StringDecoder('utf8')",
        "assert.strictEqual(decoder.write(Buffer.from('E1', 'hex')), '')",
        "assert.deepStrictEqual(Array.from(decoder.lastChar), [0xe1, 0, 0, 0])",
        "assert.strictEqual(decoder.lastNeed, 2)",
        "assert.strictEqual(decoder.lastTotal, 3)",
        "assert.strictEqual(decoder.end(), '\\ufffd')",
        "decoder = new StringDecoder('utf8')",
        "assert.strictEqual(decoder.write(Buffer.from('f69b', 'hex')), '')",
        "assert.strictEqual(decoder.write(Buffer.from('d1', 'hex')), '\\ufffd\\ufffd')",
        "assert.strictEqual(decoder.end(), '\\ufffd')",
        "decoder = new StringDecoder('utf8')",
        "assert.strictEqual(decoder.write(Buffer.from('f4', 'hex')), '')",
        "assert.strictEqual(decoder.write(Buffer.from('bde5', 'hex')), '\\ufffd\\ufffd')",
        "assert.strictEqual(decoder.end(), '\\ufffd')",
        "decoder = new StringDecoder('utf16le')",
        "assert.strictEqual(decoder.write(Buffer.from('3DD8', 'hex')), '')",
        "assert.strictEqual(decoder.write(Buffer.from('4D', 'hex')), '')",
        "assert.strictEqual(decoder.write(Buffer.from('DC', 'hex')), '\\ud83d\\udc4d')",
        "assert.strictEqual(decoder.end(), '')",
        "decoder = new StringDecoder('utf16le')",
        "assert.strictEqual(decoder.write(Buffer.from('3DD84D', 'hex')), '\\ud83d')",
        "assert.strictEqual(decoder.end(), '')",
        "decoder = new StringDecoder('base64')",
        "assert.strictEqual(decoder.write(Buffer.from([0x61])), '')",
        "assert.strictEqual(decoder.end(), 'YQ==')",
        "decoder = new StringDecoder('base64')",
        "assert.strictEqual(decoder.write(Buffer.from([0x61])), '')",
        "assert.strictEqual(decoder.write(Buffer.from([0x62])), '')",
        "assert.strictEqual(decoder.write(Buffer.from([0x63])), 'YWJj')",
        "assert.strictEqual(decoder.end(), '')",
        "decoder = new StringDecoder('base64url')",
        "assert.strictEqual(decoder.write(Buffer.from([0x61, 0x61])), '')",
        "assert.strictEqual(decoder.end(), 'YWE')",
        "assert.strictEqual(Buffer.from([0x61, 0x62, 0x63]).toString('base64url'), 'YWJj')",
        "console.log('string-decoder-ok')",
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("string-decoder-ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("matches Node querystring.stringify for nullish and primitive inputs", async () => {
    const result = await runNode(
      [
        "const assert = require('node:assert')",
        "const qs = require('querystring')",
        "assert.strictEqual(qs.stringify(), '')",
        "assert.strictEqual(qs.stringify(undefined), '')",
        "assert.strictEqual(qs.stringify(null), '')",
        "assert.strictEqual(qs.stringify('abc'), '')",
        "assert.strictEqual(qs.stringify(0), '')",
        "assert.strictEqual(qs.stringify(false), '')",
        "function fn() {}",
        "fn.answer = 42",
        "assert.strictEqual(qs.stringify(fn), '')",
        "assert.strictEqual(qs.stringify({ a: 1, b: [true, null] }), 'a=1&b=true&b=')",
        "console.log('ok')",
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("provides Node process identity, memory, resource, and permission APIs", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "assert.strictEqual(process.getuid(), 0)",
        "assert.strictEqual(process.geteuid(), 0)",
        "assert.strictEqual(process.getgid(), 0)",
        "assert.strictEqual(process.getegid(), 0)",
        "process.setgid('nobody')",
        "process.setuid('nobody')",
        "assert.strictEqual(process.getgid(), 65534)",
        "assert.strictEqual(process.getuid(), 65534)",
        "assert.deepStrictEqual(process.getgroups(), [0])",
        "const old = process.umask('0664')",
        "assert.strictEqual(old, 0o022)",
        "assert.strictEqual(process.umask(), 0o664)",
        "assert.strictEqual(process.umask(old), 0o664)",
        "const memory = process.memoryUsage()",
        "assert(memory.rss > 0)",
        "assert(memory.heapTotal > 0)",
        "assert(memory.heapUsed > 0)",
        "assert(memory.external > 0)",
        "assert.strictEqual(typeof process.memoryUsage.rss(), 'number')",
        "const rusage = process.resourceUsage()",
        "assert.strictEqual(typeof rusage.maxRSS, 'number')",
        "assert.strictEqual(typeof process.availableMemory(), 'number')",
        "assert.strictEqual(typeof process.constrainedMemory(), 'number')",
        "assert.strictEqual(process.permission.has('fs.read', '/tmp/file'), true)",
        "assert.strictEqual(process.permission.has('child'), true)",
        "assert.strictEqual(process.permission.has('invalid-key'), false)",
        "console.log('ok')",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("matches Node assert helper semantics used by core tests", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "assert.match('MODULE_NOT_FOUND: Cannot find module', /Cannot find module/)",
        "assert.throws(() => { throw Object.assign(new TypeError('bad'), { code: 'ERR_BAD' }) }, { name: 'TypeError', code: 'ERR_BAD', message: /bad/ })",
        "assert.throws(() => assert.throws(() => {}, /missing/), { code: 'ERR_ASSERTION', message: 'Missing expected exception.' })",
        "try { assert.throws(() => {}) } catch (e) { assert.strictEqual(e.stack.includes('throws'), false) }",
        "assert.throws(() => assert.doesNotThrow(() => { throw Object.assign(new Error('bad'), { code: 'ERR_BAD' }) }, { code: 'ERR_BAD' }), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' })",
        "const arr = new Uint8Array([1, 2, 3])",
        "const buf = Buffer.from([1, 2, 3])",
        "assert.throws(() => assert.deepStrictEqual(arr, buf), { code: 'ERR_ASSERTION', operator: 'deepStrictEqual' })",
        "assert.deepEqual(arr, buf)",
        "const original = new Error('test error')",
        "assert.throws(() => assert.ifError(original), { code: 'ERR_ASSERTION', message: 'ifError got unwanted exception: test error', actual: original, expected: null, operator: 'ifError' })",
        "const tracker = new assert.CallTracker()",
        "function add(a, b, c = 0) { return a + b + c }",
        "add.customProperty = 42",
        "const tracked = tracker.calls(add, 2)",
        "assert.strictEqual(tracked.length, 2)",
        "assert.strictEqual(tracked.customProperty, 42)",
        "assert.strictEqual(tracked(1, 2, 3), 6)",
        "tracked.call({ label: 'ctx' }, 4, 5)",
        "const calls = tracker.getCalls(tracked)",
        "assert.deepStrictEqual(calls[0].arguments, [1, 2, 3])",
        "assert.deepStrictEqual(calls[1].thisArg, { label: 'ctx' })",
        "assert.throws(() => calls.push(1), { name: 'TypeError' })",
        "function noLength(a, b) { return a + b }",
        "delete noLength.length",
        "const noLengthTracked = tracker.calls(noLength, 1)",
        "assert.strictEqual(Object.hasOwn(noLengthTracked, 'length'), false)",
        "assert.strictEqual(noLengthTracked(2, 3), 5)",
        "const arrayIteratorPrototype = Reflect.getPrototypeOf(Array.prototype.values())",
        "const originalArrayIteratorNext = arrayIteratorPrototype.next",
        "arrayIteratorPrototype.next = () => { throw new Error('array iterator used') }",
        "Object.prototype.get = () => { throw new Error('prototype getter used') }",
        "try {",
        "  const marker = Symbol('marker')",
        "  function iteratorSafe(a, b, c = 2) { return a + b + c }",
        "  iteratorSafe.customProperty = marker",
        "  Object.defineProperty(iteratorSafe, 'length', { get() { throw new Error('length getter used') } })",
        "  const iteratorTracked = tracker.calls(iteratorSafe, 1)",
        "  assert.strictEqual(Object.hasOwn(iteratorTracked, 'length'), true)",
        "  assert.strictEqual(iteratorTracked.customProperty, marker)",
        "  assert.strictEqual(iteratorTracked(1, 2, 3), 6)",
        "} finally {",
        "  arrayIteratorPrototype.next = originalArrayIteratorNext",
        "  delete Object.prototype.get",
        "}",
        "tracker.verify()",
        "const promises = [",
        "  assert.rejects(Promise.reject(Object.assign(new Error('nope'), { code: 'E_NOPE' })), { code: 'E_NOPE', message: /nope/ }),",
        "  assert.doesNotReject(Promise.resolve('ok')),",
        "  assert.rejects(assert.doesNotReject(Promise.reject(Object.assign(new Error('bad'), { code: 'ERR_BAD' })), { code: 'ERR_BAD' }), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' }),",
        "  assert.rejects(assert.rejects(Promise.resolve(), () => true), { code: 'ERR_ASSERTION', operator: 'rejects' })",
        "]",
        "const syncThrown = new Error('sync thrown')",
        "promises.push(assert.rejects(() => { throw syncThrown }, {}).then(() => { throw new Error('expected sync throw') }, (err) => assert.strictEqual(err, syncThrown)))",
        "promises.push(assert.doesNotReject(() => { throw syncThrown }, () => { throw new Error('expected validator not called') }).then(() => { throw new Error('expected sync throw') }, (err) => assert.strictEqual(err, syncThrown)))",
        "let done = false",
        "Promise.all(promises).then(() => { done = true }, (err) => { console.error(err && err.stack || err); process.exitCode = 1; done = true })",
        "let spins = 0",
        "while (!done && typeof drainJobQueue === 'function' && spins++ < 1000) drainJobQueue()",
        "assert.strictEqual(done, true)",
        "console.log('ok')",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("emits warnings and exposes process.binding util parity", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "const util = require('util')",
        "const seen = []",
        "process.on('warning', (warning) => seen.push([warning.name, warning.message, warning.code || '']))",
        "process.emitWarning('careful', 'CustomWarning', 'CODE001')",
        "assert.throws(() => process.assert(false, 'asserted'), { code: 'ERR_ASSERTION' })",
        "drainJobQueue()",
        "assert.deepStrictEqual(seen, [",
        "  ['CustomWarning', 'careful', 'CODE001'],",
        "  ['DeprecationWarning', 'process.assert() is deprecated. Please use the `assert` module instead.', 'DEP0100'],",
        "])",
        "const binding = process.binding('util')",
        "assert.deepStrictEqual(Object.keys(binding).sort(), [",
        "  'isAnyArrayBuffer', 'isArrayBuffer', 'isArrayBufferView', 'isAsyncFunction',",
        "  'isDataView', 'isDate', 'isExternal', 'isMap', 'isMapIterator',",
        "  'isNativeError', 'isPromise', 'isRegExp', 'isSet', 'isSetIterator',",
        "  'isTypedArray', 'isUint8Array',",
        "].sort())",
        "for (const key of Object.keys(binding)) assert.strictEqual(binding[key], util.types[key])",
        "console.log('ok')",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("tracks active process resources and uncaught-exception capture callbacks", async () => {
    const result = await runNodeFile(
      [
        "const assert = require('assert')",
        "assert.strictEqual(process.hasUncaughtExceptionCaptureCallback(), false)",
        "process.setUncaughtExceptionCaptureCallback((err) => {",
        "  assert.strictEqual(err.message, 'captured')",
        "  console.log('captured')",
        "})",
        "assert.strictEqual(process.hasUncaughtExceptionCaptureCallback(), true)",
        "const timeout = setTimeout(() => {",
        "  assert.strictEqual(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, 1)",
        "  clearTimeout(timeout)",
        "  assert.strictEqual(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, 0)",
        "}, 0)",
        "assert.strictEqual(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, 1)",
        "const immediate = setImmediate(() => {",
        "  assert.strictEqual(process.getActiveResourcesInfo().filter((x) => x === 'Immediate').length, 0)",
        "})",
        "assert.strictEqual(process.getActiveResourcesInfo().filter((x) => x === 'Immediate').length, 1)",
        "throw new Error('captured')",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("captured");
  }, DEFAULT_TEST_TIMEOUT);

  it("runs immediates queued during the immediate phase on the next event-loop turn", async () => {
    const result = await runNodeFile(
      [
        "const assert = require('assert')",
        "let ticked = false",
        "let hit = 0",
        "const QUEUE = 10",
        "function run() {",
        "  if (hit === 0) {",
        "    setTimeout(() => { ticked = true }, 1)",
        "    const now = Date.now()",
        "    while (Date.now() - now < 2) {}",
        "  }",
        "  if (ticked) return",
        "  hit++",
        "  setImmediate(run)",
        "}",
        "for (let i = 0; i < QUEUE; i++) setImmediate(run)",
        "process.on('exit', () => {",
        "  assert.strictEqual(hit, QUEUE)",
        "  console.log('hit', hit)",
        "})",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hit 10");
  }, DEFAULT_TEST_TIMEOUT);

  it("passes timer arguments and clears zero-delay intervals from callbacks", async () => {
    const result = await runNodeFile(
      [
        "const assert = require('assert')",
        "let timeoutCalled = false",
        "setTimeout(function(a, b, c) {",
        "  assert.strictEqual(a, 'foo')",
        "  assert.strictEqual(b, 'bar')",
        "  assert.strictEqual(c, 'baz')",
        "  timeoutCalled = true",
        "}, 0, 'foo', 'bar', 'baz')",
        "let remaining = 3",
        "const iv = setInterval(function(a, b, c) {",
        "  assert.strictEqual(a, 'foo')",
        "  assert.strictEqual(b, 'bar')",
        "  assert.strictEqual(c, 'baz')",
        "  if (--remaining === 0) clearInterval(iv)",
        "}, 0, 'foo', 'bar', 'baz')",
        "process.on('exit', () => {",
        "  assert.strictEqual(timeoutCalled, true)",
        "  assert.strictEqual(remaining, 0)",
        "  console.log('ok')",
        "})",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("coerces invalid timer delays to one millisecond before later timers", async () => {
    const result = await runNodeFile(
      [
        "const assert = require('assert')",
        "const inputs = [",
        "  undefined, null, true, false, '', [], {}, NaN, +Infinity, -Infinity,",
        "  (1.0 / 0.0), parseFloat('x'), -10, -1, -0.5, -0.1, -0.0,",
        "  0, 0.0, 0.1, 0.5, 1, 1.0, 2147483648, 12345678901234,",
        "]",
        "const timeouts = []",
        "const intervals = []",
        "inputs.forEach((value, index) => {",
        "  setTimeout(() => { timeouts[index] = true }, value)",
        "  const handle = setInterval(function() {",
        "    clearInterval(this)",
        "    intervals[index] = true",
        "    assert.strictEqual(this, handle)",
        "  }, value)",
        "})",
        "setTimeout(() => {",
        "  inputs.forEach((value, index) => {",
        "    assert.strictEqual(timeouts[index], true, `timeout ${index} ${value}`)",
        "    assert.strictEqual(intervals[index], true, `interval ${index} ${value}`)",
        "  })",
        "  console.log('coerced')",
        "}, 2)",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("coerced");
  }, DEFAULT_TEST_TIMEOUT);

  it("drains promise jobs before main script exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-node-drain-"));
    const scriptPath = join(root, "drain.js");
    writeFileSync(
      scriptPath,
      [
        "let count = 0",
        "Promise.resolve().then(() => {",
        "  count++",
        "  return Promise.resolve().then(() => { count++ })",
        "}).then(() => { count++ })",
        "process.on('exit', () => {",
        "  if (count !== 3) {",
        "    console.error(`promise jobs not drained: ${count}`)",
        "    process.exitCode = 1",
        "  } else {",
        "    console.log('ok')",
        "  }",
        "})",
      ].join("\n"),
    );

    let result: Awaited<ReturnType<typeof runCentralizedProgram>>;
    try {
      result = await runCentralizedProgram({
        programPath: nodeWasm!,
        programModule: nodeModule,
        argv: ["node", scriptPath],
        io: new NodePlatformIO(),
        timeout: DEFAULT_TIMEOUT,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("runs Node self-exec CLI options through child_process with Node statuses", async () => {
    const result = await runNode(
      [
        "const assert = require('node:assert')",
        "const cp = require('node:child_process')",
        "const fs = require('node:fs')",
        "fs.writeFileSync('/usr/bin/node', '')",
        "fs.writeFileSync('/tmp/kandelo-preload.js', \"console.log('A')\\n\")",
        "let child = cp.spawnSync(process.execPath, ['--eval', 'console.log(123)'], { encoding: 'utf8' })",
        "assert.strictEqual(child.status, 0)",
        "assert.strictEqual(child.signal, null)",
        "assert.strictEqual(child.stdout, '123\\n')",
        "assert.strictEqual(child.stderr, '')",
        "child = cp.spawnSync(process.execPath, ['--print', 'process.argv.slice(1).join(\\',\\')', '--', 'alpha', '--', 'beta'], { encoding: 'utf8' })",
        "assert.strictEqual(child.status, 0)",
        "assert.strictEqual(child.stdout, 'alpha,--,beta\\n')",
        "child = cp.spawnSync(process.execPath, ['--use-strict', '-p', 'process.execArgv'], { encoding: 'utf8' })",
        "assert.strictEqual(child.status, 0)",
        "assert.strictEqual(child.stdout, \"[ '--use-strict', '-p', 'process.execArgv' ]\\n\")",
        "child = cp.spawnSync(process.execPath, ['--eval'], { encoding: 'utf8' })",
        "assert.strictEqual(child.status, 9)",
        "assert.strictEqual(child.stderr.trim(), process.execPath + ': --eval requires an argument')",
        "child = cp.spawnSync(process.execPath, ['--bad-kandelo-option'], { encoding: 'utf8' })",
        "assert.strictEqual(child.status, 9)",
        "assert.strictEqual(child.stderr.trim(), process.execPath + ': bad option: --bad-kandelo-option')",
        "child = cp.spawnSync(process.execPath, ['-e', 'console.log(\\'B\\')'], {",
        "  encoding: 'utf8',",
        "  env: { ...process.env, NODE_OPTIONS: '-r /tmp/kandelo-preload.js --redirect-warnings=foó' },",
        "})",
        "assert.strictEqual(child.status, 0)",
        "assert.strictEqual(child.stdout, 'A\\nB\\n')",
        "child = cp.spawnSync(process.execPath, [], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--eval' } })",
        "assert.strictEqual(child.status, 9)",
        "assert.strictEqual(child.stderr.trim(), process.execPath + ': --eval is not allowed in NODE_OPTIONS')",
        "const shellOut = cp.execSync(JSON.stringify(process.execPath) + ' --print \"40 + 2\"', { encoding: 'utf8' })",
        "assert.strictEqual(shellOut, '42\\n')",
        "console.log('ok')",
      ].join("\n"),
      DEFAULT_TIMEOUT,
      { execPrograms: new Map([["/usr/bin/node", nodeWasm!]]) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("exposes child_process.fork and documents unsupported cluster.fork semantics", async () => {
    const result = await runNode(
      [
        "const assert = require('node:assert')",
        "const fs = require('node:fs')",
        "const cp = require('child_process')",
        "const nodeCp = require('node:child_process')",
        "const cluster = require('node:cluster')",
        "assert.strictEqual(cp.fork, nodeCp.fork)",
        "assert.strictEqual(typeof cp.fork, 'function')",
        "assert.strictEqual(typeof cluster.on, 'function')",
        "assert.strictEqual(typeof cluster.fork, 'function')",
        "assert.throws(() => cluster.fork(), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })",
        "fs.writeFileSync('/usr/bin/node', '')",
        "fs.writeFileSync('/tmp/kandelo-fork-child.js', \"console.log('fork-child:' + process.argv.slice(2).join(','))\\n\")",
        "const child = cp.fork('/tmp/kandelo-fork-child.js', ['alpha', 'beta'])",
        "let out = ''",
        "let closed = false",
        "child.stdout.on('data', chunk => { out += chunk.toString() })",
        "child.on('close', code => {",
        "  closed = true",
        "  assert.strictEqual(code, 0)",
        "  console.log(out.trim())",
        "  console.log(child.connected)",
        "})",
        "let spins = 0",
        "while (!closed && typeof drainJobQueue === 'function' && spins++ < 1000) drainJobQueue()",
        "assert.strictEqual(closed, true)",
        "assert.strictEqual(typeof child.send, 'function')",
        "assert.strictEqual(child.send({ hello: 'world' }, (err) => console.log(err.code)), false)",
        "drainJobQueue()",
      ].join("\n"),
      DEFAULT_TIMEOUT,
      { execPrograms: new Map([["/usr/bin/node", nodeWasm!]]) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      "fork-child:alpha,beta",
      "false",
      "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    ]);
  }, DEFAULT_TEST_TIMEOUT);

  it("provides vm.runInNewContext for foreign objects and sandbox globals", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "const vm = require('node:vm')",
        "const foreign = vm.runInNewContext('({ foo: [\"bar\", \"baz\"] })')",
        "assert.strictEqual(foreign.foo.join(','), 'bar,baz')",
        "assert.strictEqual(foreign instanceof Object, false)",
        "const sandbox = { value: 7 }",
        "assert.strictEqual(vm.runInNewContext('value += 5; created = value * 2; value', sandbox), 12)",
        "assert.strictEqual(sandbox.value, 12)",
        "assert.strictEqual(sandbox.created, 24)",
        "const script = new vm.Script('answer + 1')",
        "assert.strictEqual(script.runInNewContext({ answer: 41 }), 42)",
        "console.log('ok')",
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("supports vm contexts, cached data, measureMemory, and module shims", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "const vm = require('node:vm')",
        "const plain = {}",
        "assert.strictEqual(vm.isContext(plain), false)",
        "assert.throws(() => vm.isContext('x'), { code: 'ERR_INVALID_ARG_TYPE' })",
        "assert.throws(() => vm.runInNewContext('', null), { code: 'ERR_INVALID_ARG_TYPE' })",
        "const context = vm.createContext({ foo: 'bar' })",
        "assert.strictEqual(vm.isContext(context), true)",
        "assert.strictEqual(vm.runInContext(\"foo += '!'; created = 41; foo\", context), 'bar!')",
        "assert.strictEqual(context.foo, 'bar!')",
        "assert.strictEqual(context.created, 41)",
        "assert.strictEqual(new vm.Script('created + 1').runInContext(context), 42)",
        "assert.throws(() => new vm.Script('').runInContext({}), { code: 'ERR_INVALID_ARG_TYPE' })",
        "const script = new vm.Script('function x() {}', { produceCachedData: true })",
        "assert.strictEqual(script.cachedDataProduced, true)",
        "assert.strictEqual(Buffer.isBuffer(script.cachedData), true)",
        "assert.strictEqual(new vm.Script('function x() {}', { cachedData: script.cachedData }).cachedDataRejected, false)",
        "assert.strictEqual(new vm.Script('function y() {}', { cachedData: script.cachedData }).cachedDataRejected, true)",
        "assert.throws(() => new vm.Script('function x() {}', { cachedData: 'bad' }), { code: 'ERR_INVALID_ARG_TYPE' })",
        "assert.strictEqual(new vm.Script('1\\n//# sourceMappingURL=sourcemap.json').sourceMapURL, 'sourcemap.json')",
        "assert.strictEqual(new vm.Script('1\\n// sourceMappingURL=sourcemap.json').sourceMapURL, undefined)",
        ";(async () => {",
        "  const memory = await vm.measureMemory({ mode: 'detailed', execution: 'eager' })",
        "  assert.strictEqual(typeof memory.total.jsMemoryEstimate, 'number')",
        "  assert.strictEqual(typeof memory.current.jsMemoryRange[0], 'number')",
        "  assert.strictEqual(Array.isArray(memory.other), true)",
        "  assert.throws(() => vm.measureMemory({ mode: 'random' }), { code: 'ERR_INVALID_ARG_VALUE' })",
        "  const m1 = new vm.SourceTextModule('baz = foo; typeofProcess = typeof process;', { context })",
        "  assert.strictEqual(m1.status, 'unlinked')",
        "  await m1.link(() => {})",
        "  assert.strictEqual(m1.status, 'linked')",
        "  await m1.evaluate()",
        "  assert.strictEqual(m1.status, 'evaluated')",
        "  assert.strictEqual(context.baz, 'bar!')",
        "  assert.strictEqual(context.typeofProcess, 'undefined')",
        "  const ctx1 = vm.createContext({})",
        "  const ctx2 = vm.createContext({})",
        "  assert.strictEqual(new vm.SourceTextModule('1', { context: ctx1 }).identifier, 'vm:module(0)')",
        "  assert.strictEqual(new vm.SourceTextModule('2', { context: ctx1 }).identifier, 'vm:module(1)')",
        "  assert.strictEqual(new vm.SourceTextModule('3', { context: ctx2 }).identifier, 'vm:module(0)')",
        "  const synthetic = new vm.SyntheticModule(['x'], () => synthetic.setExport('x', 1))",
        "  const exported = new vm.SourceTextModule('export const answer = 42')",
        "  await exported.link(() => {})",
        "  await exported.evaluate()",
        "  assert.strictEqual(exported.namespace.answer, 42)",
        "  assert.throws(() => new vm.SourceTextModule('1', { context: null }), { code: 'ERR_INVALID_ARG_TYPE' })",
        "  const importer = new vm.SourceTextModule(\"import { x } from 'synthetic'; export const getX = () => x;\")",
        "  await synthetic.link(() => {})",
        "  await importer.link(() => synthetic)",
        "  await synthetic.evaluate()",
        "  await importer.evaluate()",
        "  assert.strictEqual(importer.namespace.getX(), 1)",
        "  synthetic.setExport('x', 42)",
        "  assert.strictEqual(importer.namespace.getX(), 42)",
        "  const cached = new vm.SourceTextModule('const a = 1').createCachedData()",
        "  new vm.SourceTextModule('const a = 1', { cachedData: cached })",
        "  assert.throws(() => new vm.SourceTextModule('const a = 2', { cachedData: cached }), { code: 'ERR_VM_MODULE_CACHED_DATA_REJECTED' })",
        "  console.log('ok')",
        "})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exitCode = 1 })",
        "if (typeof drainJobQueue === 'function') drainJobQueue()",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("supports Symbol values in eventNames and assert.deepStrictEqual", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "const { EventEmitter } = require('events')",
        "const emitter = new EventEmitter()",
        "const event = Symbol('event')",
        "const key = Symbol('key')",
        "emitter.on('foo', () => {})",
        "emitter.on(event, () => {})",
        "assert.deepStrictEqual(emitter.eventNames(), ['foo', event])",
        "assert.deepStrictEqual({ [key]: [event] }, { [key]: [event] })",
        "let failure = 'missing'",
        "try {",
        "  assert.deepStrictEqual([Symbol('value')], [Symbol('value')])",
        "} catch (err) {",
        "  failure = `${err.code}:${err instanceof assert.AssertionError}:${/Symbol\\(value\\)/.test(err.message)}`",
        "}",
        "console.log(failure)",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ERR_ASSERTION:true:true");
  }, DEFAULT_TEST_TIMEOUT);

  it("matches Node events listener bookkeeping and EventTarget helpers", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "const events = require('events')",
        "const { NodeEventTarget, kEvents } = require('internal/event_target')",
        "const { EventEmitter, getEventListeners, getMaxListeners, setMaxListeners, once } = events;",
        "(async () => {",
        "  const emitter = new EventEmitter()",
        "  const calls = []",
        "  function handler(value) { calls.push(value) }",
        "  assert.throws(() => emitter.on('bad', {}), { code: 'ERR_INVALID_ARG_TYPE' })",
        "  emitter.once('event', handler)",
        "  emitter.on('event', handler)",
        "  assert.strictEqual(emitter.listenerCount('event'), 2)",
        "  assert.strictEqual(emitter.listenerCount('event', handler), 2)",
        "  assert.strictEqual(emitter.rawListeners('event')[0].listener, handler)",
        "  assert.deepStrictEqual(emitter.listeners('event'), [handler, handler])",
        "  emitter.emit('event', 'first')",
        "  assert.deepStrictEqual(calls, ['first', 'first'])",
        "  assert.strictEqual(emitter.listenerCount('event', handler), 1)",
        "  emitter.removeListener('event', handler)",
        "  assert.strictEqual(emitter.listenerCount('event'), 0)",
        "",
        "  const sideEffects = []",
        "  function side() {}",
        "  emitter.on('newListener', (name, fn) => sideEffects.push('new:' + String(name) + ':' + (fn === side)))",
        "  emitter.on('removeListener', (name, fn) => sideEffects.push('remove:' + String(name) + ':' + (fn === side)))",
        "  emitter.once('side', side)",
        "  emitter.emit('side')",
        "  assert.deepStrictEqual(sideEffects.slice(-2), ['new:side:true', 'remove:side:true'])",
        "",
        "  const target = new EventTarget()",
        "  function targetListener() {}",
        "  target.addEventListener('foo', targetListener)",
        "  target.addEventListener('foo', targetListener)",
        "  assert.deepStrictEqual(getEventListeners(target, 'foo'), [targetListener])",
        "  assert.strictEqual(getMaxListeners(target), events.defaultMaxListeners)",
        "  setMaxListeners(101, emitter, target)",
        "  assert.strictEqual(getMaxListeners(emitter), 101)",
        "  assert.strictEqual(getMaxListeners(target), 101)",
        "",
        "  const ac = new AbortController()",
        "  const aborted = once(emitter, 'never', { signal: ac.signal }).catch((err) => err.name)",
        "  assert.strictEqual(ac.signal[kEvents].size, 1)",
        "  ac.abort()",
        "  if (typeof drainJobQueue === 'function') drainJobQueue()",
        "  assert.strictEqual(await aborted, 'AbortError')",
        "  assert.strictEqual(ac.signal[kEvents].size, 0)",
        "",
        "  const captured = []",
        "  const rejecting = new EventEmitter({ captureRejections: true })",
        "  rejecting.on('error', (err) => captured.push(err.message))",
        "  rejecting.on('boom', async () => { throw new Error('captured') })",
        "  rejecting.emit('boom')",
        "  if (typeof drainJobQueue === 'function') drainJobQueue()",
        "  await Promise.resolve()",
        "  if (typeof drainJobQueue === 'function') drainJobQueue()",
        "  assert.deepStrictEqual(captured, ['captured'])",
        "",
        "  const nodeTarget = new NodeEventTarget()",
        "  const payloads = []",
        "  function nodeListener(value) { payloads.push(value) }",
        "  nodeTarget.on('foo', nodeListener)",
        "  nodeTarget.addEventListener('foo', (event) => payloads.push(event.detail))",
        "  assert.strictEqual(nodeTarget.listenerCount('foo', nodeListener), 1)",
        "  nodeTarget.emit('foo', 'bar', 'ignored')",
        "  assert.deepStrictEqual(payloads, ['bar', 'bar'])",
        "  nodeTarget.removeListener('foo', nodeListener)",
        "  assert.strictEqual(nodeTarget.listenerCount('foo', nodeListener), 0)",
        "  assert.throws(() => Reflect.apply(NodeEventTarget.prototype.getMaxListeners, {}, []), { code: 'ERR_INVALID_THIS' })",
        "  console.log('ok')",
        "})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exitCode = 1 })",
        "if (typeof drainJobQueue === 'function') drainJobQueue()",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("exposes primary cluster setup, Worker, and disconnect control APIs", async () => {
    const result = await runNode(
      [
        "const assert = require('node:assert')",
        "const cluster = require('node:cluster')",
        "assert.strictEqual(cluster.isPrimary, true)",
        "assert.strictEqual(cluster.isMaster, true)",
        "assert.strictEqual(cluster.isWorker, false)",
        "assert.deepStrictEqual(cluster.settings, {})",
        "let setupCount = 0",
        "cluster.on('setup', (settings) => {",
        "  setupCount++",
        "  console.log('setup:' + settings.exec + ':' + settings.args.join(','))",
        "})",
        "process.argv = ['node', '/tmp/entry.js', 'one']",
        "cluster.setupPrimary()",
        "cluster.setupMaster({ exec: '/tmp/override.js', args: ['two'], cwd: '/tmp', serialization: 'advanced' })",
        "assert.deepStrictEqual(cluster.settings, {",
        "  args: ['two'],",
        "  exec: '/tmp/override.js',",
        "  execArgv: process.execArgv,",
        "  silent: false,",
        "  cwd: '/tmp',",
        "  serialization: 'advanced',",
        "})",
        "const worker = new cluster.Worker({ id: 3, state: 'online', process })",
        "assert.strictEqual(worker.exitedAfterDisconnect, undefined)",
        "assert.strictEqual(worker.id, 3)",
        "assert.strictEqual(worker.state, 'online')",
        "assert.strictEqual(worker.process, process)",
        "const calledWorker = cluster.Worker.call({}, { id: 5 })",
        "assert(calledWorker instanceof cluster.Worker)",
        "assert.strictEqual(calledWorker.id, 5)",
        "assert.strictEqual(new cluster.Worker().state, 'none')",
        "assert.strictEqual(typeof cluster.on, 'function')",
        "assert.strictEqual(typeof cluster.once, 'function')",
        "assert.throws(() => cluster.fork(), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })",
        "let disconnected = false",
        "cluster.disconnect(() => { disconnected = true; console.log('disconnect') })",
        "assert.strictEqual(disconnected, false)",
        "drainJobQueue()",
        "assert.strictEqual(setupCount, 2)",
        "assert.strictEqual(disconnected, true)",
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      "setup:/tmp/entry.js:one",
      "setup:/tmp/override.js:two",
      "disconnect",
    ]);
  }, DEFAULT_TEST_TIMEOUT);

  it("resolves events.once for streams that replay cached events from on()", async () => {
    const result = await runNode(
      [
        "const { EventEmitter, once } = require('events')",
        "class ReplayEmitter extends EventEmitter {",
        "  constructor() { super(); this._seen = new Map() }",
        "  on(event, handler) {",
        "    if (this._seen.has(event)) return handler(...this._seen.get(event))",
        "    return super.on(event, handler)",
        "  }",
        "  emit(event, ...args) { this._seen.set(event, args); return super.emit(event, ...args) }",
        "}",
        "const emitter = new ReplayEmitter()",
        "emitter.emit('integrity', 'sha512-test')",
        "once(emitter, 'integrity').then(([value]) => console.log(value))",
        "drainJobQueue()",
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("sha512-test");
  }, DEFAULT_TEST_TIMEOUT);

  it("supports Node stream readable and writable compatibility APIs", async () => {
    const result = await runNode(
      [
        "const stream = require('stream')",
        "const util = require('util')",
        "const events = require('events')",
        "const { Readable, Writable, PassThrough } = stream",
        "const checks = []",
        "function fail(msg) { throw new Error(msg) }",
        "if (stream.getDefaultHighWaterMark(false) !== 65536) fail('bad byte hwm')",
        "if (stream.getDefaultHighWaterMark(true) !== 16) fail('bad object hwm')",
        "stream.setDefaultHighWaterMark(false, 1234)",
        "if (new Readable().readableHighWaterMark !== 1234) fail('set byte hwm failed')",
        "stream.setDefaultHighWaterMark(false, 65536)",
        "function collect(readable) {",
        "  return new Promise((resolve, reject) => {",
        "    let out = ''",
        "    readable.on('data', (chunk) => { out += String(chunk) })",
        "    readable.on('end', () => resolve(out))",
        "    readable.on('error', reject)",
        "    readable.resume()",
        "  })",
        "}",
        "const encoded = new Readable({ read() {} })",
        "encoded.push(Buffer.from('b'))",
        "encoded.unshift(Buffer.from('a'))",
        "encoded.setEncoding('utf8')",
        "encoded.push(Buffer.from('c'))",
        "encoded.push(null)",
        "const encodedDone = collect(encoded).then((out) => checks.push('encoded:' + out + ':' + encoded.readableEncoding))",
        "const fromDone = Readable.from([1, 2, 3]).map((n) => n * 2).filter((n) => n > 2).toArray()",
        "  .then((items) => checks.push('from:' + items.join(',')))",
        "const old = new events.EventEmitter()",
        "old.pause = () => {}",
        "old.resume = () => {}",
        "const wrapped = new Readable({ read() {} }).wrap(old).setEncoding('utf8')",
        "const wrappedDone = collect(wrapped).then((out) => checks.push('wrap:' + out))",
        "old.emit('data', Buffer.from('old'))",
        "old.emit('end')",
        "const pass = new PassThrough()",
        "const writes = []",
        "const pipeEvents = []",
        "const dest = new Writable({",
        "  write(chunk, enc, cb) { writes.push(Buffer.from(chunk).toString() + ':' + enc); cb() }",
        "})",
        "dest.on('pipe', () => pipeEvents.push('pipe'))",
        "dest.on('unpipe', () => pipeEvents.push('unpipe'))",
        "pass.pipe(dest)",
        "pass.write(Buffer.from('x'))",
        "pass.unpipe(dest)",
        "pass.write(Buffer.from('y'))",
        "pass.end()",
        "checks.push('pipe:' + pipeEvents.join(',') + ':' + writes.join(','))",
        "function LegacyReadable() { Readable.call(this, { read() {} }) }",
        "util.inherits(LegacyReadable, Readable)",
        "const legacy = new LegacyReadable()",
        "const legacyDone = collect(legacy).then((out) => checks.push('legacy:' + out))",
        "legacy.push('ok')",
        "legacy.push(null)",
        "const encodings = []",
        "const writable = new Writable({ write(_chunk, enc, cb) { encodings.push(enc); cb() } })",
        "writable.cork()",
        "writable.write(Buffer.from('buf'))",
        "writable.write('txt', 'utf8')",
        "writable.uncork()",
        "writable.end(() => checks.push('write:' + encodings.join(',') + ':' + writable.writableFinished))",
        "Promise.all([encodedDone, fromDone, wrappedDone, legacyDone]).then(() => {",
        "  checks.sort()",
        "  console.log(checks.join('|'))",
        "  globalThis.__streamCompatDone = true",
        "})",
        "for (let i = 0; i < 20 && !globalThis.__streamCompatDone; i++) drainJobQueue()",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      "encoded:abc:utf8|from:4,6|legacy:ok|pipe:pipe,unpipe:x:buffer|wrap:old|write:buffer,buffer:true",
    );
  }, DEFAULT_TEST_TIMEOUT);

  it("maps EMFILE to Node's canonical errno code for graceful-fs retry queues", async () => {
    const result = await runNode(
      [
        "const fs = require('fs')",
        "fs.writeFileSync('/tmp/emfile-target', 'x')",
        "const fds = []",
        "let code = 'missing'",
        "try {",
        "  for (let i = 0; i < 2048; i++) fds.push(fs.openSync('/tmp/emfile-target', 'r'))",
        "} catch (err) {",
        "  code = err.code",
        "} finally {",
        "  for (const fd of fds) fs.closeSync(fd)",
        "}",
        "console.log(code)",
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("EMFILE");
  }, DEFAULT_TEST_TIMEOUT);

  it("serves same-process HTTP requests through createServer", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "const http = require('http')",
        "let done = false",
        "let failure = null",
        "function fail(err) { failure = err; done = true }",
        "const server = http.createServer((req, res) => {",
        "  try {",
        "    assert.ok(req instanceof http.IncomingMessage)",
        "    assert.strictEqual(req.method, 'POST')",
        "    assert.strictEqual(req.url, '/hello?x=1')",
        "    assert.strictEqual(req.headers['x-test'], 'client')",
        "    const chunks = []",
        "    req.on('data', (chunk) => chunks.push(chunk))",
        "    req.on('end', () => {",
        "      try {",
        "        assert.strictEqual(Buffer.concat(chunks).toString(), 'payload')",
        "        assert.strictEqual(req.complete, true)",
        "        res.statusCode = 201",
        "        res.statusMessage = 'Created'",
        "        res.setHeader('X-Reply', 'ok')",
        "        res.setHeader('Set-Cookie', ['a=1', 'b=2'])",
        "        assert.deepStrictEqual(res.getHeaderNames().sort(), ['set-cookie', 'x-reply'])",
        "        assert.deepStrictEqual(res.getRawHeaderNames().sort(), ['Set-Cookie', 'X-Reply'])",
        "        res.end('response-body')",
        "      } catch (err) { fail(err) }",
        "    })",
        "  } catch (err) { fail(err) }",
        "})",
        "server.on('connection', (socket) => {",
        "  try { assert.strictEqual(socket.remoteAddress, '127.0.0.1') } catch (err) { fail(err) }",
        "})",
        "server.listen(0, '127.0.0.1', () => {",
        "  const addr = server.address()",
        "  const req = http.request({",
        "    host: '127.0.0.1',",
        "    port: addr.port,",
        "    method: 'POST',",
        "    path: '/hello?x=1',",
        "    headers: { 'Content-Length': '7', 'X-Test': 'client' },",
        "  }, (res) => {",
        "    try {",
        "      assert.ok(res instanceof http.IncomingMessage)",
        "      assert.strictEqual(res.statusCode, 201)",
        "      assert.strictEqual(res.statusMessage, 'Created')",
        "      assert.strictEqual(res.headers['x-reply'], 'ok')",
        "      assert.deepStrictEqual(res.headers['set-cookie'], ['a=1', 'b=2'])",
        "      const chunks = []",
        "      res.on('data', (chunk) => chunks.push(chunk))",
        "      res.on('end', () => {",
        "        try {",
        "          assert.strictEqual(Buffer.concat(chunks).toString(), 'response-body')",
        "          server.close(() => { console.log('http-ok'); done = true })",
        "        } catch (err) { fail(err) }",
        "      })",
        "    } catch (err) { fail(err) }",
        "  })",
        "  req.on('error', fail)",
        "  req.end('payload')",
        "})",
        "let spins = 0",
        "while (!done && !failure && typeof drainJobQueue === 'function' && spins++ < 1000) drainJobQueue()",
        "if (failure) throw failure",
        "assert.strictEqual(done, true)",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("http-ok");
  }, DEFAULT_TEST_TIMEOUT);

  it("preserves HTTP message internals and socket high water marks", async () => {
    const result = await runNode(
      [
        "const assert = require('assert')",
        "const http = require('http')",
        "const net = require('net')",
        "const { kOutHeaders } = require('internal/http')",
        "let done = false",
        "let failure = null",
        "function fail(err) { failure = err; done = true }",
        "try {",
        "  const incoming = new http.IncomingMessage()",
        "  const dest = {}",
        "  incoming._addHeaderLine('Content-Type', 'text/plain', dest)",
        "  incoming._addHeaderLine('content-type', 'application/json', dest)",
        "  incoming._addHeaderLine('Set-Cookie', 'a=1', dest)",
        "  incoming._addHeaderLine('set-cookie', 'b=2', dest)",
        "  incoming._addHeaderLine('Cookie', 'a=1', dest)",
        "  incoming._addHeaderLine('cookie', 'b=2', dest)",
        "  incoming._addHeaderLine('X-Test', 'one', dest)",
        "  incoming._addHeaderLine('x-test', 'two', dest)",
        "  assert.deepStrictEqual(dest, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'], cookie: 'a=1; b=2', 'x-test': 'one, two' })",
        "  const outgoing = new http.OutgoingMessage()",
        "  assert.strictEqual(typeof outgoing.flushHeaders, 'function')",
        "  assert.throws(() => outgoing.pipe(outgoing), { code: 'ERR_STREAM_CANNOT_PIPE' })",
        "  outgoing[kOutHeaders] = { host: ['host', 'nodejs.org'], origin: ['Origin', 'localhost'] }",
        "  assert.deepStrictEqual(outgoing._renderHeaders(), { host: 'nodejs.org', Origin: 'localhost' })",
        "  outgoing.setTimeout(23)",
        "  let timeoutValue = 0",
        "  outgoing.emit('socket', { setTimeout(value) { timeoutValue = value } })",
        "  assert.strictEqual(timeoutValue, 23)",
        "} catch (err) { fail(err) }",
        "const server = http.createServer((req, res) => {",
        "  try {",
        "    assert.strictEqual(req.socket.readableHighWaterMark, 1024)",
        "    res.end('ok')",
        "  } catch (err) { fail(err) }",
        "})",
        "server.listen(0, '127.0.0.1', () => {",
        "  const req = http.request({",
        "    port: server.address().port,",
        "    host: '127.0.0.1',",
        "    createConnection(options) {",
        "      options.readableHighWaterMark = 1024",
        "      return net.createConnection(options)",
        "    },",
        "  }, (res) => {",
        "    try {",
        "      assert.strictEqual(res.socket, req.socket)",
        "      assert.strictEqual(res.socket.readableHighWaterMark, 1024)",
        "      assert.strictEqual(res.readableHighWaterMark, 1024)",
        "      res.resume()",
        "      res.on('end', () => server.close(() => { console.log('http-message-internals-ok'); done = true }))",
        "    } catch (err) { fail(err) }",
        "  })",
        "  req.on('error', fail)",
        "  req.end()",
        "})",
        "let spins = 0",
        "while (!done && !failure && typeof drainJobQueue === 'function' && spins++ < 1000) drainJobQueue()",
        "if (failure) throw failure",
        "assert.strictEqual(done, true)",
      ].join("\n"),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("http-message-internals-ok");
  }, DEFAULT_TEST_TIMEOUT);

  describe.skipIf(!hasNpm)("npm package installation", () => {
    it("installs cowsay with npm and runs its package bin", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "sm-node-npm-"));
      const workDir = join(tempDir, "work");
      const tmpMountDir = join(tempDir, "tmp");
      mkdirSync(workDir, { recursive: true });
      mkdirSync(tmpMountDir, { recursive: true });
      writeFileSync(join(workDir, "package.json"), JSON.stringify({ name: "demo", version: "0.0.1" }));
      const { npmDir, helperDir } = prepareNpmRuntime(tempDir);
      const { registryDir, cowsayTarballFilename } = createCowsayPackages(tempDir);
      const nodeBytes = loadWasm(nodeWasm!);
      const decoder = new TextDecoder();
      const ptyDecoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      let ptyOutput = "";
      const env = [
        "HOME=/work",
        "PWD=/work",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
        "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
        "SSL_CERT_DIR=/etc/ssl/certs",
        "npm_config_cache=/tmp/.npm-cache",
        "npm_config_fund=false",
        "npm_config_audit=false",
        "npm_config_progress=false",
        "npm_config_update_notifier=false",
        "NPM_CONFIG_FUND=false",
        "NPM_CONFIG_AUDIT=false",
        "NPM_CONFIG_PROGRESS=false",
        "NPM_CONFIG_UPDATE_NOTIFIER=false",
      ];
      const host = new NodeKernelHost({
        maxWorkers: 4,
        rootfsImage: "default",
        extraMounts: [
          { mountPoint: "/tmp", hostPath: tmpMountDir, readonly: false },
          { mountPoint: "/npm", hostPath: npmDir, readonly: true },
          { mountPoint: "/kandelo", hostPath: helperDir, readonly: true },
          { mountPoint: "/registry", hostPath: registryDir, readonly: true },
          { mountPoint: "/work", hostPath: workDir, readonly: false },
        ],
        onStdout: (_pid, data) => {
          stdout += decoder.decode(data);
        },
        onStderr: (_pid, data) => {
          stderr += decoder.decode(data);
        },
        onPtyOutput: (_pid, data) => {
          ptyOutput += ptyDecoder.decode(data, { stream: true });
        },
      });

      try {
        await withCiProgress("init npm cowsay kernel", host.init());
        const installExitCode = await withCiProgress(
          "npm install cowsay",
          host.spawn(
            nodeBytes,
            [
              "node",
              "/kandelo/npm-runner.js",
              "npm",
              "install",
              `file:///registry/${cowsayTarballFilename}`,
              "--no-fund",
              "--no-audit",
            ],
            { programModule: nodeModule, cwd: "/work", env, pty: true, ptyCols: 100, ptyRows: 30 },
          ),
        );

        expect(stderr).not.toContain("Exit handler never called");
        ptyOutput += ptyDecoder.decode();
        const logsDir = join(tmpMountDir, ".npm-cache", "_logs");
        const npmLogs = existsSync(logsDir)
          ? readdirSync(logsDir).map((name) => readFileSync(join(logsDir, name), "utf8")).join("\n--- npm log ---\n")
          : "";
        expect(installExitCode, `stdout:\n${stdout}\nstderr:\n${stderr}\npty:\n${ptyOutput}\nlogs:\n${npmLogs}`).toBe(0);
        expect(ptyOutput).toMatch(/added \d+ packages|[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/);
        expect(existsSync(join(workDir, "node_modules/cowsay/package.json"))).toBe(true);

        stdout = "";
        stderr = "";
        const cowsayExitCode = await withCiProgress(
          "run cowsay bin",
          host.spawn(
            nodeBytes,
            ["node", "/work/node_modules/.bin/cowsay", "Kandelo"],
            { programModule: nodeModule, cwd: "/work", env },
          ),
        );

        expect(cowsayExitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
        expect(stdout).toContain("Kandelo");
      } finally {
        await host.destroy().catch(() => {});
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, NPM_INSTALL_TEST_TIMEOUT);
  });

  it("supports fs sync and promise APIs through SpiderMonkey shell POSIX helpers", async () => {
    const result = await runNode(
      [
        "const fs = require('fs')",
        "const fsp = require('node:fs/promises')",
        "fs.mkdirSync('/tmp/sm-node-test', { recursive: true })",
        "fs.writeFileSync('/tmp/sm-node-test/file.txt', 'hello fs')",
        "fs.appendFileSync('/tmp/sm-node-test/file.txt', '!')",
        "fsp.readFile('/tmp/sm-node-test/file.txt', 'utf8').then((s) => {",
        "  console.log(s, fs.statSync('/tmp/sm-node-test/file.txt').isFile())",
        "  return fsp.open('/tmp/sm-node-test/file.txt', 'r')",
        "}).then((fh) => {",
        "  const buf = Buffer.alloc(5)",
        "  return fh.read(buf, 0, buf.length, 0).then(({ bytesRead, buffer }) =>",
        "    fh.chmod(0o755).then(() => fh.close()).then(() => console.log(bytesRead, buffer.toString())))",
        "}).then(() => new Promise((resolve, reject) => {",
        "  fs.chmod('/tmp/sm-node-test/file.txt', 0o644, (err) => err ? reject(err) : resolve())",
        "})).then(() => {",
        "  fs.rmSync('/tmp/sm-node-test', { recursive: true, force: true })",
        "  console.log(fs.existsSync('/tmp/sm-node-test'))",
        "})",
        "drainJobQueue()",
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "hello fs! true",
      "5 hello",
      "false",
    ]);
  }, DEFAULT_TEST_TIMEOUT);

  it("loads CommonJS files with relative require, JSON, and package main resolution", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sm-node-cjs-"));
    writeFileSync(join(tempDir, "data.json"), JSON.stringify({ value: 41 }));
    writeFileSync(
      join(tempDir, "helper.js"),
      "const data = require('./data.json'); exports.value = data.value + 1;\n",
    );
    const pkgDir = join(tempDir, "node_modules", "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ main: "main.js" }));
    writeFileSync(join(pkgDir, "main.js"), "module.exports = 'pkg-main';\n");
    const script = join(tempDir, "entry.js");
    writeFileSync(
      script,
      [
        "const helper = require('./helper')",
        "const pkg = require('pkg')",
        "console.log(__filename + '|' + __dirname)",
        "console.log(helper.value + ':' + pkg + ':' + process.argv.slice(2).join(','))",
      ].join("\n"),
    );

    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: "default",
      extraMounts: [{ mountPoint: "/mnt", hostPath: tempDir, readonly: true }],
      onStdout: (_pid, data) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (_pid, data) => {
        stderr += new TextDecoder().decode(data);
      },
    });

    try {
      await host.init();
      const exitCode = await host.spawn(
        loadWasm(nodeWasm!),
        ["node", "/mnt/entry.js", "alpha", "beta"],
        { programModule: nodeModule },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const lines = stdout.trim().split("\n");
      expect(lines[0]).toBe("/mnt/entry.js|/mnt");
      expect(lines[1]).toBe("42:pkg-main:alpha,beta");
    } finally {
      await host.destroy().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, DEFAULT_TEST_TIMEOUT);

  it("runs symlinked package bin entries from their real module directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sm-node-bin-"));
    const pkgDir = join(tempDir, "pkg");
    const binDir = join(tempDir, ".bin");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(pkgDir, "index.js"), "module.exports = 'real-bin';\n");
    writeFileSync(
      join(pkgDir, "cli.js"),
      [
        "console.log(__filename)",
        "console.log(__dirname)",
        "console.log(require('./index'))",
      ].join("\n"),
    );
    symlinkSync("../pkg/cli.js", join(binDir, "tool"));

    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: "default",
      extraMounts: [{ mountPoint: "/mnt", hostPath: tempDir, readonly: true }],
      onStdout: (_pid, data) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (_pid, data) => {
        stderr += new TextDecoder().decode(data);
      },
    });

    try {
      await host.init();
      const exitCode = await host.spawn(
        loadWasm(nodeWasm!),
        ["node", "/mnt/.bin/tool"],
        { programModule: nodeModule },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.trim().split("\n")).toEqual([
        "/mnt/pkg/cli.js",
        "/mnt/pkg",
        "real-bin",
      ]);
    } finally {
      await host.destroy().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, DEFAULT_TEST_TIMEOUT);

  it("runs shebang CommonJS main scripts through the Node loader", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sm-node-shebang-cjs-"));
    writeFileSync(
      join(tempDir, "tool.js"),
      [
        "#!/usr/bin/env node",
        "const path = require('path')",
        "console.log(path.basename(__filename), __dirname, process.argv.slice(2).join(','))",
      ].join("\n"),
      { mode: 0o755 },
    );

    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: "default",
      extraMounts: [{ mountPoint: "/mnt", hostPath: tempDir, readonly: true }],
      onStdout: (_pid, data) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (_pid, data) => {
        stderr += new TextDecoder().decode(data);
      },
    });

    try {
      await host.init();
      const exitCode = await host.spawn(
        loadWasm(nodeWasm!),
        ["node", "/mnt/tool.js", "alpha", "beta"],
        { programModule: nodeModule },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe("tool.js /mnt alpha,beta");
    } finally {
      await host.destroy().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, DEFAULT_TEST_TIMEOUT);

  it("runs type=module shebang bins with static imports and top-level await", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sm-node-shebang-esm-"));
    const pkgDir = join(tempDir, "pkg");
    const binDir = join(pkgDir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "esm-bin", type: "module" }));
    writeFileSync(
      join(binDir, "tool.js"),
      [
        "#!/usr/bin/env node",
        "import path from 'path'",
        "import { createRequire } from 'module'",
        "import { fileURLToPath } from 'url'",
        "const require = createRequire(import.meta.url)",
        "const __filename = fileURLToPath(import.meta.url)",
        "await Promise.resolve()",
        "console.log('esm', typeof require, path.basename(__filename), process.argv.slice(2).join(','))",
      ].join("\n"),
      { mode: 0o755 },
    );

    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: "default",
      extraMounts: [{ mountPoint: "/mnt", hostPath: tempDir, readonly: true }],
      onStdout: (_pid, data) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (_pid, data) => {
        stderr += new TextDecoder().decode(data);
      },
    });

    try {
      await host.init();
      const exitCode = await host.spawn(
        loadWasm(nodeWasm!),
        ["node", "/mnt/pkg/bin/tool.js", "alpha", "beta"],
        { programModule: nodeModule },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe("esm function tool.js alpha,beta");
    } finally {
      await host.destroy().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, DEFAULT_TEST_TIMEOUT);

  it("prints ES module main error messages before SpiderMonkey stacks", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sm-node-esm-error-"));
    const pkgDir = join(tempDir, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "esm-error", type: "module" }));
    writeFileSync(
      join(pkgDir, "fail.js"),
      [
        "#!/usr/bin/env node",
        "throw new Error('visible esm failure')",
      ].join("\n"),
      { mode: 0o755 },
    );

    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: "default",
      extraMounts: [{ mountPoint: "/mnt", hostPath: tempDir, readonly: true }],
      onStdout: (_pid, data) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (_pid, data) => {
        stderr += new TextDecoder().decode(data);
      },
    });

    try {
      await host.init();
      const exitCode = await host.spawn(
        loadWasm(nodeWasm!),
        ["node", "/mnt/pkg/fail.js"],
        { programModule: nodeModule },
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Error: visible esm failure");
      expect(stderr).toContain("/mnt/pkg/fail.js");
    } finally {
      await host.destroy().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, DEFAULT_TEST_TIMEOUT);

  it("runs SpiderMonkey shell workers from worker_threads with shared memory enabled by Node mode", async () => {
    const result = await runNode(
      [
        "const { Worker } = require('worker_threads')",
        "const sab = new SharedArrayBuffer(8)",
        "const view = new Int32Array(sab)",
        "const worker = new Worker(\"const view = new Int32Array(workerData); Atomics.store(view, 0, 42); Atomics.store(view, 1, 1); Atomics.notify(view, 1);\", { eval: true, workerData: sab })",
        "if (Atomics.load(view, 1) === 0) Atomics.wait(view, 1, 0, 10000)",
        "if (Atomics.load(view, 1) !== 1) throw new Error('worker did not finish')",
        "console.log(Atomics.load(view, 0))",
        "worker.terminate()",
        "console.log('after-terminate')",
      ].join("\n"),
      LONG_TIMEOUT,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["42", "after-terminate"]);
  }, LONG_TEST_TIMEOUT);

  it("lets finite worker_threads workers exit without explicit termination", async () => {
    const result = await runNode(
      [
        "const { Worker } = require('worker_threads')",
        "const worker = new Worker('globalThis.__workerDone = true;', { eval: true })",
        "worker.once('online', () => console.log('online'))",
        "worker.once('exit', (code) => console.log('exit', code))",
      ].join("\n"),
      LONG_TIMEOUT,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["online", "exit 0"]);
  }, LONG_TEST_TIMEOUT);

  it("terminates CPU-bound worker_threads workers", async () => {
    const result = await runNode(
      [
        "const { Worker } = require('worker_threads')",
        "const worker = new Worker('while(true);', { eval: true })",
        "worker.once('exit', (code) => console.log('exit', code))",
        "worker.once('online', () => worker.terminate().then((code) => console.log('terminated', code)))",
      ].join("\n"),
      LONG_TIMEOUT,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["exit 1", "terminated 1"]);
  }, LONG_TEST_TIMEOUT);

  it("terminates worker_threads workers stuck in the microtask queue", async () => {
    const result = await runNode(
      [
        "const { Worker } = require('worker_threads')",
        "const worker = new Worker(`",
        "function loop() { Promise.resolve().then(loop); } loop();",
        "require('worker_threads').parentPort.postMessage('up');",
        "`, { eval: true })",
        "worker.once('exit', (code) => console.log('exit', code))",
        "worker.once('message', (message) => {",
        "  console.log('message', message)",
        "  setImmediate(() => worker.terminate().then((code) => console.log('terminated', code)))",
        "})",
      ].join("\n"),
      LONG_TIMEOUT,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "message up",
      "exit 1",
      "terminated 1",
    ]);
  }, LONG_TEST_TIMEOUT);
});
