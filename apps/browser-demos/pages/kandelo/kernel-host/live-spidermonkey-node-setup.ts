import { BrowserKernel } from "@host/browser-kernel-host";
import { ensureServiceWorkerReady } from "../../../lib/init/service-worker-bridge";
import { rewriteShellLazyFileUrls } from "../../../lib/init/shell-lazy-files";
import {
  COREUTILS_NAMES,
} from "../../../lib/init/shell-binaries";
import {
  NODE_LAZY_BINARY_SPEC,
  shellLazyPlaceholderUrl,
} from "../../../../../images/vfs/lib/init/shell-binaries";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../../../host/src/vfs/image-helpers";
import {
  LiveKernelHost,
  type BootDescriptor,
  type DemoPresentation,
  type GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type {
  DemoGuideConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import { PRESET_LIBRARY } from "../presets";

import kernelWasmUrl from "@kernel-wasm?url";
import nodeVfsUrl from "@binaries/programs/wasm32/node-vfs.vfs.zst?url";
import dashWasmUrl from "@binaries/programs/wasm32/dash.wasm?url";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
import coreutilsWasmUrl from "@binaries/programs/wasm32/coreutils.wasm?url";
import spiderMonkeyNodeWasmUrl from "@binaries/programs/wasm32/spidermonkey-node.wasm?url";

const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const COI_RELOAD_SESSION_KEY = "kandelo:sm-node-coi-reload-attempted";
// npm's full dependency resolver can exceed 256 MB on large packuments.
// Keep this demo on the BrowserKernel default instead of the lighter shell cap.
const SPIDERMONKEY_NODE_MEMORY_PAGES = 16384;

const SHELL_ENV = [
  "HOME=/work",
  "PWD=/work",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "PS1=spidermonkey-node$ ",
  "HISTFILE=/work/.bash_history",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
  "npm_config_cache=/tmp/.npm-cache",
  "npm_config_registry=http://proxy.local/",
  "npm_config_fund=false",
  "npm_config_audit=false",
  "npm_config_progress=false",
  "npm_config_update_notifier=false",
  "NPM_CONFIG_FUND=false",
  "NPM_CONFIG_AUDIT=false",
  "NPM_CONFIG_PROGRESS=false",
  "NPM_CONFIG_UPDATE_NOTIFIER=false",
];

const SPIDERMONKEY_NODE_PRESENTATION: DemoPresentation = {
  bootPrimary: "syslog",
  runningPrimary: ["terminal", "syslog"],
  terminalAccess: "primary",
  internalsAccess: "drawer",
};

const SM_NODE_COMMAND = [
  "node -e \"",
  "const assert=require('node:assert');",
  "const path=require('path');",
  "const {Worker}=require('worker_threads');",
  "const b=Buffer.from('Kandelo');",
  "assert.strictEqual(path.basename('/usr/bin/node'),'node');",
  "console.log('SpiderMonkey Node', process.version, process.arch);",
  "console.log(b.toString('hex'));",
  "console.log(new Intl.NumberFormat('de-DE').format(1234567.89));",
  "const sab=new SharedArrayBuffer(4);",
  "const view=new Int32Array(sab);",
  "new Worker('const view=new Int32Array(workerData); Atomics.store(view,0,42); Atomics.notify(view,0);',{eval:true,workerData:sab});",
  "Atomics.wait(view,0,0,5000);",
  "console.log('worker', Atomics.load(view,0));",
  "\"",
  "; npm --version",
].join(" ");

const SM_NODE_RUNTIME_DEMO_COMMAND = [
  "node -e \"",
  "const {Worker}=require('worker_threads');",
  "console.log('node', process.version, process.arch);",
  "console.log('intl', new Intl.NumberFormat('de-DE').format(1234567.89));",
  "const sab=new SharedArrayBuffer(4);",
  "const view=new Int32Array(sab);",
  "new Worker('const view=new Int32Array(workerData); Atomics.store(view,0,7); Atomics.notify(view,0);',{eval:true,workerData:sab});",
  "Atomics.wait(view,0,0,5000);",
  "console.log('worker', Atomics.load(view,0));",
  "\"",
].join(" ");

const SM_NODE_COWSAY_DEMO_COMMAND = [
  "rm -rf node_modules package-lock.json /tmp/.npm-cache",
  "printf '%s\\n' '{\"name\":\"demo\",\"version\":\"0.0.1\"}' > package.json",
  "npm install cowsay",
  "./node_modules/.bin/cowsay Kandelo",
].join(" && ");

const SPIDERMONKEY_NODE_GUIDE: DemoGuideConfig = {
  title: "SpiderMonkey Node.js demo",
  summary: "Run Node-compatible commands against the SpiderMonkey-backed runtime, including npm packages, Intl, and worker_threads shared memory.",
  groups: [
    {
      title: "Commands",
      actions: [
        {
          id: "runtime-check",
          label: "Runtime check",
          description: "Exercise process metadata, Intl formatting, and a shared-memory worker.",
          kind: "terminal.run",
          payload: SM_NODE_RUNTIME_DEMO_COMMAND,
        },
        {
          id: "install-cowsay",
          label: "Install cowsay",
          description: "Install cowsay with npm and run its package bin.",
          kind: "terminal.run",
          payload: SM_NODE_COWSAY_DEMO_COMMAND,
        },
      ],
    },
    {
      title: "REPL",
      actions: [
        {
          id: "enter-repl",
          label: "Open REPL",
          description: "Start an interactive Node-compatible REPL.",
          kind: "terminal.run",
          payload: "node",
        },
        {
          id: "repl-expression",
          label: "Send expr",
          description: "Send an expression to the current terminal.",
          kind: "terminal.write",
          payload: "process.versions\n",
        },
      ],
    },
  ],
  script: {
    title: "SpiderMonkey Node script",
    language: "sh",
    initialText: `${SM_NODE_RUNTIME_DEMO_COMMAND}\n${SM_NODE_COWSAY_DEMO_COMMAND}`,
  },
  companion: {
    title: "Companion HTML",
    srcDoc: `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 12px; background: #191512; color: #f3d6b3; font: 12px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h1 { margin: 0 0 8px; font-size: 12px; font-weight: 650; letter-spacing: 0; color: #fff2df; }
    p { margin: 0 0 10px; color: #b99d7d; line-height: 1.4; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; }
    button { border: 1px solid rgba(255, 169, 86, 0.28); background: rgba(255, 169, 86, 0.12); color: #ffe0b9; border-radius: 6px; padding: 7px 9px; font: inherit; cursor: pointer; }
    button:hover { background: rgba(255, 169, 86, 0.2); }
    #status { min-height: 16px; margin-top: 10px; color: #d2b08b; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  </style>
</head>
<body>
  <h1>SpiderMonkey Node companion</h1>
  <p>This frame has no kernel access. It can only request parent-approved action ids.</p>
  <div class="row">
    <button type="button" data-action="runtime-check">Runtime</button>
    <button type="button" data-action="install-cowsay">cowsay</button>
    <button type="button" data-action="repl-expression">REPL input</button>
  </div>
  <div id="status"></div>
  <script>
    const status = document.getElementById("status");
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const actionId = button.getAttribute("data-action");
      parent.postMessage({ type: "kandelo.demoAction", actionId }, "*");
      status.textContent = "sent " + actionId;
    });
  </script>
</body>
</html>`,
  },
};

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
let spins = 0;
while (!settled && typeof drainJobQueue === 'function') {
  drainJobQueue();
  if (++spins > 100000) {
    failure = new Error('npm did not settle after draining the SpiderMonkey job queue');
    settled = true;
  }
}
if (failure) {
  console.error(failure && failure.stack ? failure.stack : failure);
  process.exitCode = process.exitCode || 1;
}
if (typeof drainJobQueue === 'function') drainJobQueue();
process.exit(process.exitCode || 0);
`;

const NPM_LAUNCHER = `#!/usr/bin/node
process.argv.splice(2, 0, 'npm');
require('/usr/local/lib/kandelo/npm-runner.js');
`;

const NPX_LAUNCHER = `#!/usr/bin/node
process.argv.splice(2, 0, 'npx');
require('/usr/local/lib/kandelo/npm-runner.js');
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

type SpiderMonkeyNodeDemoId = "node" | "spidermonkey-node";

export async function createLiveSpiderMonkeyNodeHost(
  requestedDemo?: string | null,
): Promise<LiveKernelHost> {
  const initialDemo = normalizeSpiderMonkeyNodeDemoId(requestedDemo) ?? "node";
  const descriptor = descriptorForSpiderMonkeyNode(initialDemo);
  const host = new LiveKernelHost({
    status: "booting",
    descriptor,
    galleryItems: galleryItems(),
    applyBootDescriptor: async (desc) => {
      const nextDemo = normalizeSpiderMonkeyNodeDemoId(desc.id);
      if (!nextDemo) {
        const url = new URL(window.location.href);
        url.searchParams.set("demo", desc.id);
        window.location.href = url.href;
        return;
      }
      await boot(host, descriptorForSpiderMonkeyNode(nextDemo));
    },
  });

  void boot(host, descriptor);
  return host;
}

async function boot(host: LiveKernelHost, descriptor: BootDescriptor): Promise<void> {
  host.clearDmesg();
  host.setDescriptor(descriptor);
  host.setStatus("booting");

  let t = 0;
  const tick = (msg: string) => {
    host.pushDmesg({ t: (t += 50), level: "info", facility: "kandelo", msg });
  };

  try {
    tick("preparing service worker...");
    await ensureServiceWorkerReady(SW_URL);
    if (!window.crossOriginIsolated) {
      if (sessionStorage.getItem(COI_RELOAD_SESSION_KEY) === "1") {
        throw new Error("cross-origin isolation was not enabled after service worker activation");
      }
      sessionStorage.setItem(COI_RELOAD_SESSION_KEY, "1");
      tick("service worker active; reloading to enable cross-origin isolation...");
      window.location.reload();
      return;
    }
    sessionStorage.removeItem(COI_RELOAD_SESSION_KEY);

    tick("loading SpiderMonkey Node profile...");
    const [
      kernelBytes,
      vfsBytes,
      bashBytes,
      dashBytes,
      coreutilsBytes,
      nodeBytes,
    ] = await Promise.all([
      loadBytes(kernelWasmUrl, "kernel.wasm"),
      loadBytes(nodeVfsUrl, "node-vfs.vfs.zst"),
      loadBytes(bashWasmUrl, "bash.wasm"),
      loadBytes(dashWasmUrl, "dash.wasm"),
      loadBytes(coreutilsWasmUrl, "coreutils.wasm"),
      loadBytes(spiderMonkeyNodeWasmUrl, "spidermonkey-node.wasm"),
    ]);

    tick("instantiating kernel...");
    const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsBytes), {
      maxByteLength: 256 * 1024 * 1024,
    });
    rewriteShellLazyFileUrls(memfs);
    rewriteNodeLazyFileUrl(memfs);
    stageRuntime(memfs, bashBytes, dashBytes, coreutilsBytes, nodeBytes);

    const kernel = new BrowserKernel({
      memfs,
      maxWorkers: 4,
      maxMemoryPages: SPIDERMONKEY_NODE_MEMORY_PAGES,
      onStdout: (data) => tick(new TextDecoder().decode(data).trimEnd() || "stdout"),
      onStderr: (data) => tick(new TextDecoder().decode(data).trimEnd() || "stderr"),
      onProcessEvent: (event) => host.emitProcessEvent(event),
    });
    await kernel.init(kernelBytes);

    host.attachKernel(kernel);
    host.setPresentation(SPIDERMONKEY_NODE_PRESENTATION);
    host.setDemoGuide(SPIDERMONKEY_NODE_GUIDE);
    host.setDefaultShell({
      programBytes: bashBytes,
      argv: ["bash", "-l", "-i"],
      env: SHELL_ENV,
      cwd: "/work",
    });
    host.setStatus("running");

    tick("running SpiderMonkey Node smoke...");
    void host.runShellCommand(SM_NODE_COMMAND).catch((err) => {
      tick(`command failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    tick("ready");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    host.pushDmesg({ t: (t += 50), level: "err", facility: "kandelo", msg: message });
    host.setStatus("error");
  }
}

function rewriteNodeLazyFileUrl(fs: MemoryFileSystem): void {
  const placeholder = shellLazyPlaceholderUrl(NODE_LAZY_BINARY_SPEC);
  fs.rewriteLazyFileUrls((url) => {
    if (url !== placeholder) return url;
    return spiderMonkeyNodeWasmUrl;
  });
}

function stageRuntime(
  fs: MemoryFileSystem,
  bashBytes: ArrayBuffer,
  dashBytes: ArrayBuffer,
  coreutilsBytes: ArrayBuffer,
  nodeBytes: ArrayBuffer,
): void {
  ensureDirRecursive(fs, "/home");
  ensureDirRecursive(fs, "/work");
  ensureDirRecursive(fs, "/bin");
  ensureDirRecursive(fs, "/usr/bin");
  ensureDirRecursive(fs, "/usr/local/bin");
  writeVfsBinary(fs, "/bin/bash", new Uint8Array(bashBytes), 0o755);
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes), 0o755);
  writeVfsBinary(fs, "/bin/coreutils", new Uint8Array(coreutilsBytes), 0o755);
  writeVfsBinary(fs, "/usr/bin/node", new Uint8Array(nodeBytes), 0o755);
  ensureDirRecursive(fs, "/usr/local/lib/kandelo");
  writeVfsFile(fs, "/usr/local/lib/kandelo/npm-runner.js", NPM_RUNNER, 0o644);
  writeVfsFile(fs, "/usr/local/lib/kandelo/npm-display-shim.js", NPM_DISPLAY_SHIM, 0o644);
  writeVfsFile(fs, "/usr/local/lib/kandelo/is-cidr-shim.js", NPM_IS_CIDR_SHIM, 0o644);
  patchNpmForSpiderMonkey(fs);
  writeVfsFile(
    fs,
    "/usr/bin/npm",
    NPM_LAUNCHER,
    0o755,
  );
  writeVfsFile(
    fs,
    "/usr/bin/npx",
    NPX_LAUNCHER,
    0o755,
  );
  symlink(fs, "/bin/bash", "/usr/bin/bash");
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/usr/bin/node", "/bin/node");
  symlink(fs, "/usr/bin/node", "/usr/local/bin/node");
  symlink(fs, "/usr/bin/node", "/usr/bin/spidermonkey-node");
  symlink(fs, "/usr/bin/npm", "/bin/npm");
  symlink(fs, "/usr/bin/npm", "/usr/local/bin/npm");
  symlink(fs, "/usr/bin/npx", "/bin/npx");
  symlink(fs, "/usr/bin/npx", "/usr/local/bin/npx");
  for (const name of [...COREUTILS_NAMES, "["]) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }
}

function patchNpmForSpiderMonkey(fs: MemoryFileSystem): void {
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

function symlink(fs: MemoryFileSystem, target: string, path: string): void {
  try { fs.symlink(target, path); } catch { /* exists */ }
}

async function loadBytes(url: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed for ${label}: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

function normalizeSpiderMonkeyNodeDemoId(id: string | null | undefined): SpiderMonkeyNodeDemoId | null {
  if (!id || id === "node") return "node";
  if (id === "spidermonkey-node" || id === "spidermonkey") return "spidermonkey-node";
  return null;
}

function descriptorForSpiderMonkeyNode(id: SpiderMonkeyNodeDemoId): BootDescriptor {
  const item = PRESET_LIBRARY.find((p) => p.id === id)
    ?? PRESET_LIBRARY.find((p) => p.id === "node")!;
  return {
    version: 1,
    id: item.id,
    title: item.title,
    base: item.base,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: SPIDERMONKEY_NODE_MEMORY_PAGES,
      features: ["shared-array-buffer", "pty", "js-workers"],
      time: "real",
    },
    packages: item.packages,
    mounts: [
      { path: "/", source: "image", ref: "node-vfs.vfs@local", readonly: false },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: item.bootCommand,
      cwd: "/work",
      env: Object.fromEntries(SHELL_ENV.map((kv) => {
        const idx = kv.indexOf("=");
        return [kv.slice(0, idx), kv.slice(idx + 1)];
      })),
    },
    caps: { network: true },
  };
}

function galleryItems(): GalleryItem[] {
  return PRESET_LIBRARY.map((p) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    base: p.base,
    packages: p.packages,
    bootCommand: p.bootCommand,
    accent: p.accent,
    glyph: p.glyph,
    estimatedUrlBytes: p.estimatedUrlBytes,
  }));
}
