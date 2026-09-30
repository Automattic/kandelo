import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  symlink,
  writeVfsFile,
} from "../../../../host/src/vfs/image-helpers";

export const NPM_RUNNER = `const invoked = process.argv[2] || 'npm';
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

export const NPM_LAUNCHER = `#!/usr/bin/node
process.argv.splice(2, 0, 'npm');
require('/usr/local/lib/kandelo/npm-runner.js');
`;

export const NPX_LAUNCHER = `#!/usr/bin/node
process.argv.splice(2, 0, 'npx');
require('/usr/local/lib/kandelo/npm-runner.js');
`;

export const NPM_DISPLAY_SHIM = `function plain(...args) {
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

export const NPM_IS_CIDR_SHIM = `function isCidrV4(value) {
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

export function stageSpiderMonkeyNpmRuntime(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/bin");
  ensureDirRecursive(fs, "/usr/bin");
  ensureDirRecursive(fs, "/usr/local/bin");
  ensureDirRecursive(fs, "/usr/local/lib/kandelo");

  writeVfsFile(fs, "/usr/local/lib/kandelo/npm-runner.js", NPM_RUNNER, 0o644);
  writeVfsFile(fs, "/usr/local/lib/kandelo/npm-display-shim.js", NPM_DISPLAY_SHIM, 0o644);
  writeVfsFile(fs, "/usr/local/lib/kandelo/is-cidr-shim.js", NPM_IS_CIDR_SHIM, 0o644);
  patchNpmForSpiderMonkey(fs);

  writeVfsFile(fs, "/usr/bin/npm", NPM_LAUNCHER, 0o755);
  writeVfsFile(fs, "/usr/bin/npx", NPX_LAUNCHER, 0o755);
  symlink(fs, "/usr/bin/npm", "/bin/npm");
  symlink(fs, "/usr/bin/npm", "/usr/local/bin/npm");
  symlink(fs, "/usr/bin/npx", "/bin/npx");
  symlink(fs, "/usr/bin/npx", "/usr/local/bin/npx");
}

export function patchNpmForSpiderMonkey(fs: MemoryFileSystem): void {
  patchVfsText(fs, "/usr/local/lib/npm/lib/utils/display.js", [
    [
      `const [{ Chalk }, { createSupportsColor }] = await Promise.all([
      import('chalk'),
      import('supports-color'),
    ])`,
      `const { Chalk, createSupportsColor } = require('/usr/local/lib/kandelo/npm-display-shim.js')`,
      "import('chalk')",
    ],
  ]);
  patchVfsText(fs, "/usr/local/lib/npm/lib/commands/token.js", [
    [
      `const { v4: isCidrV4, v6: isCidrV6 } = await import('is-cidr')`,
      `const { v4: isCidrV4, v6: isCidrV6 } = require('/usr/local/lib/kandelo/is-cidr-shim.js')`,
      "import('is-cidr')",
    ],
  ]);
  for (const path of [
    "/usr/local/lib/npm/node_modules/cacache/lib/entry-index.js",
    "/usr/local/lib/npm/node_modules/cacache/lib/verify.js",
  ]) {
    patchVfsText(fs, path, [
      [
        `const { default: pMap } = await import('p-map')`,
        `const pMap = require('p-map')`,
        "import('p-map')",
      ],
    ]);
  }
}

function patchVfsText(
  fs: MemoryFileSystem,
  path: string,
  replacements: Array<[from: string, to: string, probe: string]>,
): void {
  let source = readVfsText(fs, path);
  let changed = false;
  for (const [from, to, probe] of replacements) {
    if (source.includes(from)) {
      source = source.replace(from, to);
      changed = true;
    } else if (source.includes(probe)) {
      throw new Error(`npm compatibility patch did not match expected source in ${path}`);
    }
  }
  if (changed) writeVfsFile(fs, path, source, 0o644);
}

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const buffer = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const n = fs.read(fd, buffer.subarray(offset), null, buffer.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return new TextDecoder().decode(buffer.subarray(0, offset));
  } finally {
    fs.close(fd);
  }
}
