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
  process.argv[1] = '/usr/local/lib/npm/bin/npm-cli.js';
  process.argv.splice(2, 0, 'exec');
}
const run = require('/usr/local/lib/npm/lib/cli.js');
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
      `const { Chalk, createSupportsColor } = require('/usr/local/lib/kandelo/npm-display-shim.js')`,
      "import('chalk')",
    ],
  ]);
  patchHostText(join(npmDir, "lib/commands/token.js"), [
    [
      `const { v4: isCidrV4, v6: isCidrV6 } = await import('is-cidr')`,
      `const { v4: isCidrV4, v6: isCidrV6 } = require('/usr/local/lib/kandelo/is-cidr-shim.js')`,
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

async function runNode(source: string, timeout = DEFAULT_TIMEOUT) {
  const label =
    expect.getState().currentTestName ?? "spidermonkey node program";
  return withCiProgress(
    label,
    runCentralizedProgram({
      programPath: nodeWasm!,
      programModule: nodeModule,
      argv: ["node", "-e", source],
      timeout,
    }),
  );
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
        "console.log(util.format('%s:%d', path.basename('/usr/bin/node'), b.length))",
      ].join(";"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("node:5");
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
          { mountPoint: "/usr/local/lib/npm", hostPath: npmDir, readonly: true },
          { mountPoint: "/usr/local/lib/kandelo", hostPath: helperDir, readonly: true },
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
              "/usr/local/lib/kandelo/npm-runner.js",
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
        expect(ptyOutput).toMatch(/added \d+ packages? in /);
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
});
