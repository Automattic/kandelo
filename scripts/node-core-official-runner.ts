import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

type HostName = "node" | "browser";
type ExpectedStatus = "PASS" | "FAIL" | "XFAIL" | "SKIP";
type ActualStatus = ExpectedStatus | "ERROR" | "XPASS";
type SelectionMode = "full-suite" | "manifest";
type Browser = import("playwright").Browser;
type BrowserContext = import("playwright").BrowserContext;
type Page = import("playwright").Page;

interface SourceSpec {
  repo: string;
  tag: string;
  tagObject: string;
  commit: string;
  sparsePaths: string[];
}

interface ManifestTest {
  path: string;
  area: string;
  expected: ExpectedStatus;
  reason?: string;
  smoke?: boolean;
  timeoutMs?: number;
  hosts?: Partial<Record<HostName, {
    expected?: ExpectedStatus;
    reason?: string;
    timeoutMs?: number;
  }>>;
}

interface Manifest {
  source: SourceSpec;
  defaults?: {
    timeoutMs?: number;
    jobs?: number;
  };
  tests: ManifestTest[];
}

interface Options {
  host: HostName;
  manifestPath: string;
  sourceDir?: string;
  cacheDir: string;
  fetchSource: boolean;
  resultsDir?: string;
  runtimePath?: string;
  timeoutMs?: number;
  jobs?: number;
  smoke: boolean;
  list: boolean;
  explain: boolean;
  selectionMode: SelectionMode;
  areas: Set<string>;
  tests: Set<string>;
}

interface SelectedTest {
  spec: ManifestTest;
  expected: ExpectedStatus;
  reason: string;
  timeoutMs: number;
}

interface IsolatedTest {
  test: SelectedTest;
  isolation: TestIsolation;
}

interface TestIsolation {
  serialId: string;
  nodeTestDir: string;
  browserTestDir: string;
  browserMarkerPath: string;
}

interface RawRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timeout: boolean;
  error?: string;
}

interface RecordedResult {
  path: string;
  area: string;
  host: HostName;
  expectedStatus: ExpectedStatus;
  status: ActualStatus;
  unexpected: boolean;
  durationMs: number;
  exitCode: number | null;
  timeout: boolean;
  reason: string;
  stdout: string;
  stderr: string;
  error?: string;
}

interface NodeHostCleanupTarget {
  terminateProcess(pid: number, status?: number): Promise<void>;
  destroy(): Promise<void>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = join(repoRoot, "tests/node-core-official/manifest.json");
const defaultCacheDir = join(repoRoot, ".cache/node-core-official");
const textDecoder = new TextDecoder();
const NODE_HOST_CLEANUP_TIMEOUT_MS = 5_000;

function usage(): never {
  console.error("Usage: scripts/run-node-core-official-tests.sh [--host node|browser] [--fetch-source] [--smoke|--list|--explain]");
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    host: "node",
    manifestPath: defaultManifestPath,
    cacheDir: defaultCacheDir,
    fetchSource: false,
    smoke: false,
    list: false,
    explain: false,
    selectionMode: "full-suite",
    areas: new Set(),
    tests: new Set(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) usage();
      return next;
    };
    switch (arg) {
      case "--host": {
        const host = value();
        if (host !== "node" && host !== "browser") usage();
        options.host = host;
        break;
      }
      case "--manifest":
        options.manifestPath = resolve(value());
        break;
      case "--source-dir":
        options.sourceDir = resolve(value());
        break;
      case "--cache-dir":
        options.cacheDir = resolve(value());
        break;
      case "--fetch-source":
        options.fetchSource = true;
        break;
      case "--results-dir":
        options.resultsDir = resolve(value());
        break;
      case "--runtime":
        options.runtimePath = resolve(value());
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(value(), "--timeout-ms");
        break;
      case "--jobs":
        options.jobs = parsePositiveInt(value(), "--jobs");
        break;
      case "--area":
        options.areas.add(value());
        break;
      case "--test":
        options.tests.add(normalizeOfficialPath(value()));
        break;
      case "--full-suite":
      case "--full":
        options.selectionMode = "full-suite";
        break;
      case "--manifest-only":
        options.selectionMode = "manifest";
        break;
      case "--smoke":
        options.smoke = true;
        options.selectionMode = "manifest";
        break;
      case "--list":
        options.list = true;
        break;
      case "--explain":
        options.explain = true;
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        if (arg.startsWith("-")) usage();
        options.tests.add(normalizeOfficialPath(arg));
        break;
    }
  }

  return options;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function loadManifest(path: string): Manifest {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (!manifest.source?.repo || !manifest.source?.tag || !manifest.source?.commit) {
    throw new Error(`Manifest ${path} is missing source provenance`);
  }
  if (!Array.isArray(manifest.tests)) {
    throw new Error(`Manifest ${path} is missing tests[]`);
  }
  return manifest;
}

function normalizeOfficialPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function selectManifestTests(manifest: Manifest, options: Options): SelectedTest[] {
  const defaultTimeoutMs = options.timeoutMs ?? manifest.defaults?.timeoutMs ?? 30_000;
  return manifest.tests
    .filter((test) => !options.smoke || test.smoke)
    .filter((test) => options.areas.size === 0 || options.areas.has(test.area))
    .filter((test) => options.tests.size === 0 || options.tests.has(normalizeOfficialPath(test.path)))
    .map((test) => {
      const hostOverride = test.hosts?.[options.host];
      return {
        spec: { ...test, path: normalizeOfficialPath(test.path) },
        expected: hostOverride?.expected ?? test.expected,
        reason: hostOverride?.reason ?? test.reason ?? "",
        timeoutMs: options.timeoutMs ?? hostOverride?.timeoutMs ?? test.timeoutMs ?? defaultTimeoutMs,
      };
    });
}

