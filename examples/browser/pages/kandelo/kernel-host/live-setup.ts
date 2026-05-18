// Builds a LiveKernelHost over a real BrowserKernel. Used by default when the
// kandelo page is loaded (use `?mock=1` for MockKernelHost).

import { BrowserKernel } from "../../../lib/browser-kernel";
import { initServiceWorkerBridge } from "../../../lib/init/service-worker-bridge";
import { HttpBridgeHost } from "../../../lib/http-bridge";
import {
  COREUTILS_NAMES,
  populateShellBinaries,
  type BinaryDef,
} from "../../../lib/init/shell-binaries";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../../../host/src/vfs/image-helpers";
import {
  LiveKernelHost,
  type BootDescriptor,
  type DemoPresentation,
  type GalleryItem,
} from "../../../../../host/src/kandelo-ui/kernel-host";
import { PRESET_LIBRARY } from "../fixtures";

import kernelWasmUrl from "@kernel-wasm?url";
import shellVfsUrl from "@binaries/programs/wasm32/shell.vfs.zst?url";
import nodeVfsUrl from "@binaries/programs/wasm32/node-vfs.vfs.zst?url";
import nginxVfsUrl from "@binaries/programs/wasm32/nginx-vfs.vfs.zst?url";
import nginxPhpVfsUrl from "@binaries/programs/wasm32/nginx-php-vfs.vfs.zst?url";
import wordpressVfsUrl from "@binaries/programs/wasm32/wordpress.vfs.zst?url";
import lampVfsUrl from "@binaries/programs/wasm32/lamp.vfs.zst?url";
import nodeWasmUrl from "@binaries/programs/wasm32/node.wasm?url";
import dashWasmUrl from "@binaries/programs/wasm32/dash.wasm?url";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
import coreutilsWasmUrl from "@binaries/programs/wasm32/coreutils.wasm?url";
import grepWasmUrl from "@binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "@binaries/programs/wasm32/sed.wasm?url";
import bcWasmUrl from "@binaries/programs/wasm32/bc.wasm?url";
import fileWasmUrl from "@binaries/programs/wasm32/file/file.wasm?url";
import lessWasmUrl from "@binaries/programs/wasm32/less.wasm?url";
import m4WasmUrl from "@binaries/programs/wasm32/m4.wasm?url";
import makeWasmUrl from "@binaries/programs/wasm32/make.wasm?url";
import tarWasmUrl from "@binaries/programs/wasm32/tar.wasm?url";
import curlWasmUrl from "@binaries/programs/wasm32/curl.wasm?url";
import wgetWasmUrl from "@binaries/programs/wasm32/wget.wasm?url";
import gitWasmUrl from "@binaries/programs/wasm32/git/git.wasm?url";
import gitRemoteHttpWasmUrl from "@binaries/programs/wasm32/git/git-remote-http.wasm?url";
import gzipWasmUrl from "@binaries/programs/wasm32/gzip.wasm?url";
import bzip2WasmUrl from "@binaries/programs/wasm32/bzip2.wasm?url";
import xzWasmUrl from "@binaries/programs/wasm32/xz.wasm?url";
import zstdWasmUrl from "@binaries/programs/wasm32/zstd.wasm?url";
import zipWasmUrl from "@binaries/programs/wasm32/zip.wasm?url";
import unzipWasmUrl from "@binaries/programs/wasm32/unzip.wasm?url";
import nanoWasmUrl from "@binaries/programs/wasm32/nano.wasm?url";
import lsofWasmUrl from "@binaries/programs/wasm32/lsof.wasm?url";
import fbtestWasmUrl from "@binaries/programs/wasm32/fbtest.wasm?url";
import fbdoomWasmUrl from "@binaries/programs/wasm32/fbdoom.wasm?url";

type LiveDemoId =
  | "shell"
  | "node"
  | "nginx"
  | "nginx-php"
  | "wordpress-sqlite"
  | "wordpress-mariadb"
  | "doom";

interface LiveProfile {
  id: LiveDemoId;
  vfsUrl: string;
  descriptor: BootDescriptor;
  presentation: DemoPresentation;
  init?: {
    argv: string[];
    env?: string[];
    cwd?: string;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: { label: string; requiredPorts: number[] };
  };
  framebuffer?: "doom" | "test";
}

