// Builds a LiveKernelHost over a real BrowserKernel. Used by default when the
// kandelo page is loaded (use `?mock=1` for MockKernelHost).

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

import { BrowserKernel } from "@host/browser-kernel-host";
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
  writeVfsFile,
} from "../../../../../host/src/vfs/image-helpers";
import { decompress as decompressZstd } from "fzstd";
import {
  extractZipEntry,
  parseZipCentralDirectory,
} from "../../../../../host/src/vfs/zip";
import {
  LiveKernelHost,
  type BootDescriptor,
  type DemoPresentation,
  type GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
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
import fbseatProbeWasmUrl from "@binaries/programs/wasm32/fbseat-probe.wasm?url";
import kdesktopWasmUrl from "@binaries/programs/wasm32/kdesktop.wasm?url";
import jwmWasmUrl from "@binaries/programs/wasm32/jwm.wasm?url";
import xvfsBrowserWasmUrl from "@binaries/programs/wasm32/xvfs-browser.wasm?url";
import xclockWasmUrl from "@binaries/programs/wasm32/xclock.wasm?url";
import xeyesWasmUrl from "@binaries/programs/wasm32/xeyes.wasm?url";
import xfbdevWasmUrl from "@binaries/programs/wasm32/Xfbdev.wasm?url";
import xkbcompWasmUrl from "@binaries/programs/wasm32/xkbcomp.wasm?url";
import xkeyboardConfigZipUrl from "@binaries/programs/wasm32/xkeyboard-config-2.45-kandelo-xkb.zip?url";

const DEFAULT_SOFTWARE_MANIFEST_URLS = [
  "https://github.com/brandonpayton/kandelo-software/releases/download/binaries-abi-v11/gallery.json",
];

type GalleryPackageRequirement = {
  name: string;
  version: string;
};

type SoftwareGalleryEntry = {
  id: string;
  title: string;
  description: string;
  packages: GalleryPackageRequirement[];
  package_url?: string;
};

type SoftwareGalleryManifest = {
  source_id?: string;
  repository?: string;
  index_url?: string;
  entries: SoftwareGalleryEntry[];
};

type IndexBinaryEntry = {
  status?: string;
  archive_url?: string;
};

type IndexPackageEntry = {
  name?: string;
  version?: string;
  binary: Record<string, IndexBinaryEntry>;
};

type SoftwareBinary = {
  archiveUrl: string;
  artifactPath: string;
  installPath: string;
  symlinks?: string[];
};

type SoftwareProfile = {
  id: string;
  vfsArchiveUrl: string;
  vfsArtifactPath: string;
  binaries: SoftwareBinary[];
  shellEnv?: string[];
  autoCommand?: string;
  init?: LiveProfile["init"];
  presentation?: DemoPresentation;
};

const SOFTWARE_PROFILES = new Map<string, SoftwareProfile>();
const tarDecoder = new TextDecoder();

type LiveDemoId =
  | "shell"
  | "node"
  | "nginx"
  | "nginx-php"
  | "wordpress-sqlite"
  | "wordpress-mariadb"
  | "doom"
  | "desktop-jwm";

interface LiveProfile {
  id: LiveDemoId;
  vfsUrl: string;
  software?: SoftwareProfile;
  descriptor: BootDescriptor;
  presentation: DemoPresentation;
  autoCommand?: string;
  init?: {
    argv: string[];
    env?: string[];
    cwd?: string;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: { label: string; requiredPorts: number[] };
  };
  framebuffer?: "desktop" | "doom" | "test";
}

interface WebReadinessState {
  ready: boolean;
  probing: boolean;
}

interface DesktopProcessSpec {
  path: string;
  argv: string[];
  env?: string[];
  cwd?: string;
}

interface DesktopClientSpec extends DesktopProcessSpec {
  label: string;
  delayMs?: number;
}

interface DesktopSessionSpec {
  probe: DesktopProcessSpec;
  xServer: DesktopProcessSpec;
  windowManager: DesktopProcessSpec;
  clients: DesktopClientSpec[];
  fallback: DesktopProcessSpec;
}

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const HTTP_PORT = 8080;
const DOOM_WAD_URL = "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";
const PHP_FPM_WORKERS = 6;
const PATCHED_PHP_FPM_CONF = `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
user = nobody
group = nobody
listen = 127.0.0.1:9000
pm = static
pm.max_children = ${PHP_FPM_WORKERS}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;

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
const XFBDEV_ARGV = [
  "Xfbdev",
  ":0",
  "-screen",
  "640x480x32",
  "-nolisten",
  "tcp",
  "-noreset",
  "-dumbSched",
  "-mouse",
  "evdev,,device=/dev/input/event0",
  "-keybd",
  "evdev,,device=/dev/input/event1",
];
const JWM_ARGV = ["jwm", "-display", "unix/:0", "-f", "/home/.jwmrc"];
const XVFS_BROWSER_ARGV = ["xvfs-browser", "/home"];
const XCLOCK_ARGV = ["xclock"];
const XEYES_ARGV = ["xeyes"];
const X_CLIENT_ENV = [...SHELL_ENV, "DISPLAY=unix/:0"];
const DESKTOP_SESSION: DesktopSessionSpec = {
  probe: { path: "/usr/local/bin/fbseat-probe", argv: ["fbseat-probe"] },
  xServer: { path: "/usr/local/bin/Xfbdev", argv: XFBDEV_ARGV },
  windowManager: { path: "/usr/local/bin/jwm", argv: JWM_ARGV, env: X_CLIENT_ENV, cwd: "/home" },
  clients: [
    { label: "X VFS browser", path: "/usr/local/bin/xvfs-browser", argv: XVFS_BROWSER_ARGV, env: X_CLIENT_ENV, cwd: "/home", delayMs: 750 },
    { label: "xclock", path: "/usr/local/bin/xclock", argv: XCLOCK_ARGV, env: X_CLIENT_ENV, cwd: "/home", delayMs: 750 },
    { label: "xeyes", path: "/usr/local/bin/xeyes", argv: XEYES_ARGV, env: X_CLIENT_ENV, cwd: "/home", delayMs: 250 },
  ],
  fallback: { path: "/usr/local/bin/kdesktop", argv: ["kdesktop"] },
};
const DESKTOP_LAB_COMMAND = `cat >/home/desktop-lab.txt <<'EOF'
Kandelo desktop lab

Running stack:
  /usr/local/bin/fbseat-probe
  /usr/local/bin/Xfbdev
  /usr/local/bin/jwm
  /usr/local/bin/xvfs-browser
  /usr/local/bin/xclock
  /usr/local/bin/xeyes
  built-in XKB fallback in the Xfbdev wasm port
  /usr/local/bin/kdesktop fallback
  /dev/fb0 framebuffer
  /dev/input/event0 pointer events
  /dev/input/event1 keyboard key events
  /dev/input/mice legacy pointer fallback
  opendir/readdir/stat against the Kandelo VFS

This is the first real desktop-shaped rendering path. fbseat-probe validates
the generic device contract, then the demo starts a real upstream Xfbdev build
with JWM and a libX11 VFS browser on DISPLAY=:0. kdesktop remains only as an
emergency framebuffer fallback while a richer file manager is ported.
EOF
cat /home/desktop-lab.txt`;

export type FbDemo = "none" | "test" | "doom";

export interface CreateLiveHostOptions {
  demo?: string | null;
  fb?: FbDemo;
}

export async function createLiveHost(opts: CreateLiveHostOptions = {}): Promise<LiveKernelHost> {
  let currentKernel: BrowserKernel | null = null;
  let bootSeq = 0;
  const galleryItems = await loadLiveGalleryItems();

  const host = new LiveKernelHost({
    status: "booting",
    descriptor: descriptorFor("shell"),
    galleryItems,
    applyBootDescriptor: async (desc, h) => {
      const seq = ++bootSeq;
      try {
        if (currentKernel) {
          await currentKernel.destroy().catch(() => {});
          currentKernel = null;
        }
        currentKernel = await bootProfile(h, profileFor(desc.id, "none"), desc, seq);
      } catch (err) {
        currentKernel = null;
        h.detachKernel();
        showBootError(h, desc, err);
      }
    },
  });

  const initialId = normalizeDemoId(opts.demo) ?? (opts.fb === "doom" ? "doom" : "shell");
  currentKernel = await bootProfile(host, profileFor(initialId, opts.fb), descriptorFor(initialId), ++bootSeq);
  return host;
}

function showBootError(
  host: LiveKernelHost,
  descriptor: BootDescriptor,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  host.clearDmesg();
  host.setWebPreview(null);
  host.setDescriptor(descriptor);
  host.setPresentation({
    bootPrimary: "syslog",
    runningPrimary: ["syslog"],
    terminalAccess: "drawer",
    internalsAccess: "drawer",
  });
  host.pushDmesg({
    t: 50,
    level: "err",
    facility: "kandelo",
    msg: `Failed to boot ${descriptor.title || descriptor.id}`,
  });
  host.pushDmesg({
    t: 100,
    level: "err",
    facility: "kandelo",
    msg: message,
  });
  if (SOFTWARE_PROFILES.has(descriptor.id)) {
    host.pushDmesg({
      t: 150,
      level: "warn",
      facility: "kandelo-software",
      msg: "The third-party gallery entry may be temporarily unavailable or its release artifact may have been deleted.",
    });
  }
  host.setStatus("error");
}

function profileFor(id: string, fb?: FbDemo): LiveProfile {
  const software = SOFTWARE_PROFILES.get(id);
  if (software) {
    const desc = descriptorFor(id);
    return {
      id: software.id,
      vfsUrl: software.vfsArchiveUrl,
      software,
      descriptor: desc,
      presentation: software.presentation ?? {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer",
      },
      autoCommand: software.autoCommand,
      init: software.init,
    };
  }

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
          maxWorkers: 12,
          maxMemoryPages: 4096,
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
          maxWorkers: 12,
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
          maxWorkers: 16,
          maxMemoryPages: 4096,
          web: { label: "WordPress MariaDB", requiredPorts: [HTTP_PORT, 3306] },
        },
      };
    case "doom":
      return { id: "doom", vfsUrl: shellVfsUrl, descriptor: desc, presentation, framebuffer: "doom" };
    case "desktop-jwm":
      return {
        id: "desktop-jwm",
        vfsUrl: shellVfsUrl,
        descriptor: desc,
        presentation,
        framebuffer: "desktop",
      };
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
  const stdout = createDmesgOutputSink("stdout", tick);
  const stderr = createDmesgOutputSink("stderr", tick);

  tick(`loading ${profile.id} profile...`);
  const [kernelBytes, vfsBytes, bashBytes, dashBytes, lazyBinaries, softwareBinaries] = await Promise.all([
    fetch(kernelWasmUrl).then(failOn("kernel.wasm")).then((r) => r.arrayBuffer()),
    loadVfsImageBytes(profile),
    fetch(bashWasmUrl).then(failOn("bash.wasm")).then((r) => r.arrayBuffer()),
    fetch(dashWasmUrl).then(failOn("dash.wasm")).then((r) => r.arrayBuffer()),
    loadShellUtilityDefs(profile.id === "node"),
    loadSoftwareBinaries(profile.software),
  ]);

  tick(`kernel: ${kib(kernelBytes.byteLength)} · vfs: ${kib(vfsBytes.byteLength)}`);
  const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsBytes), {
    maxByteLength: profile.id === "wordpress-mariadb" ? 512 * 1024 * 1024 : 256 * 1024 * 1024,
  });
  if (
    profile.id === "nginx-php" ||
    profile.id === "wordpress-sqlite" ||
    profile.id === "wordpress-mariadb"
  ) {
    writeVfsFile(memfs, "/etc/php-fpm.conf", PATCHED_PHP_FPM_CONF);
  }
  memfs.rewriteLazyArchiveUrls((url) => import.meta.env.BASE_URL + url);
  if (profile.id === "desktop-jwm") {
    seedDesktopLabVfs(memfs);
    await stageDesktopXkbData(memfs, tick);
  }

  tick("instantiating kernel...");
  const seenPorts = new Set<number>();
  let bridgeSent = false;
  const webReadiness: WebReadinessState = { ready: false, probing: false };
  const kernel = new BrowserKernel({
    memfs,
    maxWorkers: profile.init?.maxWorkers ?? 4,
    maxMemoryPages: profile.init?.maxMemoryPages,
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
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
  stageSoftwareBinaries(kernel, softwareBinaries);
  await registerFbPrograms(kernel);
  host.attachKernel(kernel);
  const shellEnv = profile.software?.shellEnv ?? (profile.id === "node" ? NODE_SHELL_ENV : SHELL_ENV);
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
  } else if (profile.framebuffer === "desktop") {
    tick("probing graphical seat...");
    const probeCode = await spawnLazy(kernel, DESKTOP_SESSION.probe.path, DESKTOP_SESSION.probe.argv, tick, DESKTOP_SESSION.probe);
    if (probeCode !== 0) {
      tick(`graphical seat probe exited with code ${probeCode}; continuing for inspection`);
    }
    tick("starting Xfbdev...");
    const xfbdevExit = spawnLazy(kernel, DESKTOP_SESSION.xServer.path, DESKTOP_SESSION.xServer.argv, tick, DESKTOP_SESSION.xServer);
    const earlyXfbdevStartup = await Promise.race([
      xfbdevExit.then((code) => ({ kind: "exit" as const, code })),
      sleep(750).then(() => ({ kind: "starting" as const })),
    ]);
    if (earlyXfbdevStartup.kind === "starting") {
      tick("starting JWM...");
      void spawnLazy(kernel, DESKTOP_SESSION.windowManager.path, DESKTOP_SESSION.windowManager.argv, tick, DESKTOP_SESSION.windowManager);
      await sleep(250);
      for (const client of DESKTOP_SESSION.clients) {
        tick(`starting ${client.label}...`);
        void spawnLazy(kernel, client.path, client.argv, tick, client);
        if (client.delayMs) await sleep(client.delayMs);
      }
    }
    const xfbdevStartup = earlyXfbdevStartup.kind === "exit"
      ? earlyXfbdevStartup
      : await Promise.race([
          xfbdevExit.then((code) => ({ kind: "exit" as const, code })),
          sleep(2_250).then(() => ({ kind: "running" as const })),
        ]);
    if (xfbdevStartup.kind === "running") {
      tick("Xfbdev stayed up after startup window; leaving JWM and X VFS browser attached");
      void xfbdevExit;
    } else {
      tick(`Xfbdev exited during startup with code ${xfbdevStartup.code}; starting kdesktop fallback`);
      void spawnLazy(kernel, DESKTOP_SESSION.fallback.path, DESKTOP_SESSION.fallback.argv, tick, DESKTOP_SESSION.fallback);
    }
  } else if (profile.framebuffer === "doom") {
    tick("starting Doom from bash...");
    void host.runShellCommand(profile.presentation.autoCommand ?? DOOM_COMMAND).catch((err) => {
      tick(`doom command failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else if (profile.autoCommand) {
    tick(`running ${profile.autoCommand}...`);
    void host.runShellCommand(profile.autoCommand).catch((err) => {
      tick(`command failed: ${err instanceof Error ? err.message : String(err)}`);
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
    case "desktop-jwm":
      return {
        bootPrimary: "syslog",
        runningPrimary: ["framebuffer", "terminal", "syslog"],
        terminalAccess: "drawer",
        internalsAccess: "drawer",
        autoCommand: DESKTOP_LAB_COMMAND,
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

async function loadVfsImageBytes(profile: LiveProfile): Promise<ArrayBuffer> {
  if (!profile.software) {
    return fetch(profile.vfsUrl).then(failOn(`${profile.id}.vfs.zst`)).then((r) => r.arrayBuffer());
  }
  const vfsImage = await loadArchiveArtifact(
    profile.software.vfsArchiveUrl,
    profile.software.vfsArtifactPath,
  );
  return vfsImage.buffer.slice(
    vfsImage.byteOffset,
    vfsImage.byteOffset + vfsImage.byteLength,
  );
}

async function loadSoftwareBinaries(
  software: SoftwareProfile | undefined,
): Promise<Array<{ spec: SoftwareBinary; bytes: Uint8Array }>> {
  if (!software) return [];
  return Promise.all(software.binaries.map(async (spec) => ({
    spec,
    bytes: await loadArchiveArtifact(spec.archiveUrl, spec.artifactPath),
  })));
}

function stageSoftwareBinaries(
  kernel: BrowserKernel,
  binaries: Array<{ spec: SoftwareBinary; bytes: Uint8Array }>,
): void {
  for (const { spec, bytes } of binaries) {
    ensureDirRecursive(kernel.fs, dirname(spec.installPath));
    writeVfsBinary(kernel.fs, spec.installPath, bytes, 0o755);
    for (const symlinkPath of spec.symlinks ?? []) {
      ensureDirRecursive(kernel.fs, dirname(symlinkPath));
      try { kernel.fs.symlink(spec.installPath, symlinkPath); } catch { /* exists */ }
    }
  }
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

async function loadArchiveArtifact(archiveUrl: string, artifactPath: string): Promise<Uint8Array> {
  const archiveBytes = await fetchBytesWithDevProxy(archiveUrl);
  const tarBytes = decompressZstd(archiveBytes);
  const artifact = extractTarFile(tarBytes, artifactPath);
  if (!artifact) {
    throw new Error(`${artifactPath} not found in ${archiveUrl}`);
  }
  return artifact;
}

function extractTarFile(tarBytes: Uint8Array, wantedPath: string): Uint8Array | undefined {
  for (let offset = 0; offset + 512 <= tarBytes.length;) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return undefined;

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).trim();
    const size = parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size)) {
      throw new Error(`Invalid tar size for ${path}`);
    }

    offset += 512;
    if (path === wantedPath) {
      return tarBytes.slice(offset, offset + size);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return undefined;
}

function tarString(block: Uint8Array, offset: number, length: number): string {
  return tarDecoder.decode(block.subarray(offset, offset + length)).replace(/\0.*$/, "");
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
    { path: "/usr/local/bin/fbseat-probe", url: fbseatProbeWasmUrl },
    { path: "/usr/local/bin/kdesktop", url: kdesktopWasmUrl },
    { path: "/usr/local/bin/jwm", url: jwmWasmUrl },
    { path: "/usr/local/bin/xvfs-browser", url: xvfsBrowserWasmUrl },
    { path: "/usr/local/bin/xclock", url: xclockWasmUrl },
    { path: "/usr/local/bin/xeyes", url: xeyesWasmUrl },
    { path: "/usr/local/bin/Xfbdev", url: xfbdevWasmUrl },
    { path: "/usr/bin/xkbcomp", url: xkbcompWasmUrl },
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
  options: { env?: string[]; cwd?: string } = {},
): Promise<number> {
  const fetchUrl = lazyProgramUrl(path);
  if (!fetchUrl) return -1;
  try {
    tick(`fetching ${argv[0]}...`);
    const bytes = await fetch(fetchUrl).then(failOn(argv[0])).then((r) => r.arrayBuffer());
    tick(`spawning ${argv[0]}...`);
    const code = await kernel.spawn(bytes, argv, {
      env: options.env ?? SHELL_ENV,
      cwd: options.cwd,
    });
    tick(`${argv[0]} exited with code ${code}`);
    return code;
  } catch (err) {
    tick(`${argv[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
    return -1;
  }
}

function lazyProgramUrl(path: string): string {
  return path === "/usr/local/bin/fbdoom" ? fbdoomWasmUrl
    : path === "/usr/local/bin/fbtest" ? fbtestWasmUrl
    : path === "/usr/local/bin/fbseat-probe" ? fbseatProbeWasmUrl
    : path === "/usr/local/bin/kdesktop" ? kdesktopWasmUrl
    : path === "/usr/local/bin/jwm" ? jwmWasmUrl
    : path === "/usr/local/bin/xvfs-browser" ? xvfsBrowserWasmUrl
    : path === "/usr/local/bin/xclock" ? xclockWasmUrl
    : path === "/usr/local/bin/xeyes" ? xeyesWasmUrl
    : path === "/usr/local/bin/Xfbdev" ? xfbdevWasmUrl
    : "";
}

async function stageDesktopXkbData(
  fs: MemoryFileSystem,
  tick: (msg: string) => void,
): Promise<void> {
  tick("staging XKB rules...");
  const zipBytes = new Uint8Array(
    await fetch(xkeyboardConfigZipUrl)
      .then(failOn("xkeyboard-config zip"))
      .then((r) => r.arrayBuffer()),
  );
  const entries = parseZipCentralDirectory(zipBytes);
  let files = 0;
  for (const entry of entries) {
    if (entry.isDirectory || entry.isSymlink) continue;
    if (!entry.fileName.startsWith("usr/share/X11/xkb/")) continue;
    const path = "/" + entry.fileName.replace(/^\/+/, "");
    const parent = path.slice(0, path.lastIndexOf("/"));
    ensureDirRecursive(fs, parent);
    writeVfsBinary(fs, path, extractZipEntry(zipBytes, entry), entry.mode & 0o777 || 0o644);
    files++;
  }
  ensureDirRecursive(fs, "/usr/share/X11/xkb/compiled");
  tick(`XKB rules ready (${files} files)`);
}

function seedDesktopLabVfs(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/home/Desktop");
  ensureDirRecursive(fs, "/home/Documents");
  writeVfsFile(fs, "/home/.jwmrc", `<?xml version="1.0"?>
<JWM>
  <RootMenu onroot="123">
    <Program label="VFS Browser">/usr/local/bin/xvfs-browser /home</Program>
    <Program label="xclock">/usr/local/bin/xclock</Program>
    <Program label="xeyes">/usr/local/bin/xeyes</Program>
    <Restart label="Restart JWM"/>
    <Exit label="Exit JWM" confirm="false"/>
  </RootMenu>

  <Group>
    <Class>XvfsBrowser</Class>
    <Option>x:2</Option>
    <Option>y:22</Option>
    <Option>width:418</Option>
    <Option>height:432</Option>
  </Group>
  <Group>
    <Class>XClock</Class>
    <Option>x:428</Option>
    <Option>y:22</Option>
    <Option>width:208</Option>
    <Option>height:170</Option>
  </Group>
  <Group>
    <Class>XEyes</Class>
    <Option>x:428</Option>
    <Option>y:222</Option>
    <Option>width:208</Option>
    <Option>height:146</Option>
  </Group>

  <Tray x="0" y="-1" width="640" height="24" autohide="off">
    <TrayButton label="JWM">root:1</TrayButton>
    <TaskList maxwidth="360"/>
    <Clock format="%H:%M"/>
  </Tray>

  <WindowStyle decorations="motif">
    <Font>fixed</Font>
    <Width>2</Width>
    <Corner>0</Corner>
    <Foreground>#f6f3e8</Foreground>
    <Background>#3f5967</Background>
    <Active>
      <Foreground>#ffffff</Foreground>
      <Background>#2f7c8f</Background>
    </Active>
  </WindowStyle>
  <TrayStyle decorations="motif">
    <Font>fixed</Font>
    <Background>#263238</Background>
    <Foreground>#f6f3e8</Foreground>
  </TrayStyle>
  <TaskListStyle list="all" group="false">
    <Font>fixed</Font>
    <Foreground>#f6f3e8</Foreground>
    <Background>#3b4b52</Background>
    <Active>
      <Foreground>#ffffff</Foreground>
      <Background>#2f7c8f</Background>
    </Active>
  </TaskListStyle>
  <MenuStyle decorations="motif">
    <Font>fixed</Font>
    <Foreground>#f6f3e8</Foreground>
    <Background>#263238</Background>
    <Active>
      <Foreground>#ffffff</Foreground>
      <Background>#2f7c8f</Background>
    </Active>
  </MenuStyle>
  <TrayButtonStyle>
    <Font>fixed</Font>
    <Foreground>#f6f3e8</Foreground>
    <Background>#42535a</Background>
    <Active>
      <Foreground>#ffffff</Foreground>
      <Background>#2f7c8f</Background>
    </Active>
  </TrayButtonStyle>
  <ClockStyle>
    <Font>fixed</Font>
    <Foreground>#f6f3e8</Foreground>
    <Background>#263238</Background>
  </ClockStyle>

  <TitleButtonOrder>witmx</TitleButtonOrder>
  <Desktops width="1" height="1">
    <Background type="solid">#182026</Background>
  </Desktops>
  <FocusModel>click</FocusModel>
  <MoveMode>opaque</MoveMode>
  <ResizeMode>opaque</ResizeMode>
  <DoubleClickSpeed>400</DoubleClickSpeed>
  <DoubleClickDelta>4</DoubleClickDelta>
</JWM>
`);
  writeVfsFile(fs, "/home/desktop-lab.txt", `Kandelo desktop lab

This file is inside the live Kandelo VFS. The framebuffer desktop reads this
directory with opendir/readdir/stat from inside a wasm32 process.

The prototype now stages real Xfbdev and JWM binaries, then runs multiple
libX11 clients on DISPLAY=:0: a VFS browser, xclock, and xeyes. That proves the
next user-space layer above the framebuffer without adding desktop-demo-specific
kernel code.

The /usr/local/bin/fbseat-probe command validates the graphics seat ABI.
The Xfbdev wasm port uses a built-in XKB fallback, avoiding an external
xkbcomp fork before the display starts accepting clients.

Input policy: text-mode programs should continue to use POSIX terminal
I/O. The framebuffer desktop also exposes Linux fbdev/evdev devices because
those are the practical compatibility layer for X, Wayland, SDL, and
desktop-style graphical programs.
`);
  writeVfsFile(fs, "/home/Documents/next-steps.txt", `Next steps:
1. keep POSIX terminal I/O as the default text input path
2. keep Linux fbdev/evdev as optional graphical-seat compatibility devices
3. run /usr/local/bin/fbseat-probe after graphics-seat changes
4. keep Xfbdev accepting X clients through AF_UNIX sockets
5. keep replacing the Xlib VFS browser fallback with a richer VFS-aware file manager
`);
  writeVfsFile(fs, "/home/Desktop/open-me.txt", "This desktop icon is backed by the Kandelo VFS.\n");
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

function createDmesgOutputSink(label: string, tick: (msg: string) => void): { push(data: Uint8Array): void } {
  const decoder = new TextDecoder();
  let carry = "";
  return {
    push(data: Uint8Array) {
      carry += decoder.decode(data, { stream: true });
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) tick(line || label);
      if (carry.length > 4096) {
        tick(carry);
        carry = "";
      }
    },
  };
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
  const item = SOFTWARE_PROFILES.has(id)
    ? liveGalleryItems().find((p) => p.id === "shell")!
    : liveGalleryItems().find((p) => p.id === id) ?? liveGalleryItems()[0];
  const software = SOFTWARE_PROFILES.get(id);
  return {
    version: 1,
    id: software?.id ?? item.id,
    title: software ? software.id.replace(/^kandelo-software-/, "") : item.title,
    base: software ? "kandelo:shell@abi11" : item.base,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: id === "wordpress-mariadb" || id === "node" || software ? 4096 : 2048,
      features: [
        "shared-array-buffer",
        "pty",
        ...(item.id === "doom" || item.id === "desktop-jwm" ? ["framebuffer"] : []),
        ...(item.id === "shell" || item.id === "doom" || item.id === "desktop-jwm" || software ? [] : ["tcp-bridge"]),
      ],
      time: "real",
    },
    packages: software ? [] : item.packages,
    mounts: [
      { path: "/", source: "image", ref: `${software?.id ?? item.id}.vfs@local`, readonly: false },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: software ? ["bash", "-l", "-i"] : item.bootCommand,
      cwd: item.id === "node" ? "/work" : "/home",
      env: Object.fromEntries((software?.shellEnv ?? (item.id === "node" ? NODE_SHELL_ENV : SHELL_ENV)).map((kv) => {
        const idx = kv.indexOf("=");
        return [kv.slice(0, idx), kv.slice(idx + 1)];
      })),
    },
    caps: { network: item.id !== "shell" && item.id !== "doom" && item.id !== "desktop-jwm" && !software },
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

async function loadLiveGalleryItems(): Promise<GalleryItem[]> {
  const localItems = liveGalleryItems();
  try {
    return [...localItems, ...await loadKandeloSoftwareGalleryItems()];
  } catch (err) {
    console.warn("Could not load kandelo-software gallery entries:", err);
    return localItems;
  }
}

async function loadKandeloSoftwareGalleryItems(): Promise<GalleryItem[]> {
  const groups = await Promise.all(softwareManifestUrls().map(async (manifestUrl) => {
    try {
      return await loadSoftwareGalleryItemsFromManifest(manifestUrl);
    } catch (err) {
      console.warn(`Could not load Kandelo software gallery manifest ${manifestUrl}:`, err);
      return [];
    }
  }));
  return groups.flat();
}

async function loadSoftwareGalleryItemsFromManifest(manifestUrl: string): Promise<GalleryItem[]> {
  const manifestText = await fetchTextWithDevProxy(manifestUrl);
  const manifest = JSON.parse(manifestText) as SoftwareGalleryManifest;
  const sourceId = sourceIdForManifest(manifest, manifestUrl);
  const indexUrl = manifest.index_url
    ? new URL(manifest.index_url, manifestUrl).href
    : new URL("index.toml", manifestUrl).href;
  const index = parseIndexToml(await fetchTextWithDevProxy(indexUrl));
  return manifest.entries
    .filter((entry) => entry.packages.every((pkg) => packageAvailable(index, pkg)))
    .map((entry) => softwareEntryToGalleryItem(entry, sourceId, index, indexUrl));
}

function softwareManifestUrls(): string[] {
  const params = new URLSearchParams(location.search);
  const queryUrls = params.getAll("softwareManifest").flatMap(splitManifestUrls);
  const envUrls = splitManifestUrls(
    (import.meta.env.VITE_KANDELO_SOFTWARE_MANIFEST_URLS as string | undefined) ?? "",
  );
  const urls = queryUrls.length > 0
    ? queryUrls
    : envUrls.length > 0
      ? envUrls
      : DEFAULT_SOFTWARE_MANIFEST_URLS;
  return [...new Set(urls)];
}

function splitManifestUrls(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function sourceIdForManifest(manifest: SoftwareGalleryManifest, manifestUrl: string): string {
  const raw = manifest.source_id
    ?? manifest.repository?.split("/").pop()
    ?? new URL(manifestUrl, location.href).pathname.split("/").filter(Boolean)[0]
    ?? "software";
  const normalized = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "software";
}

function softwareEntryToGalleryItem(
  entry: SoftwareGalleryEntry,
  sourceId: string,
  index: Map<string, IndexPackageEntry>,
  indexUrl: string,
): GalleryItem {
  const primaryPackage = entry.packages[entry.packages.length - 1];
  const archiveUrl = archiveUrlFor(index, indexUrl, primaryPackage);
  const id = `${sourceId}-${entry.id}`;
  if (archiveUrl) {
    SOFTWARE_PROFILES.set(id, softwareProfileForEntry(id, entry, index, indexUrl, archiveUrl));
  }
  return {
    id,
    title: entry.title,
    summary: archiveUrl
      ? `${entry.description} Archive: ${archiveUrl}`
      : entry.description,
    base: "kandelo:shell@abi11",
    packages: entry.packages.map(packageKey),
    bootCommand: ["bash", "-l", "-i"],
    accent: accentForSoftwareEntry(entry.id),
    glyph: glyphForSoftwareEntry(entry),
    estimatedUrlBytes: JSON.stringify(entry).length,
    author: sourceId,
  };
}

function softwareProfileForEntry(
  id: string,
  entry: SoftwareGalleryEntry,
  index: Map<string, IndexPackageEntry>,
  indexUrl: string,
  vfsArchiveUrl: string,
): SoftwareProfile {
  const primaryPackage = entry.packages[entry.packages.length - 1];
  const runtimePackage = entry.packages[0];
  const runtimeArchiveUrl = archiveUrlFor(index, indexUrl, runtimePackage);
  const vfsArtifactPath = `artifacts/${primaryPackage.name}.vfs.zst`;

  const base: SoftwareProfile = {
    id,
    vfsArchiveUrl,
    vfsArtifactPath,
    binaries: [],
    shellEnv: SHELL_ENV,
  };

  if (entry.id.includes("python") && runtimeArchiveUrl) {
    return {
      ...base,
      binaries: [{
        archiveUrl: runtimeArchiveUrl,
        artifactPath: "artifacts/python.wasm",
        installPath: "/usr/bin/python",
        symlinks: ["/usr/bin/python3", "/usr/local/bin/python", "/usr/local/bin/python3"],
      }],
      shellEnv: [
        ...SHELL_ENV,
        "PYTHONHOME=/usr",
        "PYTHONDONTWRITEBYTECODE=1",
        "PYTHONNOUSERSITE=1",
      ],
      autoCommand: "python3 -c \"import sys, json; print('Python', sys.version.split()[0]); print(json.dumps({'kandelo': 'software'}))\"",
    };
  }

  if (entry.id.includes("perl") && runtimeArchiveUrl) {
    return {
      ...base,
      binaries: [{
        archiveUrl: runtimeArchiveUrl,
        artifactPath: "artifacts/perl.wasm",
        installPath: "/usr/bin/perl",
        symlinks: ["/usr/local/bin/perl"],
      }],
      shellEnv: [...SHELL_ENV, "PERL5LIB=/usr/lib/perl5"],
      autoCommand: "perl -e 'print \"Perl $^V from kandelo-software\\n\"'",
    };
  }

  if (entry.id.includes("erlang") && runtimeArchiveUrl) {
    return {
      ...base,
      binaries: [{
        archiveUrl: runtimeArchiveUrl,
        artifactPath: "artifacts/erlang.wasm",
        installPath: "/usr/bin/erlang",
        symlinks: ["/usr/bin/erl", "/usr/local/bin/erl"],
      }],
      shellEnv: [
        ...SHELL_ENV,
        "ROOTDIR=/usr/local/lib/erlang",
        "BINDIR=/usr/local/lib/erlang/erts-16.1.2/bin",
        "EMU=beam",
        "PROGNAME=erl",
      ],
      autoCommand: [
        "erlang",
        "-S 1:1 -A 0 -SDio 1 -SDcpu 1:1 -P 262144 --",
        "-root /usr/local/lib/erlang",
        "-bindir /usr/local/lib/erlang/erts-16.1.2/bin",
        "-progname erl -home /tmp -start_epmd false",
        "-boot /usr/local/lib/erlang/releases/28/start_clean",
        "-noshell -eval 'io:format(\"Erlang/OTP from kandelo-software~n\"), halt().'",
      ].join(" "),
    };
  }

  if (entry.id.includes("redis")) {
    return {
      ...base,
      shellEnv: SERVICE_ENV,
      init: {
        argv: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"],
        env: SERVICE_ENV,
        maxWorkers: 6,
      },
      presentation: {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer",
      },
      autoCommand: "echo 'Redis VFS from kandelo-software'; ls -l /usr/local/bin/redis-server /etc/dinit.d/redis",
    };
  }

  return base;
}

function packageKey(pkg: GalleryPackageRequirement): string {
  return `${pkg.name}@${pkg.version}`;
}

function packageAvailable(
  index: Map<string, IndexPackageEntry>,
  requirement: GalleryPackageRequirement,
): boolean {
  const entry = index.get(packageKey(requirement));
  return entry?.binary.wasm32?.status === "success";
}

function archiveUrlFor(
  index: Map<string, IndexPackageEntry>,
  indexUrl: string,
  requirement: GalleryPackageRequirement | undefined,
): string | undefined {
  if (!requirement) return undefined;
  const archiveUrl = index.get(packageKey(requirement))?.binary.wasm32?.archive_url;
  if (!archiveUrl) return undefined;
  return new URL(archiveUrl, indexUrl).href;
}

function stripTomlComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inString = !inString;
    } else if (ch === "#" && !inString) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseIndexToml(text: string): Map<string, IndexPackageEntry> {
  const packages = new Map<string, IndexPackageEntry>();
  let currentPackage: IndexPackageEntry | undefined;
  let currentBinary: IndexBinaryEntry | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (line === "[[packages]]") {
      currentPackage = { binary: {} };
      currentBinary = undefined;
      continue;
    }

    const binaryMatch = line.match(/^\[packages\.binary\.([A-Za-z0-9_-]+)\]$/);
    if (binaryMatch && currentPackage) {
      currentBinary = {};
      currentPackage.binary[binaryMatch[1]] = currentBinary;
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment || !currentPackage) continue;

    const [, key, rawValue] = assignment;
    const value = parseTomlValue(rawValue);
    if (currentBinary) {
      currentBinary[key as keyof IndexBinaryEntry] = value;
    } else if (key === "name" || key === "version") {
      currentPackage[key] = value;
      if (currentPackage.name && currentPackage.version) {
        packages.set(`${currentPackage.name}@${currentPackage.version}`, currentPackage);
      }
    }
  }

  return packages;
}

async function fetchTextWithDevProxy(url: string): Promise<string> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } catch (error) {
    const isDevHost =
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "[::1]";
    if (!isDevHost) throw error;

    const response = await fetch(`/cors-proxy?url=${encodeURIComponent(url)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  }
}

async function fetchBytesWithDevProxy(url: string): Promise<Uint8Array> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    const isDevHost =
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "[::1]";
    if (!isDevHost) throw error;

    const response = await fetch(`/cors-proxy?url=${encodeURIComponent(url)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

function accentForSoftwareEntry(id: string): string {
  if (id.includes("python")) return "#3776ab";
  if (id.includes("perl")) return "#6c6aa8";
  if (id.includes("erlang")) return "#a90533";
  if (id.includes("redis")) return "#c52f24";
  return "#2f6f73";
}

function glyphForSoftwareEntry(entry: SoftwareGalleryEntry): string {
  const packageName = entry.packages[entry.packages.length - 1]?.name ?? entry.id;
  const parts = packageName.split(/[-_]/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toLowerCase();
  return packageName.slice(0, 3).toLowerCase();
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
    case "desktop-jwm":
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