function manifestOverridesByPath(manifest: Manifest): Map<string, ManifestTest> {
  const overrides = new Map<string, ManifestTest>();
  for (const test of manifest.tests) {
    overrides.set(normalizeOfficialPath(test.path), {
      ...test,
      path: normalizeOfficialPath(test.path),
    });
  }
  return overrides;
}

function selectFullSuiteTests(manifest: Manifest, sourceDir: string, options: Options): SelectedTest[] {
  const defaultTimeoutMs = options.timeoutMs ?? manifest.defaults?.timeoutMs ?? 30_000;
  const parallelDir = join(sourceDir, "test/parallel");
  const overrides = manifestOverridesByPath(manifest);
  return walkFiles(parallelDir)
    .map((file) => normalizeOfficialPath(relative(sourceDir, file)))
    .filter((path) => /^test\/parallel\/test-.+\.js$/.test(path))
    .map((path): SelectedTest => {
      const area = areaForOfficialParallelTest(path);
      const override = overrides.get(path);
      const hostOverride = override?.hosts?.[options.host];
      const expected = hostOverride?.expected ?? override?.expected ?? "PASS";
      const reason = hostOverride?.reason ?? override?.reason ??
        "Discovered from upstream Node v22.0.0 test/parallel/test-*.js; expected to pass unless this test has an explicit post-triage manifest override.";
      return {
        spec: {
          path,
          area: override?.area ?? area,
          expected,
          reason,
        },
        expected,
        reason,
        timeoutMs: options.timeoutMs ?? hostOverride?.timeoutMs ?? override?.timeoutMs ?? defaultTimeoutMs,
      };
    })
    .filter((test) => options.areas.size === 0 || options.areas.has(test.spec.area))
    .filter((test) => options.tests.size === 0 || options.tests.has(test.spec.path));
}

function areaForOfficialParallelTest(path: string): string {
  const name = basename(path).replace(/^test-/, "").replace(/\.js$/, "");
  const mappings: Array<[RegExp, string]> = [
    [/^(whatwg-url|url)(?:-|$)/, "url"],
    [/^(querystring)(?:-|$)/, "querystring"],
    [/^(string-decoder)(?:-|$)/, "string_decoder"],
    [/^(eventtarget|events?)(?:-|$)/, "events"],
    [/^(buffer|blob|file)(?:-|$)/, "buffer"],
    [/^(timers?|next-tick)(?:-|$)/, "timers"],
    [/^(console)(?:-|$)/, "console"],
    [/^(util)(?:-|$)/, "util"],
    [/^(path)(?:-|$)/, "path"],
    [/^(fs|filehandle|statfs|watch-file)(?:-|$)/, "fs"],
    [/^(stream|stream2|stream3|readable|writable|duplex|pipeline|finished)(?:-|$)/, "stream"],
    [/^(module|modules|require|commonjs|esm|es-module|cjs|resolve)(?:-|$)/, "loader"],
    [/^(process|stdin|stdout|stderr|child-process|spawn|exec|signal)(?:-|$)/, "process"],
    [/^(os)(?:-|$)/, "os"],
    [/^(crypto|webcrypto|random)(?:-|$)/, "crypto"],
    [/^(zlib|brotli)(?:-|$)/, "zlib"],
    [/^(net|socket|tcp|udp|dns|http|https|tls|http2|dgram)(?:-|$)/, "network"],
    [/^(vm)(?:-|$)/, "vm"],
    [/^(v8|inspector|debugger|coverage|trace|tick-processor)(?:-|$)/, "v8_inspector"],
    [/^(worker|worker-memory|messageport|broadcastchannel)(?:-|$)/, "workers"],
    [/^(wasi)(?:-|$)/, "wasi"],
    [/^(assert)(?:-|$)/, "assert"],
  ];
  for (const [pattern, area] of mappings) {
    if (pattern.test(name)) return area;
  }
  return name.split("-")[0] || "misc";
}

function sourceDirFor(manifest: Manifest, options: Options): string {
  return options.sourceDir ?? join(options.cacheDir, `node-${manifest.source.tag}`);
}

function ensureSource(manifest: Manifest, options: Options): { dir: string; commit: string | null } {
  const dir = sourceDirFor(manifest, options);
  if (!existsSync(join(dir, "test/parallel"))) {
    if (!options.fetchSource) {
      throw new Error(
        `Node source checkout not found at ${dir}.\n` +
        `Run with --fetch-source, or pass --source-dir pointing at a sparse checkout of ${manifest.source.tag}.`,
      );
    }
    if (existsSync(join(dir, ".git"))) {
      runCommand("git", ["-C", dir, "fetch", "--depth", "1", "origin", manifest.source.tag]);
      runCommand("git", ["-C", dir, "checkout", "FETCH_HEAD"]);
    } else {
      if (existsSync(dir) && readdirSync(dir).length > 0) {
        throw new Error(`Source directory exists but is not a git checkout: ${dir}`);
      }
      mkdirSync(dirname(dir), { recursive: true });
      runCommand("git", [
        "clone",
        "--depth", "1",
        "--branch", manifest.source.tag,
        "--filter=blob:none",
        "--sparse",
        manifest.source.repo,
        dir,
      ]);
    }
    runCommand("git", ["-C", dir, "sparse-checkout", "set", ...manifest.source.sparsePaths]);
  }

  const commit = gitRevParse(dir);
  if (commit && commit !== manifest.source.commit) {
    throw new Error(
      `Node source checkout is at ${commit}, expected ${manifest.source.commit} (${manifest.source.tag})`,
    );
  }
  for (const sparsePath of ["test/parallel", "test/common", "test/fixtures"]) {
    if (!existsSync(join(dir, sparsePath))) {
      throw new Error(`Node source checkout is missing ${sparsePath}`);
    }
  }
  return { dir, commit };
}

