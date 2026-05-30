// Builds a LiveKernelHost over a real BrowserKernel for the Kandelo page.

import { BrowserKernel } from "@host/browser-kernel-host";
import {
  ensureServiceWorkerReady,
  initServiceWorkerBridge,
} from "../../../lib/init/service-worker-bridge";
import { HttpBridgeHost } from "../../../lib/http-bridge";
import { rewriteShellLazyFileUrls } from "../../../lib/init/shell-lazy-files";
import { resolveShellLazyArchiveUrl } from "../../../lib/init/lazy-archives";
import {
  WORDPRESS_CONFIG_INIT_SCRIPT,
  WORDPRESS_URL_MU_PLUGIN,
  renderWordPressConfig,
  wordpressConfigTemplate,
  type WordPressDatabaseKind,
} from "../../../lib/init/wordpress-runtime-config";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../../../host/src/vfs/image-helpers";
import { ABI_VERSION } from "../../../../../host/src/generated/abi";
import {
  NODE_LAZY_BINARY_SPEC,
  shellLazyPlaceholderUrl,
} from "../../../../../images/vfs/lib/init/shell-binaries";
import { decompress as decompressZstd } from "fzstd";
import {
  LiveKernelHost,
  type BootDescriptor,
  type DemoPresentation,
  type GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import {
  KANDELO_DEMO_CONFIG_PATH,
  genericDemoPresentation,
  parseKandeloDemoConfig,
  resolveDemoAssets,
  resolveDemoGuide,
  resolveDemoPresentation,
  type DemoAssetConfig,
  type KandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import {
  builtinDemoAssets,
  builtinDemoGuide,
  builtinDemoPresentation,
} from "../../../../../web-libs/kandelo-session/src/demo-guides";
import { PRESET_LIBRARY } from "../presets";
import {
  descriptorWithVfsImageUrl,
  demoIdFromVfsImageUrl,
  normalizeVfsImageUrl,
  titleFromVfsImageUrl,
  vfsImageUrlFromDescriptor,
} from "../url-state";

import kernelWasmUrl from "@kernel-wasm?url";
import shellVfsUrl from "@binaries/programs/wasm32/shell.vfs.zst?url";
import nodeWasmUrl from "@binaries/programs/wasm32/node.wasm?url";
import nodeVfsUrl from "@binaries/programs/wasm32/node-vfs.vfs.zst?url";
import nginxVfsUrl from "@binaries/programs/wasm32/nginx-vfs.vfs.zst?url";
import nginxPhpVfsUrl from "@binaries/programs/wasm32/nginx-php-vfs.vfs.zst?url";
import wordpressVfsUrl from "@binaries/programs/wasm32/wordpress.vfs.zst?url";
import lampVfsUrl from "@binaries/programs/wasm32/lamp.vfs.zst?url";
import dinitWasmUrl from "@binaries/programs/wasm32/dinit/dinit.wasm?url";
import dashWasmUrl from "@binaries/programs/wasm32/dash.wasm?url";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
import fbtestWasmUrl from "@binaries/programs/wasm32/fbtest.wasm?url";

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
const HTTP_PORT = 8080;
const PHP_FPM_PORT = 9000;
const MARIADB_PORT = 3306;
const ROOT_UID = 0;
const ROOT_GID = 0;
const ROOT_HOME = "/root";
const DEMO_UID = 1000;
const DEMO_GID = 1000;
const DEMO_USER = "user";
const DEMO_HOME = "/home/user";
const NODE_WORKDIR = "/work";

class BootSuperseded extends Error {
  constructor() {
    super("boot superseded");
  }
}

type LiveVfsImage =
  | "shell"
  | "node"
  | "nginx"
  | "nginx-php"
  | "wordpress"
  | "lamp";

type ShellProfile = "default" | "node";
type InitEnvProfile = "service" | "wordpress";

interface LiveProfileSpec {
  image: LiveVfsImage;
  shell?: ShellProfile;
  includeNodeUtility?: boolean;
  memoryPages?: number;
  maxVfsByteLength?: number;
  network?: boolean;
  features?: string[];
  autoCommand?: string;
  init?: {
    argv: string[];
    env?: InitEnvProfile;
    cwd?: string;
    programUrl?: string;
    uid?: number;
    gid?: number;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: { requiredPorts: number[] };
  };
}

const VFS_URLS: Record<LiveVfsImage, string> = {
  shell: shellVfsUrl,
  node: nodeVfsUrl,
  nginx: nginxVfsUrl,
  "nginx-php": nginxPhpVfsUrl,
  wordpress: wordpressVfsUrl,
  lamp: lampVfsUrl,
};

const DINIT_ARGV = ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"];

const LIVE_DEMO_IDS = [
  "shell",
  "node",
  "nginx",
  "nginx-php",
  "wordpress-sqlite",
  "wordpress-mariadb",
  "doom",
  "love",
  "bytepath",
  "snkrx",
] as const;

type LiveDemoId = typeof LIVE_DEMO_IDS[number];

const LIVE_PROFILE_SPECS: Record<LiveDemoId, LiveProfileSpec> = {
  shell: {
    image: "shell",
  },
  node: {
    image: "node",
    shell: "node",
    includeNodeUtility: true,
    memoryPages: 4096,
    network: true,
    features: ["js-workers"],
    autoCommand: [
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
      "&& npm --version",
    ].join(" "),
  },
  nginx: {
    image: "nginx",
    network: true,
    init: {
      argv: DINIT_ARGV,
      env: "service",
      programUrl: dinitWasmUrl,
      maxWorkers: 6,
      web: { requiredPorts: [HTTP_PORT] },
    },
  },
  "nginx-php": {
    image: "nginx-php",
    network: true,
    init: {
      argv: DINIT_ARGV,
      env: "service",
      programUrl: dinitWasmUrl,
      maxWorkers: 12,
      web: { requiredPorts: [HTTP_PORT] },
    },
  },
  "wordpress-sqlite": {
    image: "wordpress",
    network: true,
    init: {
      argv: DINIT_ARGV,
      env: "wordpress",
      programUrl: dinitWasmUrl,
      maxWorkers: 12,
      maxMemoryPages: 4096,
      web: { requiredPorts: [HTTP_PORT] },
    },
  },
  "wordpress-mariadb": {
    image: "lamp",
    // Keep this aligned with pages/lamp: MariaDB's Aria recovery can grow
    // beyond the 4096-page cap used by lighter PHP demos.
    memoryPages: 16384,
    maxVfsByteLength: 512 * 1024 * 1024,
    network: true,
    init: {
      argv: DINIT_ARGV,
      env: "wordpress",
      programUrl: dinitWasmUrl,
      maxWorkers: 24,
      maxMemoryPages: 16384,
      web: { requiredPorts: [HTTP_PORT, PHP_FPM_PORT, MARIADB_PORT] },
    },
  },
  doom: {
    image: "shell",
    features: ["framebuffer"],
  },
  love: {
    image: "shell",
    features: ["framebuffer"],
  },
  bytepath: {
    image: "shell",
    features: ["framebuffer"],
  },
  snkrx: {
    image: "shell",
    features: ["framebuffer"],
  },
};

const DEMO_ALIASES: Record<string, LiveDemoId> = {
  spidermonkey: "node",
  "spidermonkey-node": "node",
  wordpress: "wordpress-sqlite",
  lamp: "wordpress-mariadb",
};

const WEB_BOOT_LOG_DEMO_IDS = new Set<LiveDemoId>([
  "nginx",
  "nginx-php",
  "wordpress-sqlite",
  "wordpress-mariadb",
]);

interface LiveProfile {
  id: string;
  vfsUrl: string;
  software?: SoftwareProfile;
  descriptor: BootDescriptor;
  shell: ShellProfile;
  includeNodeUtility: boolean;
  maxVfsByteLength: number;
  autoCommand?: string;
  fallbackPresentation?: DemoPresentation;
  init?: {
    argv: string[];
    env?: string[];
    cwd?: string;
    programUrl?: string;
    uid?: number;
    gid?: number;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: { label: string; requiredPorts: number[] };
  };
  framebufferTest: boolean;
}

interface WebReadinessState {
  ready: boolean;
  probing: boolean;
}

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const COI_RELOAD_SESSION_KEY = "kandelo:coi-reload-attempted";
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
  `HOME=${DEMO_HOME}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  `USER=${DEMO_USER}`,
  `LOGNAME=${DEMO_USER}`,
  "PS1=kandelo$ ",
  `HISTFILE=${DEMO_HOME}/.bash_history`,
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

const NODE_SHELL_ENV: string[] = [
  `HOME=${DEMO_HOME}`,
  `PWD=${NODE_WORKDIR}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  `USER=${DEMO_USER}`,
  `LOGNAME=${DEMO_USER}`,
  "PS1=node$ ",
  `HISTFILE=${DEMO_HOME}/.bash_history`,
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
  "npm_config_cache=/tmp/.npm-cache",
  "npm_config_registry=http://proxy.local/",
  "npm_config_fund=false",
  "npm_config_audit=false",
  "npm_config_progress=false",
];

const SERVICE_ENV: string[] = [
  `HOME=${ROOT_HOME}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "USER=root",
  "LOGNAME=root",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

const SHELL_PROFILES: Record<ShellProfile, { env: string[]; cwd: string }> = {
  default: { env: SHELL_ENV, cwd: DEMO_HOME },
  node: { env: NODE_SHELL_ENV, cwd: NODE_WORKDIR },
};

const INIT_ENV_PROFILES: Record<InitEnvProfile, () => string[]> = {
  service: () => SERVICE_ENV,
  wordpress: () => [...SERVICE_ENV, `WP_APP_PATH=${APP_PATH}`, `WP_PROTO=${PROTO}`],
};

export type FbDemo = "none" | "test";

export interface CreateLiveHostOptions {
  demo?: string | null;
  vfsUrl?: string | null;
  fb?: FbDemo;
}

export async function createLiveHost(opts: CreateLiveHostOptions = {}): Promise<LiveKernelHost> {
  let currentKernel: BrowserKernel | null = null;
  let bootSeq = 0;
  let serviceWorkerReady: Promise<ServiceWorker> | null = null;
  const localGalleryItems = liveGalleryItems();

  const initialDescriptor = descriptorForBootQuery(opts.vfsUrl, opts.demo);
  const host = new LiveKernelHost({
    status: "booting",
    descriptor: initialDescriptor,
    galleryItems: localGalleryItems,
    applyBootDescriptor: async (desc, h) => {
      await startBoot(h, profileForDescriptor(desc, "none"), desc);
    },
  });

  const requireServiceWorker = (tick?: (msg: string) => void): Promise<ServiceWorker> => {
    if (!serviceWorkerReady) {
      tick?.("preparing service worker...");
      serviceWorkerReady = ensureServiceWorkerReady(SW_URL)
        .then(async (controller): Promise<ServiceWorker> => {
          if (window.crossOriginIsolated) {
            sessionStorage.removeItem(COI_RELOAD_SESSION_KEY);
            return controller;
          }

          if (sessionStorage.getItem(COI_RELOAD_SESSION_KEY) === "1") {
            sessionStorage.removeItem(COI_RELOAD_SESSION_KEY);
            throw new Error(
              "Kandelo could not enable cross-origin isolation after the service worker became active. " +
              "Reload the page; if this persists, clear site data for this site and check whether a browser extension is blocking service workers or COOP/COEP headers.",
            );
          }

          sessionStorage.setItem(COI_RELOAD_SESSION_KEY, "1");
          tick?.("service worker active; reloading to enable cross-origin isolation...");
          window.location.reload();
          return new Promise<never>((_, reject) => {
            window.setTimeout(() => {
              reject(new Error(
                "Kandelo requested a reload to enable cross-origin isolation, but the page did not unload.",
              ));
            }, 5_000);
          });
        })
        .catch((err) => {
          serviceWorkerReady = null;
          throw err;
        });
    }
    const ready = serviceWorkerReady;
    if (!ready) {
      throw new Error("Kandelo service worker readiness promise was not initialized.");
    }
    return ready;
  };

  void startBoot(host, profileForDescriptor(initialDescriptor, opts.fb), initialDescriptor);
  void requireServiceWorker()
    .then(() => refreshSoftwareGallery(host, localGalleryItems))
    .catch((err) => {
      console.warn("Service worker gate failed before gallery refresh:", err);
      host.setGalleryItems(localGalleryItems);
    });
  return host;

  async function startBoot(
    h: LiveKernelHost,
    profile: LiveProfile,
    descriptor: BootDescriptor,
  ): Promise<void> {
    const seq = ++bootSeq;
    const previousKernel = currentKernel;
    currentKernel = null;
    if (previousKernel) {
      await previousKernel.destroy().catch(() => {});
    }
    h.detachKernel();

    try {
      const kernel = await bootProfile(
        h,
        profile,
        descriptor,
        () => seq === bootSeq,
        requireServiceWorker,
      );
      if (seq !== bootSeq) {
        await kernel.destroy().catch(() => {});
        return;
      }
      currentKernel = kernel;
    } catch (err) {
      if (err instanceof BootSuperseded || seq !== bootSeq) return;
      currentKernel = null;
      h.detachKernel();
      showBootError(h, descriptor, err);
    }
  }
}

function showBootError(
  host: LiveKernelHost,
  descriptor: BootDescriptor,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  host.clearDmesg();
  host.setWebPreview(null);
  host.setDemoGuide(null);
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

function descriptorForBootQuery(
  vfsUrl: string | null | undefined,
  demo: string | null | undefined,
): BootDescriptor {
  const normalizedVfsUrl = normalizeVfsImageUrl(vfsUrl);
  if (!normalizedVfsUrl) return descriptorFor(normalizeDemoId(demo) ?? "shell");

  const liveId = liveDemoIdForVfsImageUrl(normalizedVfsUrl);
  const base = descriptorFor(liveId ?? "shell");
  return descriptorWithVfsImageUrl(base, normalizedVfsUrl, liveId
    ? {
      id: liveId,
      title: base.title,
      packages: base.packages,
    }
    : {
      id: demoIdFromVfsImageUrl(normalizedVfsUrl),
      title: titleFromVfsImageUrl(normalizedVfsUrl),
      packages: [],
    });
}

function profileForDescriptor(desc: BootDescriptor, fb?: FbDemo): LiveProfile {
  const vfsUrl = vfsImageUrlFromDescriptor(desc);
  if (!vfsUrl) return profileFor(desc.id, fb);

  const knownDemo = normalizeDemoId(desc.id);
  const profile = knownDemo
    ? profileFor(knownDemo, fb)
    : customVfsProfile(desc, vfsUrl, fb);

  return {
    ...profile,
    id: knownDemo ?? desc.id,
    vfsUrl,
    software: undefined,
    descriptor: desc,
  };
}

function customVfsProfile(
  desc: BootDescriptor,
  vfsUrl: string,
  fb?: FbDemo,
): LiveProfile {
  return {
    id: desc.id,
    vfsUrl,
    descriptor: desc,
    shell: "default",
    includeNodeUtility: false,
    maxVfsByteLength: 256 * 1024 * 1024,
    framebufferTest: fb === "test",
  };
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
      shell: "default",
      includeNodeUtility: false,
      maxVfsByteLength: 256 * 1024 * 1024,
      autoCommand: software.autoCommand,
      fallbackPresentation: software.presentation,
      init: software.init,
      framebufferTest: false,
    };
  }

  const normalized = normalizeDemoId(id) ?? "shell";
  const spec = LIVE_PROFILE_SPECS[normalized];
  const desc = descriptorFor(normalized);
  return {
    id: normalized,
    vfsUrl: VFS_URLS[spec.image],
    descriptor: desc,
    shell: spec.shell ?? "default",
    includeNodeUtility: spec.includeNodeUtility ?? false,
    maxVfsByteLength: spec.maxVfsByteLength ?? 256 * 1024 * 1024,
    autoCommand: spec.autoCommand,
    init: spec.init && {
      argv: spec.init.argv.slice(),
      env: initEnv(spec.init.env),
      cwd: spec.init.cwd,
      programUrl: spec.init.programUrl,
      uid: spec.init.uid,
      gid: spec.init.gid,
      maxWorkers: spec.init.maxWorkers,
      maxMemoryPages: spec.init.maxMemoryPages,
      web: spec.init.web && {
        label: desc.title,
        requiredPorts: spec.init.web.requiredPorts.slice(),
      },
    },
    framebufferTest: fb === "test",
  };
}

function initEnv(profile: InitEnvProfile | undefined): string[] | undefined {
  if (!profile) return undefined;
  return INIT_ENV_PROFILES[profile]();
}

function shellEnvFor(profile: ShellProfile): string[] {
  return SHELL_PROFILES[profile].env;
}

function shellCwdFor(profile: ShellProfile): string {
  return SHELL_PROFILES[profile].cwd;
}

function shellIdentityForProfile(profile: LiveProfile, boot?: BootDescriptor["boot"]): {
  env: string[];
  cwd: string;
  uid: number;
  gid: number;
} {
  let identity: { env: string[]; cwd: string; uid: number; gid: number };
  if (profile.software?.shellEnv) {
    identity = profile.init || profile.software.shellEnv === SERVICE_ENV
      ? { env: profile.software.shellEnv, cwd: ROOT_HOME, uid: ROOT_UID, gid: ROOT_GID }
      : { env: profile.software.shellEnv, cwd: DEMO_HOME, uid: DEMO_UID, gid: DEMO_GID };
  } else if (profile.shell === "node") {
    identity = { env: shellEnvFor(profile.shell), cwd: shellCwdFor(profile.shell), uid: DEMO_UID, gid: DEMO_GID };
  } else if (profile.init) {
    identity = { env: SERVICE_ENV, cwd: ROOT_HOME, uid: ROOT_UID, gid: ROOT_GID };
  } else {
    identity = { env: shellEnvFor(profile.shell), cwd: shellCwdFor(profile.shell), uid: DEMO_UID, gid: DEMO_GID };
  }
  if (!boot) return identity;
  return {
    env: mergeEnvArrays(identity.env, envArray(boot.env)),
    cwd: boot.cwd || identity.cwd,
    uid: boot.uid ?? identity.uid,
    gid: boot.gid ?? identity.gid,
  };
}

function envArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function mergeEnvArrays(base: string[], override: string[]): string[] {
  const out = new Map<string, string>();
  for (const kv of base) {
    const idx = kv.indexOf("=");
    if (idx > 0) out.set(kv.slice(0, idx), kv.slice(idx + 1));
  }
  for (const kv of override) {
    const idx = kv.indexOf("=");
    if (idx > 0) out.set(kv.slice(0, idx), kv.slice(idx + 1));
  }
  return Array.from(out, ([key, value]) => `${key}=${value}`);
}

function presentationForProfile(
  profile: LiveProfile,
  presentation: DemoPresentation,
): DemoPresentation {
  // Older released VFS images put Terminal before Syslog for web demos,
  // which briefly focuses a shell while dinit is still bringing services up.
  const demoId = normalizeDemoId(profile.id);
  if (
    !demoId ||
    !WEB_BOOT_LOG_DEMO_IDS.has(demoId) ||
    !profile.init?.web ||
    presentation.bootPrimary !== "syslog" ||
    presentation.runningPrimary[0] !== "web"
  ) {
    return presentation;
  }

  return {
    ...presentation,
    runningPrimary: [
      "web",
      "syslog",
      ...presentation.runningPrimary.filter((surface) =>
        surface !== "web" && surface !== "syslog"
      ),
    ],
  };
}

function reportInitError(
  host: LiveKernelHost,
  profile: LiveProfile,
  message: string,
  tick: (msg: string) => void,
): void {
  tick(message);
  if (profile.init?.web) {
    host.setWebPreview({
      label: profile.init.web.label,
      url: APP_PREFIX,
      status: "error",
      message,
    });
  }
  host.setStatus("error");
}

async function bootProfile(
  host: LiveKernelHost,
  profile: LiveProfile,
  requestedDescriptor: BootDescriptor,
  isCurrent: () => boolean,
  requireServiceWorker: (tick?: (msg: string) => void) => Promise<ServiceWorker>,
): Promise<BrowserKernel> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new BootSuperseded();
  };

  assertCurrent();
  host.clearDmesg();
  host.setWebPreview(null);
  host.setDemoGuide(null);
  const effectiveBoot = {
    ...profile.descriptor.boot,
    ...requestedDescriptor.boot,
    env: {
      ...profile.descriptor.boot.env,
      ...requestedDescriptor.boot.env,
    },
  };
  host.setDescriptor({
    ...profile.descriptor,
    title: requestedDescriptor.title || profile.descriptor.title,
    packages: requestedDescriptor.packages.length > 0
      ? requestedDescriptor.packages
      : profile.descriptor.packages,
    boot: effectiveBoot,
  });
  const genericPresentation = profile.fallbackPresentation ?? genericPresentationForProfile(profile);
  host.setPresentation(genericPresentation);
  host.setStatus("booting");

  let t = 0;
  const tick = (msg: string) => {
    if (!isCurrent()) return;
    host.pushDmesg({ t: (t += 50), level: "info", facility: "kandelo", msg });
  };

  await requireServiceWorker(tick);
  assertCurrent();

  tick("service worker active and cross-origin isolated");
  tick(`loading ${profile.id} profile...`);
  const [kernelBytes, vfsBytes, bashBytes, dashBytes, softwareBinaries] = await Promise.all([
    fetch(kernelWasmUrl).then(failOn("kernel.wasm")).then((r) => r.arrayBuffer()),
    loadVfsImageBytes(profile),
    fetch(bashWasmUrl).then(failOn("bash.wasm")).then((r) => r.arrayBuffer()),
    fetch(dashWasmUrl).then(failOn("dash.wasm")).then((r) => r.arrayBuffer()),
    loadSoftwareBinaries(profile.software),
  ]);
  assertCurrent();

  tick(`kernel: ${kib(kernelBytes.byteLength)} · vfs: ${kib(vfsBytes.byteLength)}`);
  MemoryFileSystem.assertImageKernelAbi(
    new Uint8Array(vfsBytes),
    ABI_VERSION,
    `${profile.id}.vfs.zst`,
  );
  const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsBytes), {
    maxByteLength: profile.maxVfsByteLength,
  });
  if (
    profile.id === "nginx-php" ||
    profile.id === "wordpress-sqlite" ||
    profile.id === "wordpress-mariadb"
  ) {
    writeVfsFile(memfs, "/etc/php-fpm.conf", PATCHED_PHP_FPM_CONF);
    ensureDirRecursive(memfs, "/var/cache/opcache");
    stripDinitServiceLogfiles(memfs, dinitServicesForProfile(profile.id));
  }
  if (profile.id === "wordpress-sqlite") {
    patchWordPressRuntimeConfig(memfs, "sqlite");
  } else if (profile.id === "wordpress-mariadb") {
    patchWordPressRuntimeConfig(memfs, "mariadb");
  }
  memfs.rewriteLazyArchiveUrls(resolveShellLazyArchiveUrl);
  rewriteShellLazyFileUrls(memfs);
  if (profile.includeNodeUtility) {
    rewriteNodeLazyFileUrl(memfs);
  }
  if (profile.init?.programUrl) {
    tick(`staging ${profile.init.argv[0]}...`);
    const bytes = await fetch(profile.init.programUrl)
      .then(failOn(profile.init.argv[0]))
      .then((r) => r.arrayBuffer());
    ensureDirRecursive(memfs, dirname(profile.init.argv[0]));
    writeVfsBinary(memfs, profile.init.argv[0], new Uint8Array(bytes), 0o755);
  }
  ensureDemoHomes(memfs);
  const imageConfig = readImageConfig(memfs);
  const rawPresentation = (imageConfig ? resolveDemoPresentation(imageConfig, profile.id) : null)
    ?? builtinDemoPresentation(profile.id)
    ?? genericPresentation;
  const presentation = presentationForProfile(profile, rawPresentation);
  host.setPresentation(presentation);
  const demoGuide = (imageConfig ? resolveDemoGuide(imageConfig, profile.id) : null)
    ?? builtinDemoGuide(profile.id);
  host.setDemoGuide(demoGuide);
  const imageAssets = imageConfig ? resolveDemoAssets(imageConfig, profile.id) : [];
  const assets = imageAssets.length > 0 ? imageAssets : builtinDemoAssets(profile.id);
  await stageConfiguredAssets(memfs, assets, tick);
  assertCurrent();

  tick("instantiating kernel...");
  const seenPorts = new Set<number>();
  let bridgeSent = false;
  const webReadiness: WebReadinessState = { ready: false, probing: false };
  let kernel: BrowserKernel | null = null;
  try {
    kernel = new BrowserKernel({
      memfs,
      maxWorkers: profile.init?.maxWorkers ?? 4,
      maxMemoryPages: profile.init?.maxMemoryPages,
      onStdout: (data) => tick(new TextDecoder().decode(data).trimEnd() || "stdout"),
      onStderr: (data) => tick(new TextDecoder().decode(data).trimEnd() || "stderr"),
      onProcessEvent: (event) => { if (isCurrent()) host.emitProcessEvent(event); },
      onListenTcp: (_pid, _fd, port) => {
        if (!isCurrent()) return;
        seenPorts.add(port);
        tick(`service listening on :${port}`);
        maybeMarkWebReady(host, profile, seenPorts, bridgeSent, webReadiness, tick);
      },
    });
    await kernel.init(kernelBytes);
    assertCurrent();

    tick("staging shell utilities...");
    stageShellUtilities(kernel, dashBytes, bashBytes);
    stageSoftwareBinaries(kernel, softwareBinaries);
    assertCurrent();
    host.attachKernel(kernel);
    const shellIdentity = shellIdentityForProfile(profile, effectiveBoot);
    host.setDefaultShell({
      programBytes: bashBytes,
      argv: ["bash", "-l", "-i"],
      env: shellIdentity.env,
      cwd: shellIdentity.cwd,
      uid: shellIdentity.uid,
      gid: shellIdentity.gid,
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
      assertCurrent();
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
      const initArgv = effectiveBoot.argv.length > 0 ? effectiveBoot.argv : profile.init.argv;
      const initBytes = readVfsFile(memfs, initArgv[0]);
      tick(`spawning ${initArgv[0]}...`);
      void kernel.spawn(initBytes, initArgv, {
        env: mergeEnvArrays(profile.init.env ?? [], envArray(effectiveBoot.env)),
        cwd: effectiveBoot.cwd || profile.init.cwd || ROOT_HOME,
        uid: effectiveBoot.uid ?? profile.init.uid ?? ROOT_UID,
        gid: effectiveBoot.gid ?? profile.init.gid ?? ROOT_GID,
      }).then(
        (code) => {
          if (!isCurrent()) return;
          reportInitError(
            host,
            profile,
            `${initArgv[0] ?? "init"} exited with code ${code}`,
            tick,
          );
        },
        (err) => {
          if (!isCurrent()) return;
          reportInitError(
            host,
            profile,
            `init failed: ${err instanceof Error ? err.message : String(err)}`,
            tick,
          );
        },
      );
    }

    host.setStatus("running");
    maybeMarkWebReady(host, profile, seenPorts, bridgeSent, webReadiness, tick);

    if (profile.framebufferTest) {
      void spawnLazy(kernel, "/usr/local/bin/fbtest", fbtestWasmUrl, ["fbtest"], tick);
    } else if (presentation?.autoCommand) {
      tick("starting configured command from bash...");
      void host.runShellCommand(presentation.autoCommand).catch((err) => {
        tick(`configured command failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } else if (profile.autoCommand) {
      tick(`running ${profile.autoCommand}...`);
      void host.runShellCommand(profile.autoCommand).catch((err) => {
        tick(`command failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    tick("ready");
    return kernel;
  } catch (err) {
    if (kernel && !isCurrent()) {
      await kernel.destroy().catch(() => {});
    }
    throw err;
  }
}

function genericPresentationForProfile(profile: LiveProfile): DemoPresentation {
  if (profile.init?.web) return genericDemoPresentation("web");
  if (profile.framebufferTest || profile.descriptor.runtime.features.includes("framebuffer")) {
    return genericDemoPresentation("framebuffer");
  }
  return genericDemoPresentation("terminal");
}

function stageShellUtilities(
  kernel: BrowserKernel,
  dashBytes: ArrayBuffer,
  bashBytes: ArrayBuffer,
): void {
  ensureDemoHomes(kernel.fs);
  ensureDirRecursive(kernel.fs, "/bin");
  ensureDirRecursive(kernel.fs, "/usr/bin");
  writeVfsBinary(kernel.fs, "/bin/dash", new Uint8Array(dashBytes), 0o755);
  try { kernel.fs.symlink("/bin/dash", "/bin/sh"); } catch { /* exists */ }
  try { kernel.fs.symlink("/bin/dash", "/usr/bin/dash"); } catch { /* exists */ }
  try { kernel.fs.symlink("/bin/dash", "/usr/bin/sh"); } catch { /* exists */ }
  writeVfsBinary(kernel.fs, "/bin/bash", new Uint8Array(bashBytes), 0o755);
  try { kernel.fs.symlink("/bin/bash", "/usr/bin/bash"); } catch { /* exists */ }
}

function rewriteNodeLazyFileUrl(fs: MemoryFileSystem): void {
  const placeholder = shellLazyPlaceholderUrl(NODE_LAZY_BINARY_SPEC);
  fs.rewriteLazyFileUrls((url) => {
    if (url !== placeholder) return url;
    return nodeWasmUrl;
  });
}

function ensureDemoHomes(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/home");
  ensureOwnedDir(fs, DEMO_HOME, 0o755, DEMO_UID, DEMO_GID);
  ensureOwnedDir(fs, ROOT_HOME, 0o700, ROOT_UID, ROOT_GID);
  ensureOwnedDir(fs, NODE_WORKDIR, 0o755, DEMO_UID, DEMO_GID);
}

function ensureOwnedDir(
  fs: MemoryFileSystem,
  path: string,
  mode: number,
  uid: number,
  gid: number,
): void {
  ensureDirRecursive(fs, path);
  fs.chown(path, uid, gid);
  fs.chmod(path, mode);
}

function patchWordPressRuntimeConfig(
  fs: MemoryFileSystem,
  kind: WordPressDatabaseKind,
): void {
  writeVfsFile(fs, "/etc/wp-config-init.sh", WORDPRESS_CONFIG_INIT_SCRIPT);
  writeVfsFile(fs, "/etc/wp-config-template.php", wordpressConfigTemplate(kind));
  writeVfsFile(fs, "/var/www/html/wp-config.php", renderWordPressConfig(kind, APP_PATH, PROTO));
  ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");
  writeVfsFile(
    fs,
    "/var/www/html/wp-content/mu-plugins/kandelo-url.php",
    WORDPRESS_URL_MU_PLUGIN,
  );
}

function dinitServicesForProfile(profileId: string): string[] {
  switch (profileId) {
    case "wordpress-mariadb":
      return ["mariadb-bootstrap", "mariadb", "wp-config-init", "php-fpm", "nginx"];
    case "wordpress-sqlite":
      return ["wp-config-init", "php-fpm", "nginx"];
    case "nginx-php":
      return ["php-fpm", "nginx"];
    default:
      return [];
  }
}

function stripDinitServiceLogfiles(fs: MemoryFileSystem, serviceNames: string[]): void {
  for (const serviceName of serviceNames) {
    const path = `/etc/dinit.d/${serviceName}`;
    const conf = readOptionalVfsText(fs, path);
    if (conf === null) continue;
    const patched = conf.replace(/^logfile\s*=.*(?:\r?\n|$)/gm, "");
    if (patched !== conf) writeVfsFile(fs, path, patched);
  }
}

async function loadVfsImageBytes(profile: LiveProfile): Promise<ArrayBuffer> {
  if (!profile.software) {
    return fetch(profile.vfsUrl).then(failOn(`${profile.id}.vfs.zst`)).then((r) => r.arrayBuffer());
  }
  const vfsImage = await loadArchiveArtifact(
    profile.software.vfsArchiveUrl,
    profile.software.vfsArtifactPath,
  );
  const copy = new Uint8Array(vfsImage.byteLength);
  copy.set(vfsImage);
  return copy.buffer;
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

async function spawnLazy(
  kernel: BrowserKernel,
  path: string,
  url: string,
  argv: string[],
  tick: (msg: string) => void,
): Promise<void> {
  try {
    tick(`fetching ${argv[0]}...`);
    const bytes = await fetch(url).then(failOn(argv[0])).then((r) => r.arrayBuffer());
    tick(`spawning ${argv[0]}...`);
    await kernel.spawn(bytes, argv, {
      env: SHELL_ENV,
      cwd: DEMO_HOME,
      uid: DEMO_UID,
      gid: DEMO_GID,
    });
    tick(`${argv[0]} exited`);
  } catch (err) {
    tick(`${argv[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function stageConfiguredAssets(
  fs: MemoryFileSystem,
  assets: DemoAssetConfig[],
  tick: (msg: string) => void,
): Promise<void> {
  for (const asset of assets) {
    tick(`staging ${asset.path}...`);
    const url = asset.devCorsProxy && import.meta.env.DEV
      ? `/cors-proxy?url=${encodeURIComponent(asset.url)}`
      : asset.url;
    const buffer: ArrayBuffer = await fetch(url).then(failOn(asset.path)).then((r) => r.arrayBuffer());
    const bytes = new Uint8Array(buffer);
    if (asset.sha256) {
      const digest = await sha256Hex(buffer);
      if (digest !== asset.sha256) {
        throw new Error(`${asset.path} sha256 mismatch: expected ${asset.sha256}, got ${digest}`);
      }
    }
    writeVfsBinary(fs, asset.path, bytes, asset.mode ?? 0o644);
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

function descriptorBootIdentity(
  id: string,
  software: SoftwareProfile | undefined,
  shell: ShellProfile,
): { env: string[]; cwd: string; uid: number; gid: number } {
  const serviceIds = new Set(["nginx", "nginx-php", "wordpress-sqlite", "wordpress-mariadb"]);
  if (software?.init || serviceIds.has(id) || software?.shellEnv === SERVICE_ENV) {
    return { env: software?.shellEnv ?? SERVICE_ENV, cwd: ROOT_HOME, uid: ROOT_UID, gid: ROOT_GID };
  }
  if (id === "node" || shell === "node") {
    return { env: shellEnvFor(shell), cwd: shellCwdFor(shell), uid: DEMO_UID, gid: DEMO_GID };
  }
  return { env: software?.shellEnv ?? shellEnvFor(shell), cwd: shellCwdFor(shell), uid: DEMO_UID, gid: DEMO_GID };
}

function envRecord(env: string[]): Record<string, string> {
  return Object.fromEntries(env.map((kv) => {
    const idx = kv.indexOf("=");
    return [kv.slice(0, idx), kv.slice(idx + 1)];
  }));
}

function descriptorFor(id: string): BootDescriptor {
  const software = SOFTWARE_PROFILES.get(id);
  const normalized = software ? "shell" : normalizeDemoId(id) ?? "shell";
  const spec = LIVE_PROFILE_SPECS[normalized];
  const item = software
    ? liveGalleryItems().find((p) => p.id === "shell")!
    : liveGalleryItems().find((p) => p.id === normalized) ?? liveGalleryItems()[0];
  const shell = spec.shell ?? "default";
  const network = software ? false : spec.network ?? false;
  const bootIdentity = descriptorBootIdentity(normalized, software, shell);
  return {
    version: 1,
    id: software?.id ?? item.id,
    title: software ? software.id.replace(/^kandelo-software-/, "") : item.title,
    base: software ? "kandelo:shell@abi11" : item.base,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: software ? 4096 : spec.memoryPages ?? 2048,
      features: [
        "shared-array-buffer",
        "pty",
        ...(spec.features ?? []),
        ...(network ? ["tcp-bridge"] : []),
      ],
      time: "real",
    },
    packages: software ? [] : item.packages,
    mounts: [
      { path: "/", source: "image", ref: `${software?.id ?? item.id}.vfs@local`, readonly: false },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: software?.init ? software.init.argv : software ? ["bash", "-l", "-i"] : item.bootCommand,
      cwd: bootIdentity.cwd,
      env: envRecord(bootIdentity.env),
      uid: bootIdentity.uid,
      gid: bootIdentity.gid,
    },
    caps: { network },
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
    vfsImageUrl: vfsImageUrlForPreset(p.id),
    accent: p.accent,
    glyph: p.glyph,
    estimatedUrlBytes: p.estimatedUrlBytes,
  }));
}

function vfsImageUrlForPreset(id: string): string | undefined {
  const liveId = normalizeDemoId(id);
  if (!liveId) return undefined;
  const url = new URL(VFS_URLS[LIVE_PROFILE_SPECS[liveId].image], location.href);
  url.hash = liveId;
  return url.href;
}

function liveDemoIdForVfsImageUrl(vfsUrl: string): LiveDemoId | null {
  const normalized = normalizeVfsImageUrl(vfsUrl);
  if (!normalized) return null;

  const url = new URL(normalized);
  const hashId = url.hash.slice(1);
  const baseUrl = withoutHash(url);
  if (isLiveDemoId(hashId) && baseUrl === profileVfsBaseUrl(hashId)) {
    return hashId;
  }

  const matches = LIVE_DEMO_IDS.filter((id) => baseUrl === profileVfsBaseUrl(id));
  if (matches.length === 1) return matches[0];
  return matches.find((id) => id !== "doom") ?? null;
}

function profileVfsBaseUrl(id: LiveDemoId): string {
  return withoutHash(new URL(VFS_URLS[LIVE_PROFILE_SPECS[id].image], location.href));
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

async function refreshSoftwareGallery(
  host: LiveKernelHost,
  localItems: GalleryItem[],
): Promise<void> {
  try {
    const softwareItems = await loadKandeloSoftwareGalleryItems();
    host.setGalleryItems([...localItems, ...softwareItems]);
  } catch (err) {
    console.warn("Could not load kandelo-software gallery entries:", err);
    host.setGalleryItems(localItems);
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
  if (!id) return null;
  const normalized = DEMO_ALIASES[id] ?? id;
  return isLiveDemoId(normalized) ? normalized : null;
}

function isLiveDemoId(id: string): id is LiveDemoId {
  return Object.hasOwn(LIVE_PROFILE_SPECS, id);
}

function readImageConfig(fs: MemoryFileSystem): KandeloDemoConfig | null {
  const json = readOptionalVfsText(fs, KANDELO_DEMO_CONFIG_PATH);
  if (json === null) return null;
  const config = parseKandeloDemoConfig(json);
  if (!config) {
    throw new Error(`VFS image has unsupported ${KANDELO_DEMO_CONFIG_PATH} version`);
  }
  return config;
}

function readOptionalVfsText(fs: MemoryFileSystem, path: string): string | null {
  try {
    return new TextDecoder().decode(new Uint8Array(readVfsFile(fs, path)));
  } catch (err) {
    if (isMissingVfsPath(err)) return null;
    throw err;
  }
}

function isMissingVfsPath(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === -2 || code === "ENOENT") return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/\bENOENT\b/.test(message)) return true;
  return message.includes("No such file or directory");
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

function failOn(label: string): (r: Response) => Response {
  return (r) => {
    if (!r.ok) throw new Error(`fetch failed for ${label}: ${r.status} ${r.statusText}`);
    return r;
  };
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KiB`;
}