interface WebReadinessState {
  ready: boolean;
  probing: boolean;
}

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const HTTP_PORT = 8080;
const DOOM_WAD_URL = "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";

const SHELL_ENV: string[] = [
  "HOME=/home",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "PS1=kandelo$ ",
  "HISTFILE=/home/.bash_history",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

const NODE_SHELL_ENV: string[] = [
  "HOME=/work",
  "PWD=/work",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "PS1=node$ ",
  "HISTFILE=/work/.bash_history",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
  "npm_config_cache=/tmp/.npm-cache",
  "npm_config_registry=http://proxy.local/",
  "npm_config_fund=false",
  "npm_config_audit=false",
  "npm_config_progress=false",
];

const SERVICE_ENV: string[] = [
  "HOME=/root",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

const DOOM_COMMAND = "/usr/local/bin/fbdoom -iwad /doom1.wad";

export type FbDemo = "none" | "test" | "doom";

export interface CreateLiveHostOptions {
  demo?: string | null;
  fb?: FbDemo;
}

export async function createLiveHost(opts: CreateLiveHostOptions = {}): Promise<LiveKernelHost> {
  let currentKernel: BrowserKernel | null = null;
  let bootSeq = 0;

  const host = new LiveKernelHost({
    status: "booting",
    descriptor: descriptorFor("shell"),
    galleryItems: liveGalleryItems(),
    applyBootDescriptor: async (desc, h) => {
      const seq = ++bootSeq;
      if (currentKernel) {
        await currentKernel.destroy().catch(() => {});
        currentKernel = null;
      }
      currentKernel = await bootProfile(h, profileFor(desc.id, "none"), desc, seq);
    },
  });

  const initialId = normalizeDemoId(opts.demo) ?? (opts.fb === "doom" ? "doom" : "shell");
  currentKernel = await bootProfile(host, profileFor(initialId, opts.fb), descriptorFor(initialId), ++bootSeq);
  return host;
}

function profileFor(id: string, fb?: FbDemo): LiveProfile {
  const normalized = normalizeDemoId(id) ?? "shell";
  const desc = descriptorFor(normalized);
  const presentation = presentationFor(normalized);
  const dinit = ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"];
  switch (normalized) {
    case "node":
      return {
        id: "node",
        vfsUrl: nodeVfsUrl,
        descriptor: desc,
        presentation,
      };
    case "nginx":
      return {
        id: "nginx",
        vfsUrl: nginxVfsUrl,
        descriptor: desc,
        presentation,
        init: {
          argv: dinit,
          env: SERVICE_ENV,
          maxWorkers: 6,
          web: { label: "nginx", requiredPorts: [HTTP_PORT] },
        },
      };
    case "nginx-php":
      return {
        id: "nginx-php",
        vfsUrl: nginxPhpVfsUrl,
        descriptor: desc,
        presentation,
        init: {
          argv: dinit,
          env: SERVICE_ENV,
          maxWorkers: 8,
          web: { label: "nginx + PHP", requiredPorts: [HTTP_PORT] },
        },
      };
    case "wordpress-sqlite":
      return {
        id: "wordpress-sqlite",
        vfsUrl: wordpressVfsUrl,
        descriptor: desc,
        presentation,
        init: {
          argv: dinit,
          env: [...SERVICE_ENV, `WP_APP_PATH=${APP_PATH}`, `WP_PROTO=${PROTO}`],
          maxWorkers: 8,
          maxMemoryPages: 4096,
          web: { label: "WordPress SQLite", requiredPorts: [HTTP_PORT] },
        },
      };
    case "wordpress-mariadb":
      return {
        id: "wordpress-mariadb",
        vfsUrl: lampVfsUrl,
        descriptor: desc,
        presentation,
        init: {
          argv: dinit,
          env: [...SERVICE_ENV, `WP_APP_PATH=${APP_PATH}`, `WP_PROTO=${PROTO}`],
          maxWorkers: 10,
          maxMemoryPages: 4096,
          web: { label: "WordPress MariaDB", requiredPorts: [HTTP_PORT, 3306] },
        },
      };
    case "doom":
      return { id: "doom", vfsUrl: shellVfsUrl, descriptor: desc, presentation, framebuffer: "doom" };
    case "shell":
    default:
      return {
        id: "shell",
        vfsUrl: shellVfsUrl,
        descriptor: desc,
        presentation,
        framebuffer: fb === "test" ? "test" : undefined,
      };
  }
}

async function bootProfile(
  host: LiveKernelHost,
  profile: LiveProfile,
  requestedDescriptor: BootDescriptor,
  seq: number,
): Promise<BrowserKernel> {
  host.clearDmesg();
  host.setWebPreview(null);
  host.setDescriptor({
    ...profile.descriptor,
    title: requestedDescriptor.title || profile.descriptor.title,
    packages: requestedDescriptor.packages.length > 0
      ? requestedDescriptor.packages
      : profile.descriptor.packages,
  });
  host.setPresentation(profile.presentation);
  host.setStatus("booting");

  let t = 0;
  const tick = (msg: string) => {
    host.pushDmesg({ t: (t += 50), level: "info", facility: "kandelo", msg });
  };

  tick(`loading ${profile.id} profile...`);
  const [kernelBytes, vfsBytes, bashBytes, dashBytes, lazyBinaries] = await Promise.all([
    fetch(kernelWasmUrl).then(failOn("kernel.wasm")).then((r) => r.arrayBuffer()),
    fetch(profile.vfsUrl).then(failOn(`${profile.id}.vfs.zst`)).then((r) => r.arrayBuffer()),
    fetch(bashWasmUrl).then(failOn("bash.wasm")).then((r) => r.arrayBuffer()),
    fetch(dashWasmUrl).then(failOn("dash.wasm")).then((r) => r.arrayBuffer()),
    loadShellUtilityDefs(profile.id === "node"),
  ]);

  tick(`kernel: ${kib(kernelBytes.byteLength)} · vfs: ${kib(vfsBytes.byteLength)}`);
  const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsBytes), {
    maxByteLength: profile.id === "wordpress-mariadb" ? 512 * 1024 * 1024 : 256 * 1024 * 1024,
  });
  memfs.rewriteLazyArchiveUrls((url) => import.meta.env.BASE_URL + url);

  tick("instantiating kernel...");
  const seenPorts = new Set<number>();
  let bridgeSent = false;
  const webReadiness: WebReadinessState = { ready: false, probing: false };
  const kernel = new BrowserKernel({
    memfs,
    maxWorkers: profile.init?.maxWorkers ?? 4,
    maxMemoryPages: profile.init?.maxMemoryPages,
    onStdout: (data) => tick(new TextDecoder().decode(data).trimEnd() || "stdout"),
    onStderr: (data) => tick(new TextDecoder().decode(data).trimEnd() || "stderr"),
    onProcessEvent: (event) => host.emitProcessEvent(event),
    onListenTcp: (_pid, _fd, port) => {
      seenPorts.add(port);
      tick(`service listening on :${port}`);
      maybeMarkWebReady(host, profile, seenPorts, bridgeSent, webReadiness, tick);
    },
  });
  await kernel.init(kernelBytes);

  tick("staging shell utilities...");
  stageShellUtilities(kernel, dashBytes, bashBytes, lazyBinaries);
  await registerFbPrograms(kernel);
  host.attachKernel(kernel);
  const shellEnv = profile.id === "node" ? NODE_SHELL_ENV : SHELL_ENV;
  host.setDefaultShell({
    programBytes: bashBytes,
    argv: ["bash", "-l", "-i"],
    env: shellEnv,
    cwd: profile.id === "node" ? "/work" : "/home",
  });

  if (profile.init?.web) {
    tick("initializing HTTP bridge...");
    host.setWebPreview({
      label: profile.init.web.label,
      url: APP_PREFIX,
      status: "starting",
      message: "Waiting for service ports",
    });
    const swBridge = await initServiceWorkerBridge(SW_URL, APP_PREFIX);
    if (!swBridge) {
      host.setWebPreview({
        label: profile.init.web.label,
        url: APP_PREFIX,
        status: "error",
        message: "Service workers unavailable",
      });
    } else {
      kernel.sendBridgePort(swBridge.detachHostPort(), HTTP_PORT);
      bridgeSent = true;
      setupBridgeRestoreListener(kernel, HTTP_PORT, tick);
    }
  }

  if (profile.init) {
    const initBytes = readVfsFile(memfs, profile.init.argv[0]);
    tick(`spawning ${profile.init.argv[0]}...`);
    void kernel.spawn(initBytes, profile.init.argv, {
      env: profile.init.env,
      cwd: profile.init.cwd ?? "/",
    }).then(
      (code) => tick(`${profile.init?.argv[0] ?? "init"} exited with code ${code}`),
      (err) => tick(`init failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  if (profile.framebuffer === "doom") {
    await stageDoomWad(kernel, tick);
  }

  if (seq >= 0) {
    host.setStatus("running");
  }
  maybeMarkWebReady(host, profile, seenPorts, bridgeSent, webReadiness, tick);

  if (profile.framebuffer === "test") {
    void spawnLazy(kernel, "/usr/local/bin/fbtest", ["fbtest"], tick);
  } else if (profile.framebuffer === "doom") {
    tick("starting Doom from bash...");
    void host.runShellCommand(profile.presentation.autoCommand ?? DOOM_COMMAND).catch((err) => {
      tick(`doom command failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  tick("ready");
  return kernel;
}

function presentationFor(id: LiveDemoId): DemoPresentation {
  switch (id) {
    case "doom":
      return {
        bootPrimary: "syslog",
        runningPrimary: ["framebuffer", "terminal", "syslog"],
        terminalAccess: "drawer",
        internalsAccess: "drawer",
        autoCommand: DOOM_COMMAND,
      };
    case "nginx":
    case "nginx-php":
    case "wordpress-sqlite":
    case "wordpress-mariadb":
      return {
        bootPrimary: "syslog",
        runningPrimary: ["web", "terminal", "syslog"],
        terminalAccess: "drawer",
        internalsAccess: "drawer",
      };
    case "shell":
    case "node":
    default:
      return {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer",
      };
  }
}

function stageShellUtilities(
  kernel: BrowserKernel,
  dashBytes: ArrayBuffer,
  bashBytes: ArrayBuffer,
  lazyBinaries: BinaryDef[],
): void {
  ensureDirRecursive(kernel.fs, "/home");
  ensureDirRecursive(kernel.fs, "/bin");
  ensureDirRecursive(kernel.fs, "/usr/bin");
  populateShellBinaries(kernel, dashBytes, lazyBinaries);
  writeVfsBinary(kernel.fs, "/bin/bash", new Uint8Array(bashBytes), 0o755);
  try { kernel.fs.symlink("/bin/bash", "/usr/bin/bash"); } catch { /* exists */ }
}

async function loadShellUtilityDefs(includeNode: boolean): Promise<BinaryDef[]> {
  const defs: Array<Omit<BinaryDef, "size">> = [
    ...(includeNode ? [{
      url: nodeWasmUrl,
      path: "/usr/bin/node",
      symlinks: ["/bin/node", "/usr/local/bin/node"],
    }] : []),
    { url: coreutilsWasmUrl, path: "/bin/coreutils", symlinks: [...COREUTILS_NAMES, "["].flatMap((n) => [`/bin/${n}`, `/usr/bin/${n}`]) },
    { url: grepWasmUrl, path: "/usr/bin/grep", symlinks: ["/bin/grep", "/usr/bin/egrep", "/bin/egrep", "/usr/bin/fgrep", "/bin/fgrep"] },
    { url: sedWasmUrl, path: "/usr/bin/sed", symlinks: ["/bin/sed"] },
    { url: bcWasmUrl, path: "/usr/bin/bc", symlinks: ["/bin/bc"] },
    { url: fileWasmUrl, path: "/usr/bin/file", symlinks: ["/bin/file"] },
    { url: lessWasmUrl, path: "/usr/bin/less", symlinks: ["/bin/less"] },
    { url: m4WasmUrl, path: "/usr/bin/m4", symlinks: ["/bin/m4"] },
    { url: makeWasmUrl, path: "/usr/bin/make", symlinks: ["/bin/make"] },
    { url: tarWasmUrl, path: "/usr/bin/tar", symlinks: ["/bin/tar"] },
    { url: curlWasmUrl, path: "/usr/bin/curl", symlinks: ["/bin/curl"] },
    { url: wgetWasmUrl, path: "/usr/bin/wget", symlinks: ["/bin/wget"] },
    { url: gitWasmUrl, path: "/usr/bin/git", symlinks: ["/bin/git"] },
    { url: gitRemoteHttpWasmUrl, path: "/usr/bin/git-remote-http", symlinks: ["/usr/bin/git-remote-https", "/usr/bin/git-remote-ftp", "/usr/bin/git-remote-ftps"] },
    { url: gzipWasmUrl, path: "/usr/bin/gzip", symlinks: ["/bin/gzip", "/usr/bin/gunzip", "/bin/gunzip", "/usr/bin/zcat", "/bin/zcat"] },
    { url: bzip2WasmUrl, path: "/usr/bin/bzip2", symlinks: ["/bin/bzip2", "/usr/bin/bunzip2", "/bin/bunzip2", "/usr/bin/bzcat", "/bin/bzcat"] },
    { url: xzWasmUrl, path: "/usr/bin/xz", symlinks: ["/bin/xz", "/usr/bin/unxz", "/bin/unxz", "/usr/bin/xzcat", "/bin/xzcat", "/usr/bin/lzma", "/bin/lzma", "/usr/bin/unlzma", "/bin/unlzma", "/usr/bin/lzcat", "/bin/lzcat"] },
    { url: zstdWasmUrl, path: "/usr/bin/zstd", symlinks: ["/bin/zstd", "/usr/bin/unzstd", "/bin/unzstd", "/usr/bin/zstdcat", "/bin/zstdcat"] },
    { url: zipWasmUrl, path: "/usr/bin/zip", symlinks: ["/bin/zip"] },
    { url: unzipWasmUrl, path: "/usr/bin/unzip", symlinks: ["/bin/unzip", "/usr/bin/zipinfo", "/bin/zipinfo", "/usr/bin/funzip", "/bin/funzip"] },
    { url: lsofWasmUrl, path: "/usr/bin/lsof", symlinks: ["/bin/lsof"] },
    { url: nanoWasmUrl, path: "/usr/bin/nano", symlinks: ["/bin/nano"] },
  ];
  const sizes = await Promise.all(defs.map((d) => fetchSize(d.url)));
  return defs
    .map((d, i) => ({ ...d, size: sizes[i] }))
    .filter((d) => d.size > 0);
}

async function registerFbPrograms(kernel: BrowserKernel): Promise<void> {
  const probes = [
    { path: "/usr/local/bin/fbdoom", url: fbdoomWasmUrl },
    { path: "/usr/local/bin/fbtest", url: fbtestWasmUrl },
  ];
  ensureDirRecursive(kernel.fs, "/usr/local/bin");
  const sizes = await Promise.all(probes.map((p) => fetchSize(p.url)));
  const entries = probes
    .map((p, i) => ({ ...p, size: sizes[i], mode: 0o755 }))
    .filter((e) => e.size > 0);
  if (entries.length > 0) kernel.registerLazyFiles(entries);
}

async function stageDoomWad(kernel: BrowserKernel, tick: (msg: string) => void): Promise<void> {
  tick("staging /doom1.wad...");
  try {
    const url = import.meta.env.DEV
      ? `/cors-proxy?url=${encodeURIComponent(DOOM_WAD_URL)}`
      : DOOM_WAD_URL;
    const wadBytes = await fetch(url).then(failOn("doom1.wad")).then((r) => r.arrayBuffer());
    writeVfsBinary(kernel.fs, "/doom1.wad", new Uint8Array(wadBytes), 0o644);
  } catch (err) {
    tick(`doom1.wad stage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function spawnLazy(
  kernel: BrowserKernel,
  path: string,
  argv: string[],
  tick: (msg: string) => void,
): Promise<void> {
  const fetchUrl = path === "/usr/local/bin/fbdoom" ? fbdoomWasmUrl
    : path === "/usr/local/bin/fbtest" ? fbtestWasmUrl
    : "";
  if (!fetchUrl) return;
  try {
    tick(`fetching ${argv[0]}...`);
    const bytes = await fetch(fetchUrl).then(failOn(argv[0])).then((r) => r.arrayBuffer());
    tick(`spawning ${argv[0]}...`);
    await kernel.spawn(bytes, argv, { env: SHELL_ENV });
    tick(`${argv[0]} exited`);
  } catch (err) {
    tick(`${argv[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function maybeMarkWebReady(
  host: LiveKernelHost,
  profile: LiveProfile,
  seenPorts: Set<number>,
  bridgeSent: boolean,
  readiness: WebReadinessState,
  tick: (msg: string) => void,
): void {
  const web = profile.init?.web;
  if (!web) return;
  const portsReady = web.requiredPorts.every((p) => seenPorts.has(p));
  if (!portsReady || !bridgeSent) return;
  if (readiness.ready) {
    host.setWebPreview({
      label: web.label,
      url: APP_PREFIX,
      status: "running",
      message: "HTTP bridge ready",
    });
    return;
  }
  if (readiness.probing) return;
  readiness.probing = true;
  host.setWebPreview({
    label: web.label,
    url: APP_PREFIX,
    status: "starting",
    message: "Waiting for HTTP response",
  });
  void waitForHttpPreview(APP_PREFIX).then(
    () => {
      readiness.ready = true;
      host.setWebPreview({
        label: web.label,
        url: APP_PREFIX,
        status: "running",
        message: "HTTP bridge ready",
      });
      tick("HTTP preview ready");
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      host.setWebPreview({
        label: web.label,
        url: APP_PREFIX,
        status: "error",
        message: "HTTP preview did not become ready",
      });
      tick(`HTTP preview readiness failed: ${message}`);
    },
  ).finally(() => {
    readiness.probing = false;
  });
}

async function waitForHttpPreview(url: string, timeoutMs = 90_000): Promise<void> {
  const started = performance.now();
  let delayMs = 250;
  let lastError = "";

  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, 5_000);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(delayMs);
    delayMs = Math.min(1_500, Math.floor(delayMs * 1.4));
  }

  throw new Error(lastError || "timed out");
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setupBridgeRestoreListener(
  kernel: BrowserKernel,
  httpPort: number,
  tick: (msg: string) => void,
): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "need-bridge") return;
    const replyPort = event.ports[0];
    if (!replyPort) return;
    const bridge = new HttpBridgeHost();
    replyPort.postMessage(
      { type: "bridge-restored", appPrefix: APP_PREFIX },
      [bridge.getSwPort()],
    );
    kernel.sendBridgePort(bridge.detachHostPort(), httpPort);
    tick("HTTP bridge restored");
  });
}

function descriptorFor(id: LiveDemoId): BootDescriptor {
  const item = liveGalleryItems().find((p) => p.id === id) ?? liveGalleryItems()[0];
  return {
    version: 1,
    id: item.id,
    title: item.title,
    base: item.base,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: id === "wordpress-mariadb" || id === "node" ? 4096 : 2048,
      features: ["shared-array-buffer", "pty", ...(item.id === "doom" ? ["framebuffer"] : []), ...(item.id === "shell" || item.id === "doom" ? [] : ["tcp-bridge"])],
      time: "real",
    },
    packages: item.packages,
    mounts: [
      { path: "/", source: "image", ref: `${item.id}.vfs@local`, readonly: false },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: item.bootCommand,
      cwd: item.id === "node" ? "/work" : "/home",
      env: Object.fromEntries((item.id === "node" ? NODE_SHELL_ENV : SHELL_ENV).map((kv) => {
        const idx = kv.indexOf("=");
        return [kv.slice(0, idx), kv.slice(idx + 1)];
      })),
    },
    caps: { network: item.id !== "shell" && item.id !== "doom" },
  };
}

function liveGalleryItems(): GalleryItem[] {
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

function normalizeDemoId(id: string | null | undefined): LiveDemoId | null {
  switch (id) {
    case "shell":
    case "node":
    case "nginx":
    case "nginx-php":
    case "wordpress-sqlite":
    case "wordpress-mariadb":
    case "doom":
      return id;
    case "wordpress":
      return "wordpress-sqlite";
    case "lamp":
      return "wordpress-mariadb";
    default:
      return null;
  }
}

function readVfsFile(fs: MemoryFileSystem, path: string): ArrayBuffer {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(st.size);
    let off = 0;
    while (off < out.byteLength) {
      const n = fs.read(fd, out.subarray(off), null, out.byteLength - off);
      if (n <= 0) break;
      off += n;
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + off);
  } finally {
    fs.close(fd);
  }
}

async function fetchSize(url: string): Promise<number> {
  try {
    const resp = await fetch(url, { method: "HEAD" });
    if (!resp.ok) return 0;
    return Number(resp.headers.get("content-length") ?? 0) || 0;
  } catch {
    return 0;
  }
}

function failOn(label: string): (r: Response) => Response {
  return (r) => {
    if (!r.ok) throw new Error(`fetch failed for ${label}: ${r.status} ${r.statusText}`);
    return r;
  };
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KiB`;
}