function runCommand(command: string, args: string[]): void {
  const child = spawnSync(command, args, { stdio: "inherit" });
  const status = child.status ?? 1;
  if (status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${status}`);
  }
}

function gitRevParse(dir: string): string | null {
  if (!existsSync(join(dir, ".git"))) return null;
  const child = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  return child.status === 0 ? child.stdout.trim() : null;
}

async function resolveRuntime(path?: string): Promise<string> {
  if (path) {
    if (!existsSync(path)) throw new Error(`Runtime wasm not found: ${path}`);
    return path;
  }
  const { tryResolveBinary } = await import("../host/src/binary-resolver");
  const resolved =
    tryResolveBinary("programs/spidermonkey-node.wasm") ??
    tryResolveBinary("programs/node.wasm") ??
    join(repoRoot, "packages/registry/spidermonkey-node/bin/node.wasm");
  if (!existsSync(resolved)) {
    throw new Error(
      `Kandelo Node-compatible wasm binary not found.\n` +
      `Run scripts/fetch-binaries.sh --allow-stale or build packages/registry/spidermonkey-node.`,
    );
  }
  return resolved;
}

async function resolveShellRuntime(): Promise<string | null> {
  const { tryResolveBinary } = await import("../host/src/binary-resolver");
  const resolved =
    tryResolveBinary("programs/sh.wasm") ??
    tryResolveBinary("programs/dash.wasm");
  return resolved && existsSync(resolved) ? resolved : null;
}

function makeResultsDir(options: Options): string {
  if (options.resultsDir) {
    mkdirSync(options.resultsDir, { recursive: true });
    return options.resultsDir;
  }
  const mode = options.smoke ? "smoke" : options.selectionMode;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const dir = join(repoRoot, "test-runs", `node-core-official-${options.host}-${mode}`, stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePrelude(resultsDir: string): string {
  const preludePath = join(resultsDir, "kandelo-node-core-prelude.js");
  writeFileSync(preludePath, `\
'use strict';

const testFile = process.argv[2];
if (!testFile) {
  throw new Error('kandelo-node-core-prelude requires an official test path as argv[2]');
}

const path = require('path');
const disabledGlobalsByTest = {
  'test-global-webcrypto-disbled.js': ['crypto', 'Crypto', 'CryptoKey', 'SubtleCrypto'],
  'test-websocket-disabled.js': ['WebSocket'],
};
const disabledGlobals = disabledGlobalsByTest[path.basename(testFile)] || [];
for (const name of disabledGlobals) {
  try {
    delete globalThis[name];
  } catch {
  }
  if (typeof globalThis[name] !== 'undefined') {
    try {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        writable: true,
        configurable: true,
      });
    } catch {
    }
  }
}

process.argv[1] = testFile;
process.env.NODE_SKIP_FLAG_CHECK = '1';
process.env.NODE_DISABLE_COLORS = process.env.NODE_DISABLE_COLORS || '1';
process.env.NODE_TEST_KNOWN_GLOBALS = process.env.NODE_TEST_KNOWN_GLOBALS || '0';

process.config = process.config || {};
process.config.variables = Object.assign({
  asan: 0,
  debug_node: 0,
  icu_gyp_path: '',
  is_debug: 0,
  node_shared: false,
  node_shared_openssl: false,
  node_use_openssl: Boolean(process.versions && process.versions.openssl),
  openssl_quic: 0,
  shlib_suffix: '.so',
  single_executable_application: false,
  ubsan: 0,
  v8_enable_i18n_support: 0,
  want_separate_host_toolset: 0
}, process.config.variables || {});
process.config.target_defaults = Object.assign({
  default_configuration: 'Release'
}, process.config.target_defaults || {});

process.features = Object.assign({
  cached_builtins: false,
  debug: false,
  inspector: false,
  ipv6: true,
  tls: Boolean(process.versions && process.versions.openssl)
}, process.features || {});

if (!Array.isArray(process.execArgv)) process.execArgv = [];
if (!process.execPath) process.execPath = '/usr/bin/node';

const common = require(path.join(path.dirname(testFile), '..', 'common'));
if (process.versions && process.versions.spidermonkey && common) {
  const assert = require('assert');
  const util = require('util');
  const inspect = util.inspect;

  if (typeof common.mustNotCall === 'function' && !common.mustNotCall.__kandeloSpiderMonkeyCallSite) {
    const originalMustNotCall = common.mustNotCall;
    function parseStackFrame(line) {
      const match = String(line).match(/^(?:[^@]*)@(.+):(\\d+):(\\d+)$/);
      if (!match) return null;
      return { file: match[1], line: Number(match[2]) };
    }
    function callSiteFromStack(stack) {
      const lines = String(stack || '').split('\\n');
      for (const line of lines) {
        const frame = parseStackFrame(line);
        if (!frame) continue;
        if (path.basename(frame.file) === 'kandelo-node-core-prelude.js') continue;
        if (frame.file.endsWith('/test/common/index.js')) continue;
        return frame.file + ':' + Math.max(1, frame.line - 1);
      }
      return '<unknown>:0';
    }
    function inspectMustNotCallArg(arg) {
      const type = typeof arg;
      if (arg === null || (type !== 'object' && type !== 'function')) {
        return inspect(arg);
      }
      if (Array.isArray(arg)) {
        return '[' + arg.map((item) => inspectMustNotCallArg(item)).join(', ') + ']';
      }
      return type === 'function' ? '[Function]' : '[Object]';
    }
    const patchedMustNotCall = function mustNotCall(msg) {
      const callSite = callSiteFromStack(new Error().stack);
      return function mustNotCall(...args) {
        const argsInfo = args.length > 0 ?
          '\\ncalled with arguments: ' + args.map((arg) => inspectMustNotCallArg(arg)).join(', ') : '';
        throw new assert.AssertionError({
          message: (msg || 'function should not have been called') + ' at ' + callSite + argsInfo,
          operator: 'fail',
        });
      };
    };
    Object.defineProperty(patchedMustNotCall, '__kandeloSpiderMonkeyCallSite', { value: true });
    common.mustNotCall = patchedMustNotCall;
    common._kandeloOriginalMustNotCall = originalMustNotCall;
  }

}
if (common && typeof common.allowGlobals === 'function') {
  const knownGlobalNames = [
    '__dirname',
    '__filename',
    '__kandeloCreateWorkerThreads',
    '__kandeloNextTimerDelay',
    '__kandeloRunDueTimers',
    'AbortController',
    'AbortSignal',
    'Blob',
    'BroadcastChannel',
    'Buffer',
    'ByteLengthQueuingStrategy',
    'CloseEvent',
    'CountQueuingStrategy',
    'Crypto',
    'CryptoKey',
    'CustomEvent',
    'DOMException',
    'ErrorEvent',
    'Event',
    'EventTarget',
    'File',
    'FormData',
    'GLOBAL',
    'Headers',
    'MessageChannel',
    'MessageEvent',
    'MessagePort',
    'ReadableStream',
    'Request',
    'Response',
    'SubtleCrypto',
    'TextDecoder',
    'TextEncoder',
    'TransformStream',
    'URL',
    'URLSearchParams',
    'WebSocket',
    'WritableStream',
    'atob',
    'argv0',
    'btoa',
    'clearImmediate',
    'clearInterval',
    'clearTimeout',
    'crypto',
    'drainJobQueue',
    'execArgv',
    'exports',
    'fetch',
    'global',
    'module',
    'process',
    'queueMicrotask',
    'require',
    'setImmediate',
    'setInterval',
    'setTimeout',
    'structuredClone',
  ];
  common.allowGlobals(...knownGlobalNames
    .filter((name) => !disabledGlobals.includes(name) && typeof globalThis[name] !== 'undefined')
    .map((name) => globalThis[name]));
}

if (typeof globalThis.__kandeloRunCommonJsMain !== 'function') {
  throw new Error('Kandelo runtime is missing __kandeloRunCommonJsMain');
}
globalThis.__kandeloRunCommonJsMain(testFile);
`);
  return preludePath;
}

function describeRuntimeCandidate(): string {
  const candidates = [
    "local-binaries/programs/wasm32/spidermonkey-node.wasm",
    "binaries/programs/wasm32/spidermonkey-node.wasm",
    "local-binaries/programs/wasm32/node.wasm",
    "binaries/programs/wasm32/node.wasm",
    "packages/registry/spidermonkey-node/bin/node.wasm",
  ];
  return candidates.find((candidate) => existsSync(join(repoRoot, candidate))) ?? candidates.join(" | ");
}

function explain(
  manifest: Manifest,
  options: Options,
  selected: SelectedTest[],
  sourceDir: string,
): void {
  const statusCounts = countBy(selected, (test) => test.expected);
  const areaCounts = countBy(selected, (test) => test.spec.area);
  const jobs = options.jobs ?? manifest.defaults?.jobs ?? 1;
  const resultsDir = options.resultsDir ?? join(
    repoRoot,
    "test-runs",
    `node-core-official-${options.host}-${options.smoke ? "smoke" : options.selectionMode}`,
    "<timestamp>",
  );
  const runtime =
    options.runtimePath ??
    describeRuntimeCandidate();

  console.log("Official Node.js core JS module harness");
  console.log(`host=${options.host}`);
  console.log(`source_repo=${manifest.source.repo}`);
  console.log(`source_tag=${manifest.source.tag}`);
  console.log(`source_tag_object=${manifest.source.tagObject}`);
  console.log(`source_commit=${manifest.source.commit}`);
  console.log(`source_dir=${sourceDir}`);
  console.log(`runtime=${runtime}`);
  console.log(`manifest=${options.manifestPath}`);
  console.log(`results_dir=${resultsDir}`);
  console.log(`timeout_ms=${options.timeoutMs ?? manifest.defaults?.timeoutMs ?? 30_000}`);
  console.log(`jobs=${jobs}`);
  console.log(`mode=${options.smoke ? "smoke" : options.selectionMode}`);
  console.log(`selected=${selected.length}`);
  console.log(`status_counts=${JSON.stringify(statusCounts)}`);
  console.log(`area_counts=${JSON.stringify(areaCounts)}`);
  console.log("artifacts=summary.txt, summary.json, results.ndjson, manifest.used.json, stdout/*.log, stderr/*.log");
  if (options.host === "browser") {
    console.log("browser_artifacts=browser-console.log");
  }
}

function countBy<T>(items: T[], fn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[fn(item)] = (counts[fn(item)] ?? 0) + 1;
  return counts;
}

function safeName(path: string): string {
  return path.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
}

function createIsolatedTests(tests: SelectedTest[], resultsDir: string): IsolatedTest[] {
  return tests.map((test, index) => {
    const serialId = String(index + 1);
    const testDirName = `${serialId}-${safeName(test.spec.path)}`;
    const browserTestDir = `/node-v22.0.0/.kandelo-test-roots/${testDirName}`;
    return {
      test,
      isolation: {
        serialId,
        nodeTestDir: join(resultsDir, "node-test-roots", testDirName),
        browserTestDir,
        browserMarkerPath: `${browserTestDir}/.keep`,
      },
    };
  });
}

function envForRun(isolation?: TestIsolation): string[] {
  const env = new Map<string, string>();
  env.set("HOME", "/tmp");
  env.set("PATH", "/usr/local/bin:/usr/bin:/bin");
  env.set("TMPDIR", "/tmp");
  env.set("TMP", "/tmp");
  env.set("TEMP", "/tmp");
  env.set("NODE_SKIP_FLAG_CHECK", "1");
  env.set("NODE_DISABLE_COLORS", "1");
  env.set("NODE_TEST_KNOWN_GLOBALS", "0");
  env.set("TERM", "dumb");
  env.set("CI", "1");
  if (isolation) {
    env.set("NODE_TEST_DIR", isolation.nodeTestDir);
    env.set("TEST_SERIAL_ID", isolation.serialId);
    env.set("TEST_THREAD_ID", isolation.serialId);
  }
  return [...env.entries()].map(([key, value]) => `${key}=${value}`);
}

export {
  createIsolatedTests,
  destroyNodeHostBestEffort,
  envForRun,
  terminateTimedOutNodeHostBestEffort,
  writePrelude,
};

export type {
  IsolatedTest,
  SelectedTest,
  TestIsolation,
};

async function runNodeTest(
  isolated: IsolatedTest,
  sourceDir: string,
  preludePath: string,
  runtimePath: string,
  programBytes: ArrayBuffer,
  shellRuntimePath: string | null,
): Promise<RawRunResult> {
  const { test, isolation } = isolated;
  const { NodeKernelHost } = await import("../host/src/node-kernel-host");
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let pid: number | null = null;
  let timeout = false;
  const testPath = join(sourceDir, test.spec.path);
  const nodeBinDir = join(isolation.nodeTestDir, "usr-bin");
  mkdirSync(nodeBinDir, { recursive: true });
  copyFileSync(runtimePath, join(nodeBinDir, "node"));

  const host = new NodeKernelHost({
    maxWorkers: 4,
    execPrograms: {
      "node": runtimePath,
      "/bin/node": runtimePath,
      "/usr/bin/node": runtimePath,
      "/usr/local/bin/node": runtimePath,
      ...(shellRuntimePath ? {
        "sh": shellRuntimePath,
        "/bin/sh": shellRuntimePath,
        "/usr/bin/sh": shellRuntimePath,
      } : {}),
    },
    extraMounts: [
      { mountPoint: "/usr/bin", hostPath: nodeBinDir, readonly: true },
    ],
    onStdout: (_pid, data) => { stdout += textDecoder.decode(data); },
    onStderr: (_pid, data) => { stderr += textDecoder.decode(data); },
  });

  try {
    mkdirSync(isolation.nodeTestDir, { recursive: true });
    await host.init();
    const exitPromise = host.spawn(programBytes, ["node", preludePath, testPath], {
      cwd: sourceDir,
      env: envForRun(isolation),
      onStarted: (startedPid) => { pid = startedPid; },
    });
    const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
      setTimeout(() => resolveTimeout("timeout"), test.timeoutMs);
    });
    const result = await Promise.race([exitPromise, timeoutPromise]);
    if (result === "timeout") {
      timeout = true;
      await terminateTimedOutNodeHostBestEffort(host, pid);
      return {
        exitCode: 124,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timeout,
        error: `timeout after ${test.timeoutMs}ms`,
      };
    }
    return {
      exitCode: result,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      timeout,
    };
  } catch (err) {
    return {
      exitCode: null,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      timeout,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await destroyNodeHostBestEffort(host);
  }
}

async function terminateTimedOutNodeHostBestEffort(
  host: Pick<NodeHostCleanupTarget, "terminateProcess">,
  pid: number | null,
): Promise<void> {
  if (pid === null) return;
  await withHostTimeout(
    host.terminateProcess(pid, 124),
    NODE_HOST_CLEANUP_TIMEOUT_MS,
    `node host terminateProcess(${pid}) cleanup timeout after ${NODE_HOST_CLEANUP_TIMEOUT_MS}ms`,
  ).catch(() => {});
}

async function destroyNodeHostBestEffort(
  host: Pick<NodeHostCleanupTarget, "destroy">,
): Promise<void> {
  await withHostTimeout(
    host.destroy(),
    NODE_HOST_CLEANUP_TIMEOUT_MS,
    `node host destroy cleanup timeout after ${NODE_HOST_CLEANUP_TIMEOUT_MS}ms`,
  ).catch(() => {});
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function runBrowserTests(
  isolatedTests: IsolatedTest[],
  sourceDir: string,
  preludePath: string,
  runtimePath: string,
  resultsDir: string,
  jobs: number,
): Promise<Map<string, RawRunResult>> {
  const { chromium } = await import("playwright");
  const consoleLog = join(resultsDir, "browser-console.log");
  writeFileSync(consoleLog, "");
  const baseFiles = collectBrowserDataFiles(sourceDir, preludePath);
  const runtimeUrl = nodeCoreOfficialUrl("runtime");
  let viteProc: ChildProcess | null = null;
  let browser: Browser | null = null;
  const results = new Map<string, RawRunResult>();

  try {
    viteProc = await startViteServer(consoleLog, { sourceDir, resultsDir, runtimePath });
    browser = await chromium.launch({
      args: ["--enable-features=SharedArrayBuffer"],
    });
    const context = await browser.newContext();
    let next = 0;
    const browserJobs = Math.max(1, Math.min(jobs, isolatedTests.length));
    await Promise.all(Array.from({ length: browserJobs }, async (_, workerId) => {
      let page = await createBrowserWorkerPage(context, workerId, baseFiles, consoleLog);
      try {
        while (next < isolatedTests.length) {
          const index = next++;
          const { test, isolation } = isolatedTests[index];
          const started = Date.now();
          const testHostPath = join(sourceDir, test.spec.path);
          const dataFiles = [
            dataFileFromSourceUrl(sourceDir, testHostPath, `/node-v22.0.0/${test.spec.path}`),
            { path: isolation.browserMarkerPath, data: [], mode: 0o644 },
            { path: "/usr/bin/node", useWasmBytes: true, mode: 0o755 },
          ];
          try {
            const result = await withHostTimeout(
              page.evaluate(
                async ({ wasmUrl, argv, timeoutMs, dataFiles: files, env }) => {
                  return await (window as any).__runTestFromUrl(
                    wasmUrl,
                    argv,
                    timeoutMs,
                    { useNodeCoreOfficialBaseFiles: true, dataFiles: files, cwd: "/node-v22.0.0", env },
                  );
                },
                {
                  wasmUrl: runtimeUrl,
                  argv: [
                    "node",
                    "/node-v22.0.0/kandelo-node-core-prelude.js",
                    `/node-v22.0.0/${test.spec.path}`,
                  ],
                  timeoutMs: test.timeoutMs,
                  dataFiles,
                  env: envForRun({
                    ...isolation,
                    nodeTestDir: isolation.browserTestDir,
                  }),
                },
              ),
              test.timeoutMs + 2_000,
              `browser host timeout after ${test.timeoutMs + 2_000}ms`,
            );
            results.set(test.spec.path, {
              exitCode: result.exitCode,
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? "",
              durationMs: Date.now() - started,
              timeout: false,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            results.set(test.spec.path, {
              exitCode: message.includes("TIMEOUT") ? 124 : null,
              stdout: "",
              stderr: "",
              durationMs: Date.now() - started,
              timeout: message.includes("TIMEOUT"),
              error: message,
            });
            if (message.includes("browser host timeout") || message.includes("Target page") || message.includes("Execution context")) {
              appendText(consoleLog, `[page:${workerId}:reset] ${test.spec.path}: ${message}\n`);
              await closePageBestEffort(page);
              page = await createBrowserWorkerPage(context, workerId, baseFiles, consoleLog);
            }
          } finally {
            if (results.size > 0 && results.size % 100 === 0) {
              appendText(consoleLog, `[progress] completed=${results.size}/${isolatedTests.length}\n`);
            }
          }
        }
      } finally {
        await closePageBestEffort(page);
      }
    }));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) {
      viteProc.kill();
      await new Promise<void>((resolveExit) => {
        viteProc!.once("exit", () => resolveExit());
        setTimeout(resolveExit, 2_000);
      });
    }
  }

  return results;
}

async function createBrowserWorkerPage(
  context: BrowserContext,
  workerId: number,
  baseFiles: BrowserDataFile[],
  consoleLog: string,
): Promise<Page> {
  const page = await context.newPage();
  page.on("console", (msg) => {
    appendText(consoleLog, `[page:${workerId}:console:${msg.type()}] ${msg.text()}\n`);
  });
  page.on("pageerror", (err) => {
    appendText(consoleLog, `[page:${workerId}:pageerror] ${err.stack || err.message}\n`);
  });
  page.on("crash", () => {
    appendText(consoleLog, `[page:${workerId}:pagecrash] page crashed\n`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    appendText(consoleLog, `[page:${workerId}:requestfailed] ${request.url()} ${failure?.errorText ?? ""}\n`);
  });
  await waitForTestRunner(page);
  await page.evaluate((files) => {
    (window as any).__setNodeCoreOfficialBaseFiles(files);
  }, baseFiles);
  return page;
}

async function closePageBestEffort(page: Page): Promise<void> {
  await withHostTimeout(page.close({ runBeforeUnload: false }), 2_000, "page close timeout").catch(() => {});
}

function withHostTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  return new Promise<T>((resolvePromise, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

interface BrowserDataFile {
  path: string;
  data?: number[];
  url?: string;
  lazy?: boolean;
  size?: number;
  mode?: number;
  useWasmBytes?: boolean;
}

function collectBrowserDataFiles(sourceDir: string, preludePath: string): BrowserDataFile[] {
  const files: BrowserDataFile[] = [
    dataFileFromResultsData(preludePath, "/node-v22.0.0/kandelo-node-core-prelude.js"),
  ];
  for (const relDir of ["test/common", "test/fixtures", "lib"]) {
    const absDir = join(sourceDir, relDir);
    for (const file of walkFiles(absDir)) {
      files.push(dataFileFromSourceUrl(sourceDir, file, `/node-v22.0.0/${relative(sourceDir, file).replace(/\\/g, "/")}`));
    }
  }
  return files;
}

function dataFileFromSourceUrl(sourceDir: string, hostPath: string, vfsPath: string): BrowserDataFile {
  return {
    path: vfsPath,
    url: nodeCoreOfficialUrl("source", relative(sourceDir, hostPath)),
    lazy: true,
    size: statSync(hostPath).size,
    mode: 0o644,
  };
}

function dataFileFromResultsData(hostPath: string, vfsPath: string): BrowserDataFile {
  return {
    path: vfsPath,
    data: Array.from(readFileSync(hostPath)),
    mode: 0o644,
  };
}

function nodeCoreOfficialUrl(kind: "runtime" | "source" | "results", relPath = ""): string {
  const prefix = "/__kandelo_node_core_official__";
  if (kind === "runtime") return `${prefix}/runtime`;
  return `${prefix}/${kind}/${encodeUrlPath(relPath)}`;
}

function encodeUrlPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
}

async function startViteServer(
  consoleLog: string,
  nodeCoreFiles?: { sourceDir: string; resultsDir: string; runtimePath: string },
): Promise<ChildProcess> {
  const browserDir = join(repoRoot, "apps/browser-demos");
  const port = 5199;
  return new Promise((resolveStart, reject) => {
    const proc = spawn("npx", [
      "vite",
      "--config",
      resolve(browserDir, "vite.config.ts"),
      "--port",
      String(port),
    ], {
      cwd: browserDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        KANDELO_BROWSER_DEMO_INPUTS: "test-runner",
        ...(nodeCoreFiles ? {
          KANDELO_NODE_CORE_OFFICIAL_SOURCE_DIR: nodeCoreFiles.sourceDir,
          KANDELO_NODE_CORE_OFFICIAL_RESULTS_DIR: nodeCoreFiles.resultsDir,
          KANDELO_NODE_CORE_OFFICIAL_RUNTIME_PATH: nodeCoreFiles.runtimePath,
        } : {}),
      },
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error("Vite server did not start within 30s"));
      }
    }, 30_000);

    const onOutput = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString();
      appendText(consoleLog, `[vite:${stream}] ${text}`);
      if (!started && text.includes("Local:")) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolveStart(proc), 500);
      }
    };
    proc.stdout?.on("data", onOutput("stdout"));
    proc.stderr?.on("data", onOutput("stderr"));
    proc.once("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Vite exited before startup with code ${code}`));
      }
    });
  });
}

async function waitForTestRunner(page: Page): Promise<void> {
  await page.goto("http://localhost:5199/pages/test-runner/");
  await page.waitForFunction(
    () => (window as any).__testRunnerReady === true,
    {},
    { timeout: 30_000 },
  );
}

function appendText(path: string, text: string): void {
  writeFileSync(path, text, { flag: "a" });
}

function classify(test: SelectedTest, raw: RawRunResult): Pick<RecordedResult, "status" | "unexpected"> {
  const passed = raw.exitCode === 0 && !raw.timeout && !raw.error;
  if (test.expected === "SKIP") return { status: "SKIP", unexpected: false };
  if (test.expected === "XFAIL" || test.expected === "FAIL") {
    return passed ? { status: "XPASS", unexpected: true } : { status: test.expected, unexpected: false };
  }
  return passed ? { status: "PASS", unexpected: false } : { status: "FAIL", unexpected: true };
}

function recordResult(
  test: SelectedTest,
  host: HostName,
  raw: RawRunResult,
  resultsDir: string,
): RecordedResult {
  const name = safeName(test.spec.path);
  const stdoutRel = `stdout/${name}.log`;
  const stderrRel = `stderr/${name}.log`;
  writeFileSync(join(resultsDir, stdoutRel), raw.stdout);
  writeFileSync(join(resultsDir, stderrRel), raw.stderr);
  const classified = classify(test, raw);
  return {
    path: test.spec.path,
    area: test.spec.area,
    host,
    expectedStatus: test.expected,
    status: classified.status,
    unexpected: classified.unexpected,
    durationMs: raw.durationMs,
    exitCode: raw.exitCode,
    timeout: raw.timeout,
    reason: test.reason,
    stdout: stdoutRel,
    stderr: stderrRel,
    error: raw.error,
  };
}

function skippedResult(test: SelectedTest, host: HostName, resultsDir: string): RecordedResult {
  return recordResult(test, host, {
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timeout: false,
  }, resultsDir);
}

async function runWithConcurrency<T, R>(
  items: T[],
  jobs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  return results;
}

function validateOfficialFiles(sourceDir: string, selected: SelectedTest[]): void {
  const missing = selected
    .filter((test) => test.expected !== "SKIP")
    .map((test) => join(sourceDir, test.spec.path))
    .filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`Missing official test files:\n${missing.map((path) => `  ${path}`).join("\n")}`);
  }
}

function writeUsedManifest(
  manifest: Manifest,
  options: Options,
  selected: SelectedTest[],
  resultsDir: string,
): void {
  const tests = selected.map((test) => ({
    ...test.spec,
    expected: test.expected,
    reason: test.reason,
    timeoutMs: test.timeoutMs,
  }));
  writeFileSync(join(resultsDir, "manifest.used.json"), JSON.stringify({
    source: manifest.source,
    defaults: manifest.defaults,
    selection: {
      mode: options.smoke ? "smoke" : options.selectionMode,
      generatedFrom: options.selectionMode === "full-suite" && !options.smoke
        ? "test/parallel/test-*.js"
        : options.manifestPath,
      selected: tests.length,
      filters: {
        areas: Array.from(options.areas).sort(),
        tests: Array.from(options.tests).sort(),
      },
    },
    tests,
  }, null, 2));
}

function writeSummaries(
  manifest: Manifest,
  options: Options,
  source: { dir: string; commit: string | null },
  runtimePath: string,
  resultsDir: string,
  results: RecordedResult[],
): void {
  const totals = countBy(results, (result) => result.status);
  const byArea: Record<string, Record<string, number>> = {};
  for (const result of results) {
    byArea[result.area] ??= {};
    byArea[result.area][result.status] = (byArea[result.area][result.status] ?? 0) + 1;
  }
  const summary = {
    host: options.host,
    source: {
      ...manifest.source,
      dir: source.dir,
      observedCommit: source.commit,
    },
    runtime: runtimePath,
    resultsDir,
    command: process.argv,
    selection: {
      mode: options.smoke ? "smoke" : options.selectionMode,
      selected: results.length,
    },
    runnerEnvironment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
    },
    guestEnvironment: envForRun().filter((entry) =>
      /^(HOME|PATH|TMPDIR|NODE_SKIP_FLAG_CHECK|NODE_DISABLE_COLORS|NODE_TEST_KNOWN_GLOBALS|TERM|CI)=/.test(entry)
    ),
    totals,
    byArea,
    unexpected: results.filter((result) => result.unexpected).length,
    results,
  };
  writeFileSync(join(resultsDir, "summary.json"), JSON.stringify(summary, null, 2));

  const lines = [
    "Official Node.js core JS module summary",
    `host=${options.host}`,
    `source_tag=${manifest.source.tag}`,
    `source_commit=${manifest.source.commit}`,
    `source_dir=${source.dir}`,
    `runtime=${runtimePath}`,
    `results_dir=${resultsDir}`,
    `mode=${options.smoke ? "smoke" : options.selectionMode}`,
    `selected=${results.length}`,
    `command=${process.argv.map((arg) => JSON.stringify(arg)).join(" ")}`,
    `runner_node=${process.version}`,
    `runner_platform=${process.platform}/${process.arch}`,
    "",
    "Totals:",
    ...Object.entries(totals).sort().map(([status, count]) => `  ${status}: ${count}`),
    "",
    "By area:",
    ...Object.entries(byArea).sort().map(([area, counts]) =>
      `  ${area}: ${Object.entries(counts).sort().map(([status, count]) => `${status}=${count}`).join(" ")}`
    ),
    "",
    "Unexpected results:",
    ...results.filter((result) => result.unexpected).map((result) =>
      `  ${result.status} ${result.path} expected=${result.expectedStatus}${result.error ? ` error=${result.error}` : ""}`
    ),
  ];
  writeFileSync(join(resultsDir, "summary.txt"), `${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(options.manifestPath);
  const sourceDir = sourceDirFor(manifest, options);
  const fullSuite = options.selectionMode === "full-suite" && !options.smoke;
  let source: { dir: string; commit: string | null } | null = null;
  if (fullSuite) {
    source = ensureSource(manifest, options);
  }
  const selected = fullSuite
    ? selectFullSuiteTests(manifest, source!.dir, options)
    : selectManifestTests(manifest, options);

  if (selected.length === 0) {
    throw new Error("No manifest entries matched the requested selection");
  }

  if (options.list) {
    for (const test of selected) console.log(test.spec.path);
    return;
  }

  if (options.explain) {
    explain(manifest, options, selected, sourceDir);
    return;
  }

  source ??= ensureSource(manifest, options);
  validateOfficialFiles(source.dir, selected);
  const resultsDir = makeResultsDir(options);
  mkdirSync(join(resultsDir, "stdout"), { recursive: true });
  mkdirSync(join(resultsDir, "stderr"), { recursive: true });
  writeUsedManifest(manifest, options, selected, resultsDir);

  const runnable = selected.filter((test) => test.expected !== "SKIP");
  const skipped = selected.filter((test) => test.expected === "SKIP");
  const recorded: RecordedResult[] = skipped.map((test) => skippedResult(test, options.host, resultsDir));
  const isolatedRunnable = createIsolatedTests(runnable, resultsDir);
  let runtimePath = "(not resolved: all selected tests skipped)";

  if (runnable.length === 0) {
    // No runtime binary is required to verify explicit support-boundary skips.
  } else if (options.host === "node") {
    runtimePath = await resolveRuntime(options.runtimePath);
    const preludePath = writePrelude(resultsDir);
    const jobs = options.jobs ?? manifest.defaults?.jobs ?? 1;
    const shellRuntimePath = await resolveShellRuntime();
    const programBytes = loadBytes(runtimePath);
    const nodeResults = await runWithConcurrency(isolatedRunnable, jobs, async (isolated) => {
      const raw = await runNodeTest(isolated, source.dir, preludePath, runtimePath, programBytes, shellRuntimePath);
      return recordResult(isolated.test, options.host, raw, resultsDir);
    });
    recorded.push(...nodeResults);
  } else {
    runtimePath = await resolveRuntime(options.runtimePath);
    const preludePath = writePrelude(resultsDir);
    const jobs = options.jobs ?? manifest.defaults?.jobs ?? 1;
    const browserResults = await runBrowserTests(isolatedRunnable, source.dir, preludePath, runtimePath, resultsDir, jobs);
    for (const test of runnable) {
      const raw = browserResults.get(test.spec.path) ?? {
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timeout: false,
        error: "browser runner did not return a result",
      };
      recorded.push(recordResult(test, options.host, raw, resultsDir));
    }
  }

  const ndjson = recorded.map((result) => JSON.stringify(result)).join("\n");
  writeFileSync(join(resultsDir, "results.ndjson"), `${ndjson}\n`);
  writeSummaries(manifest, options, source, runtimePath, resultsDir, recorded);
  console.log(`Results: ${resultsDir}`);
  console.log(readFileSync(join(resultsDir, "summary.txt"), "utf8"));

  if (recorded.some((result) => result.unexpected)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}
