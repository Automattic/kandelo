// Builds a LiveKernelHost over a real BrowserKernel for the Kandelo page.

import { BrowserKernel } from "@host/browser-kernel-host";
import { BrowserInputSource } from "../../../../../host/src/input/browser-input-source";
import { BrowserAudioDriver } from "../../../../../host/src/audio/browser-audio-driver";
import {
  instrumentAudioDriver,
  type InstrumentedAudioDriver,
} from "../../../../../host/src/audio/instrumented-audio-driver";
import wpkAudioWorkletUrl from "../../../../../host/src/audio/wpk-audio-worklet.js?url";
import { ensureServiceWorkerReady } from "../../../lib/init/service-worker-bridge";
import { setupServiceWorkerFetchBridge } from "../../../lib/init/sw-bridge-fetch";
import { rewriteShellLazyFileUrls } from "../../../lib/init/shell-lazy-files";
import { resolveShellLazyArchiveUrl } from "../../../lib/init/lazy-archives";
import {
  WORDPRESS_CONFIG_INIT_SCRIPT,
  WORDPRESS_URL_MU_PLUGIN,
  patchWordPressMysqliPersistentSource,
  renderWordPressConfig,
  wordpressConfigTemplate,
  type WordPressDatabaseKind,
} from "../../../lib/init/wordpress-runtime-config";
import { MYSQL_BENCHMARK_PHP } from "../../../lib/init/mysql-benchmark";
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
import sdl2PlasmaFragSrc from "../../../../../programs/sdl2/presets/image/plasma.frag?raw";
import sdl2AudioBarsFragSrc from "../../../../../programs/sdl2/presets/image/audio_bars.frag?raw";
import sdl2TunnelwispFragSrc from "../../../../../programs/sdl2/presets/image/tunnelwisp.frag?raw";
import sdl2SoundSineFragSrc from "../../../../../programs/sdl2/presets/sound/sine.frag?raw";
import sdl2SoundTunnelwispFragSrc from "../../../../../programs/sdl2/presets/sound/tunnelwisp.frag?raw";
import sdl2SoundFmBellFragSrc from "../../../../../programs/sdl2/presets/sound/fm_bell.frag?raw";
import sdl2SoundNoiseSweepFragSrc from "../../../../../programs/sdl2/presets/sound/noise_sweep.frag?raw";
import sdl2SoundChordFragSrc from "../../../../../programs/sdl2/presets/sound/chord.frag?raw";

const DEFAULT_SOFTWARE_MANIFEST_URLS = [
  `https://github.com/brandonpayton/kandelo-software/releases/download/binaries-abi-v${ABI_VERSION}/gallery.json`,
];

const OPTIONAL_BINARY_URLS = {
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/fbtest.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/fbtest.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/modeset.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/modeset.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/sdl2.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/sdl2.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/wlcompositor.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/wlcompositor.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/wlterm.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/wlterm.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/wlclock.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/wlclock.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/wlpaint.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/wlpaint.wasm", {
    query: "?url", import: "default",
  }),
} as Record<string, () => Promise<string>>;

async function optionalBinaryUrl(relPaths: string[], label: string): Promise<string> {
  for (const relPath of relPaths) {
    const loader = OPTIONAL_BINARY_URLS[relPath];
    if (loader) return loader();
  }
  throw new Error(`${label} is not built. Run: ./run.sh build programs`);
}

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

type SoftwareIndex = {
  abiVersion?: number;
  packages: Map<string, IndexPackageEntry>;
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
const MARIADB_SOCKET_PATH = "/tmp/mysql.sock";
const MARIADB_READY_SERVICE = "mariadb-ready";
const MARIADB_READY_SCRIPT_PATH = "/usr/local/bin/mariadb-ready";
const ROOT_UID = 0;
const ROOT_GID = 0;
const ROOT_HOME = "/root";
const PHP_FPM_UID = 65534;
const PHP_FPM_GID = 65534;
const MYSQL_UID = 101;
const MYSQL_GID = 101;
const DEMO_UID = 1000;
const DEMO_GID = 1000;
const DEMO_USER = "user";
const DEMO_HOME = "/home/user";
const NODE_WORKDIR = "/work";
const DINITCTL_PATH = "/sbin/dinitctl";
const DINITCTL_SOCKET_PATH = "/tmp/dinitctl";
const DINIT_STARTING_POLL_INTERVAL_MS = 2_000;
const DINIT_STARTING_POLL_TIMEOUT_MS = 180_000;
const DINITCTL_LIST_TIMEOUT_MS = 2_000;
const DINIT_STARTING_POLL_FAILURE_LIMIT = 3;

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
  autoCommand?: string;
  memoryPages?: number;
  maxVfsByteLength?: number;
  network?: boolean;
  features?: string[];
  init?: {
    argv: string[];
    env?: InitEnvProfile;
    cwd?: string;
    programUrl?: string;
    uid?: number;
    gid?: number;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: {
      requiredPorts: number[];
      requiredServices?: string[];
      probeHttp?: boolean;
    };
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

const DINIT_NGINX_ARGV = ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "nginx"];

const LIVE_DEMO_IDS = [
  "shell",
  "node",
  "nginx",
  "nginx-php",
  "wordpress-sqlite",
  "wordpress-mariadb",
  "doom",
  "modeset",
  "sdl2",
  "wayland",
] as const;

type LiveDemoId = typeof LIVE_DEMO_IDS[number];

async function settleAfterKernelDestroy(): Promise<void> {
  const ua = navigator.userAgent;
  const isWebKitLikeBrowser = /AppleWebKit/i.test(ua)
    && !/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)/i.test(ua);
  if (!isWebKitLikeBrowser) return;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));
}

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
  },
  nginx: {
    image: "nginx",
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
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
      argv: DINIT_NGINX_ARGV,
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
      argv: DINIT_NGINX_ARGV,
      env: "wordpress",
      programUrl: dinitWasmUrl,
      maxWorkers: 12,
      maxMemoryPages: 4096,
      web: { requiredPorts: [HTTP_PORT] },
    },
  },
  "wordpress-mariadb": {
    image: "lamp",
    // MariaDB's Aria recovery can grow beyond the 4096-page cap used by
    // lighter PHP presets.
    memoryPages: 16384,
    maxVfsByteLength: 768 * 1024 * 1024,
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
      env: "wordpress",
      programUrl: dinitWasmUrl,
      maxWorkers: 24,
      maxMemoryPages: 16384,
      web: {
        requiredPorts: [HTTP_PORT, PHP_FPM_PORT],
        requiredServices: ["mariadb-ready", "php-fpm", "nginx"],
        probeHttp: false,
      },
    },
  },
  doom: {
    image: "shell",
    features: ["framebuffer"],
  },
  modeset: {
    image: "shell",
    features: ["kms"],
  },
  sdl2: {
    image: "shell",
    features: ["kms"],
  },
  wayland: {
    image: "shell",
    features: ["kms"],
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
    web?: {
      label: string;
      requiredPorts: number[];
      requiredServices?: string[];
      probeHttp: boolean;
    };
  };
  framebufferTest: boolean;
  /**
   * Spawn the `modeset` binary on top of the booted shell so the Modeset
   * pane has a process driving DRM master + PAGE_FLIP. Mirrors the
   * `framebufferTest` path for /dev/fb0 demos.
   */
  modesetDemo: boolean;
  /**
   * Stage the SDL2 playground binary at `/usr/local/bin/sdl2`,
   * attach a `BrowserInputSource` + `BrowserAudioDriver`, then run
   * it from bash. The binary opens /dev/dri/card0 (KMS) for video,
   * ALSA for audio, and /dev/input/event{0,1} for keyboard; the
   * Modeset pane picks up PAGE_FLIP. It is the long-running
   * split-pane GLSL editor — a code pane that live-recompiles a
   * fragment shader rendered alongside it — and runs until ESC quits.
   */
  sdl2Demo: boolean;
  /**
   * Stage the Wayland stack — `wlcompositor` (a wl_shm/xdg_shell server
   * that drives /dev/dri/card0 via KMS) plus its `wlterm` client (a
   * libkwl VT100 terminal running a forkpty'd dash) — attach a
   * `BrowserInputSource`, then spawn the compositor and the terminal.
   * The compositor composites the client to card0; the Modeset pane
   * picks up PAGE_FLIP, and keyboard input routes through the compositor
   * to the shell. Runs until the terminal's shell exits.
   */
  waylandDemo: boolean;
}

interface WebReadinessState {
  ready: boolean;
  probing: boolean;
}

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const DEV_CORS_PROXY_PATH = import.meta.env.BASE_URL + "__kandelo_cors_proxy";
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
      await settleAfterKernelDestroy();
    }
    h.detachKernel();
    // Wayland demo: present the Modeset pane's canvas through the vblank
    // pump's WebGL2 scanout presenter (texture upload, shader-side
    // swizzle, GPU scaling at display resolution). In the browser the
    // compositor's GLES probe normally succeeds and its GL context then
    // claims the canvas for GPU compositing as the steady state — the
    // presenter covers boot (before the claim) and the permanent CPU
    // fallback if the probe or a GL frame fails. GL demos (modeset.c,
    // sdl2) keep the webgl2 default — the GL bridge claims their canvas on
    // eglCreateContext, and the pump never touches it.
    h.setKmsDisplayMode(profile.waylandDemo ? "webgl2-scanout" : null);
    const bootStartedAt = performance.now();

    try {
      const kernel = await bootProfile(
        h,
        profile,
        descriptor,
        bootStartedAt,
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
      showBootError(h, descriptor, err, bootStartedAt);
    }
  }
}

function showBootError(
  host: LiveKernelHost,
  descriptor: BootDescriptor,
  err: unknown,
  bootStartedAt: number,
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
    t: bootElapsedMs(bootStartedAt),
    level: "err",
    facility: "kandelo",
    msg: `Failed to boot ${descriptor.title || descriptor.id}`,
  });
  host.pushDmesg({
    t: bootElapsedMs(bootStartedAt),
    level: "err",
    facility: "kandelo",
    msg: message,
  });
  if (SOFTWARE_PROFILES.has(descriptor.id)) {
    host.pushDmesg({
      t: bootElapsedMs(bootStartedAt),
      level: "warn",
      facility: "kandelo-software",
      msg: "The third-party gallery entry may be temporarily unavailable or its release artifact may have been deleted.",
    });
  }
  host.setStatus("error");
}

function bootElapsedMs(bootStartedAt: number): number {
  return Math.max(0, performance.now() - bootStartedAt);
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
    modesetDemo: false,
    sdl2Demo: false,
    waylandDemo: false,
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
      modesetDemo: false,
      sdl2Demo: false,
      waylandDemo: false,
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
        requiredServices: spec.init.web.requiredServices?.slice(),
        probeHttp: spec.init.web.probeHttp ?? true,
      },
    },
    framebufferTest: fb === "test",
    modesetDemo: normalized === "modeset",
    sdl2Demo: normalized === "sdl2",
    waylandDemo: normalized === "wayland",
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
  if (profile.shell === "node") {
    identity = { env: shellEnvFor(profile.shell), cwd: shellCwdFor(profile.shell), uid: DEMO_UID, gid: DEMO_GID };
  } else if (profile.software?.shellEnv && profile.software.shellEnv !== SERVICE_ENV) {
    identity = { env: profile.software.shellEnv, cwd: DEMO_HOME, uid: DEMO_UID, gid: DEMO_GID };
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

class DinitBootStatusTracker {
  private completedServices = new Set<string>();
  private startingServices = new Set<string>();
  private outputTails = new Map<string, string>();

  constructor(
    private tick: (msg: string) => void,
    private onServiceCompleted?: (serviceName: string) => void,
  ) {}

  observeProcessOutput(text: string, stream: string): void {
    if (!text) return;
    const normalized = `${this.outputTails.get(stream) ?? ""}${text}`.replace(/\r/g, "");
    const lines = normalized.split("\n");
    this.outputTails.set(stream, text.endsWith("\n") ? "" : lines.pop() ?? "");
    for (const line of lines) {
      const serviceName = parseDinitCompletionLine(line);
      if (!serviceName) continue;
      if (this.completedServices.has(serviceName)) continue;
      this.emitStarting(serviceName);
      this.completedServices.add(serviceName);
      this.onServiceCompleted?.(serviceName);
    }
  }

  emitStartingFromList(output: string): void {
    for (const serviceName of parseDinitStartingServices(output)) {
      this.emitStarting(serviceName);
    }
  }

  hasCompleted(serviceName: string): boolean {
    return this.completedServices.has(serviceName);
  }

  private emitStarting(serviceName: string): void {
    if (this.completedServices.has(serviceName)) return;
    if (this.startingServices.has(serviceName)) return;
    this.startingServices.add(serviceName);
    this.tick(`Starting ${serviceName}...`);
  }
}

function parseDinitCompletionLine(line: string): string | null {
  const match = stripAnsi(line).trim().match(/^\[(?:\s*OK\s*|FAILED)\]\s+(.+)$/);
  return match?.[1]?.trim() || null;
}

function parseDinitStartingServices(output: string): string[] {
  const services: string[] = [];
  for (const line of stripAnsi(output).replace(/\r/g, "").split("\n")) {
    const match = line.match(/^\[[^\]]*<<[^\]]*\]\s+(\S+)/);
    if (match?.[1]) services.push(match[1]);
  }
  return services;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function startDinitStartingPoller(options: {
  kernel: BrowserKernel;
  memfs: MemoryFileSystem;
  tracker: DinitBootStatusTracker;
  isCurrent: () => boolean;
  shouldStop?: () => boolean;
}): () => void {
  if (!vfsPathExists(options.memfs, DINITCTL_PATH)) return () => {};

  let stopped = false;
  void (async () => {
    const deadline = Date.now() + DINIT_STARTING_POLL_TIMEOUT_MS;
    let failures = 0;
    while (!stopped && options.isCurrent() && Date.now() < deadline) {
      if (options.shouldStop?.()) break;
      if (!vfsPathExists(options.memfs, DINITCTL_SOCKET_PATH)) {
        await delay(DINIT_STARTING_POLL_INTERVAL_MS);
        continue;
      }
      let output: string | null = null;
      try {
        output = await readDinitctlList(options.kernel);
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= DINIT_STARTING_POLL_FAILURE_LIMIT) break;
      }
      if (stopped || !options.isCurrent()) break;
      if (output !== null) options.tracker.emitStartingFromList(output);
      await delay(DINIT_STARTING_POLL_INTERVAL_MS);
    }
  })();

  return () => {
    stopped = true;
  };
}

async function readDinitctlList(kernel: BrowserKernel): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  const { pid, exit } = await kernel.spawnFromVfs(DINITCTL_PATH, [
    DINITCTL_PATH,
    "-p",
    DINITCTL_SOCKET_PATH,
    "list",
  ], {
    cwd: "/",
    uid: ROOT_UID,
    gid: ROOT_GID,
    pty: true,
  });
  kernel.onPtyOutput(pid, (data) => {
    chunks.push(data.slice());
  });

  try {
    const code = await Promise.race([
      exit,
      delay(DINITCTL_LIST_TIMEOUT_MS).then(() => null),
    ]);
    if (code === null) {
      await kernel.terminateProcess(pid).catch(() => {});
      return null;
    }
    await delay(0);
    if (code !== 0 || chunks.length === 0) return null;
    return decodeChunks(chunks);
  } finally {
    kernel.clearPtyOutput(pid);
  }
}

function decodeChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function vfsPathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function bootProfile(
  host: LiveKernelHost,
  profile: LiveProfile,
  requestedDescriptor: BootDescriptor,
  bootStartedAt: number,
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

  const tick = (msg: string) => {
    if (!isCurrent()) return;
    host.pushDmesg({ t: bootElapsedMs(bootStartedAt), level: "info", facility: "kandelo", msg });
  };
  let maybeUpdateWebReadiness = () => {};
  const dinitBootTracker = new DinitBootStatusTracker(tick, () => {
    maybeUpdateWebReadiness();
  });
  const recordProcessOutput = (data: Uint8Array, fallback: string) => {
    const text = new TextDecoder().decode(data);
    dinitBootTracker.observeProcessOutput(text, fallback);
    tick(text.trimEnd() || fallback);
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
  }
  if (profile.id === "wordpress-sqlite") {
    patchWordPressRuntimeConfig(memfs, "sqlite");
  } else if (profile.id === "wordpress-mariadb") {
    patchMariaDbUnixSocketConfig(memfs);
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
  maybeUpdateWebReadiness = () => {
    maybeMarkWebReady(
      host,
      profile,
      seenPorts,
      bridgeSent,
      webReadiness,
      dinitBootTracker,
      tick,
      isCurrent,
    );
  };
  let kernel: BrowserKernel | null = null;
  let stopDinitStartingPoller = () => {};
  try {
    kernel = new BrowserKernel({
      memfs,
      maxWorkers: profile.init?.maxWorkers ?? 4,
      maxMemoryPages: profile.init?.maxMemoryPages,
      onStdout: (data) => recordProcessOutput(data, "stdout"),
      onStderr: (data) => recordProcessOutput(data, "stderr"),
      onProcessEvent: (event) => { if (isCurrent()) host.emitProcessEvent(event); },
      onListenTcp: (pid, _fd, port) => {
        if (!isCurrent()) return;
        seenPorts.add(port);
        void reportTcpListener(kernel!, pid, port, tick, isCurrent)
          .finally(() => {
            maybeUpdateWebReadiness();
          });
      },
    });
    await kernel.init(kernelBytes);
    assertCurrent();

    tick("staging shell utilities...");
    stageShellUtilities(kernel, dashBytes, bashBytes);
    stageSoftwareBinaries(kernel, softwareBinaries);
    assertCurrent();
    host.attachKernel(kernel);
    const shellIdentity = shellIdentityForProfile(profile, profile.init ? undefined : effectiveBoot);
    host.setDefaultShell({
      programPath: "/bin/bash",
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
        message: "Waiting for services",
      });
      try {
        await setupServiceWorkerFetchBridge(SW_URL, APP_PREFIX, kernel, HTTP_PORT, {
          timeoutMs: 90_000,
          debugLog: (line) => tick(line),
        });
        assertCurrent();
        bridgeSent = true;
        maybeUpdateWebReadiness();
      } catch (err) {
        if (!isCurrent()) throw err;
        const message = err instanceof Error ? err.message : String(err);
        tick(`HTTP bridge failed: ${message}`);
        host.setWebPreview({
          label: profile.init.web.label,
          url: APP_PREFIX,
          status: "error",
          message: "HTTP bridge unavailable",
        });
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
        onStarted: () => {
          stopDinitStartingPoller = startDinitStartingPoller({
            kernel: kernel!,
            memfs,
            tracker: dinitBootTracker,
            isCurrent,
            shouldStop: () => webReadiness.ready,
          });
        },
      }).then(
        (code) => {
          stopDinitStartingPoller();
          stopDinitStartingPoller = () => {};
          if (!isCurrent()) return;
          reportInitError(
            host,
            profile,
            `${initArgv[0] ?? "init"} exited with code ${code}`,
            tick,
          );
        },
        (err) => {
          stopDinitStartingPoller();
          stopDinitStartingPoller = () => {};
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

    maybeUpdateWebReadiness();

    if (profile.framebufferTest) {
      const fbtestWasmUrl = await optionalBinaryUrl([
        "../../../../../local-binaries/programs/wasm32/fbtest.wasm",
        "../../../../../binaries/programs/wasm32/fbtest.wasm",
      ], "fbtest.wasm");
      void spawnLazy(kernel, "/usr/local/bin/fbtest", fbtestWasmUrl, ["fbtest"], tick);
    } else if (profile.modesetDemo) {
      const modesetWasmUrl = await optionalBinaryUrl([
        "../../../../../local-binaries/programs/wasm32/modeset.wasm",
        "../../../../../binaries/programs/wasm32/modeset.wasm",
      ], "modeset.wasm");
      void spawnLazy(kernel, "/usr/local/bin/modeset", modesetWasmUrl, ["modeset"], tick);
    } else if (profile.sdl2Demo) {
      // The SDL2 playground binary needs the input source attached
      // so ESC reaches SDL_evdev, the audio driver attached so its
      // 440 Hz tone is audible, and the binary staged into the VFS
      // before bash runs it. At Phase 0 the demo self-terminates
      // after ~5 s (or earlier on ESC); the Modeset pane picks up
      // PAGE_FLIP via the kernel's KMS canvas bridge.
      const kernelForSdl2 = kernel;
      void (async () => {
        let audioDriver: InstrumentedAudioDriver | null = null;
        try {
          const sdl2WasmUrl = await optionalBinaryUrl([
            "../../../../../local-binaries/programs/wasm32/sdl2.wasm",
            "../../../../../binaries/programs/wasm32/sdl2.wasm",
          ], "sdl2.wasm");
          tick("staging sdl2 binary...");
          const bytes = await fetch(sdl2WasmUrl)
            .then(failOn("sdl2.wasm"))
            .then((r) => r.arrayBuffer());
          ensureDirRecursive(kernelForSdl2.fs, "/usr/local/bin");
          writeVfsBinary(
            kernelForSdl2.fs,
            "/usr/local/bin/sdl2",
            new Uint8Array(bytes),
            0o755,
          );
          // Phase 3 shader-source chain: the playground reads
          //   1. /home/shaders/image/current.frag   (user-editable)
          //   2. /usr/share/shaders/image/plasma.frag   (preset)
          //   3. built-in PLASMA_SRC fallback
          // Stage (2) so the browser path exercises the VFS leg, and
          // mkdir (1)'s parent so the user can drop a current.frag
          // via terminal/host VFS without first creating dirs.
          tick("staging shader presets...");
          ensureDirRecursive(kernelForSdl2.fs, "/usr/share/shaders/image");
          ensureDirRecursive(kernelForSdl2.fs, "/home/shaders/image");
          writeVfsFile(
            kernelForSdl2.fs,
            "/usr/share/shaders/image/plasma.frag",
            sdl2PlasmaFragSrc,
          );
          // Phase 5 FFT-bars preset: visualizes the iAudio spectrum
          // uploaded each frame from the chip synth. Stage it so the
          // user can load it from the editor.
          writeVfsFile(
            kernelForSdl2.fs,
            "/usr/share/shaders/image/audio_bars.frag",
            sdl2AudioBarsFragSrc,
          );
          // Phase 7 boot default: "Trailing the Twinkling Tunnelwisp"
          // (CC0, ported from shadertoy.com/view/WfcGWj). main.c's image
          // preset leg resolves this instead of plasma, so it is what the
          // user sees on first boot, paired with the Tunnelwisp track
          // staged below.
          writeVfsFile(
            kernelForSdl2.fs,
            "/usr/share/shaders/image/tunnelwisp.frag",
            sdl2TunnelwispFragSrc,
          );
          // Phase 6 sound-shader presets: mainSound bodies rendered to an
          // FBO, read back, and played through ALSA (F2 in the playground
          // switches the editor to the sound shader). Phase 7's
          // tunnelwisp.frag is the boot default sound source (activated
          // immediately, not on first F2); the others are loadable presets.
          ensureDirRecursive(kernelForSdl2.fs, "/usr/share/shaders/sound");
          ensureDirRecursive(kernelForSdl2.fs, "/home/shaders/sound");
          writeVfsFile(
            kernelForSdl2.fs,
            "/usr/share/shaders/sound/tunnelwisp.frag",
            sdl2SoundTunnelwispFragSrc,
          );
          writeVfsFile(
            kernelForSdl2.fs,
            "/usr/share/shaders/sound/sine.frag",
            sdl2SoundSineFragSrc,
          );
          writeVfsFile(
            kernelForSdl2.fs,
            "/usr/share/shaders/sound/fm_bell.frag",
            sdl2SoundFmBellFragSrc,
          );
          writeVfsFile(
            kernelForSdl2.fs,
            "/usr/share/shaders/sound/noise_sweep.frag",
            sdl2SoundNoiseSweepFragSrc,
          );
          writeVfsFile(
            kernelForSdl2.fs,
            "/usr/share/shaders/sound/chord.frag",
            sdl2SoundChordFragSrc,
          );
          tick("attaching input source...");
          // Keyboard goes through BrowserInputSource (ESC, typing → evdev
          // event0). The POINTER is owned by the Modeset pane, which
          // feeds framebuffer-positioned pointer events into evdev event1
          // via `sendPointerAbs` — so we disable this source's pointer
          // feed (its window-relative coordinates would fight the pane's
          // correct one). We keep WHEEL enabled (wheel: true): REL_WHEEL
          // carries no absolute coordinates, so it doesn't fight the pane,
          // and it drives the editor's mouse-scroll (SDL_MOUSEWHEEL).
          // The dims set EVIOCGABS's ABS_X/Y.maximum; SDL
          // treats event1 as a relative mouse (it advertises REL_X/Y) and
          // clamps the cursor to the window rather than this range, but we
          // still pass the framebuffer size (1920×1080, matching
          // host/src/dri/kms-registry.ts and the Modeset canvas) so any
          // ABS-aware consumer sees sane bounds.
          const SDL2_FB_W = 1920;
          const SDL2_FB_H = 1080;
          kernelForSdl2.attachInputSource(
            new BrowserInputSource(window, { pointer: false, wheel: true }),
            { width: SDL2_FB_W, height: SDL2_FB_H },
          );
          tick("attaching audio driver...");
          audioDriver = createInstrumentedAudioDriver();
          await kernelForSdl2.attachAudioDriver(audioDriver, {
            pcmId: 0,
            sampleRate: 48_000,
            channels: 2,
            periodFrames: 1024,
            ringBytes: 64 * 1024,
          });
          tick("running sdl2...");
          await host.runShellCommand("/usr/local/bin/sdl2");
          tick("sdl2 exited");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          tick(`sdl2 failed: ${msg}`);
        } finally {
          audioDriver?.stop(0);
        }
      })();
    } else if (profile.waylandDemo) {
      // The Wayland desktop needs: all four binaries staged into the VFS,
      // the input source attached so keystrokes reach the compositor's
      // libinput (event0) and route through to the focused window, the
      // compositor spawned as the KMS master (it opens /dev/dri/card0 and
      // drives PAGE_FLIP — the Modeset pane picks it up), the two desktop
      // clients (wlclock, wlpaint) spawned as floating windows, and
      // finally the wlterm client run from bash. dash is already staged by
      // stageShellUtilities, so wlterm's forkpty'd execvp("dash") resolves
      // via PATH. The demo runs until the terminal's shell exits.
      const kernelForWayland = kernel;
      void (async () => {
        try {
          const compositorUrl = await optionalBinaryUrl([
            "../../../../../local-binaries/programs/wasm32/wlcompositor.wasm",
            "../../../../../binaries/programs/wasm32/wlcompositor.wasm",
          ], "wlcompositor.wasm");
          const wltermUrl = await optionalBinaryUrl([
            "../../../../../local-binaries/programs/wasm32/wlterm.wasm",
            "../../../../../binaries/programs/wasm32/wlterm.wasm",
          ], "wlterm.wasm");
          const wlclockUrl = await optionalBinaryUrl([
            "../../../../../local-binaries/programs/wasm32/wlclock.wasm",
            "../../../../../binaries/programs/wasm32/wlclock.wasm",
          ], "wlclock.wasm");
          const wlpaintUrl = await optionalBinaryUrl([
            "../../../../../local-binaries/programs/wasm32/wlpaint.wasm",
            "../../../../../binaries/programs/wasm32/wlpaint.wasm",
          ], "wlpaint.wasm");
          tick("staging wayland binaries...");
          const [compBytes, termBytes, clockBytes, paintBytes] = await Promise.all([
            fetch(compositorUrl).then(failOn("wlcompositor.wasm")).then((r) => r.arrayBuffer()),
            fetch(wltermUrl).then(failOn("wlterm.wasm")).then((r) => r.arrayBuffer()),
            fetch(wlclockUrl).then(failOn("wlclock.wasm")).then((r) => r.arrayBuffer()),
            fetch(wlpaintUrl).then(failOn("wlpaint.wasm")).then((r) => r.arrayBuffer()),
          ]);
          ensureDirRecursive(kernelForWayland.fs, "/usr/local/bin");
          writeVfsBinary(
            kernelForWayland.fs,
            "/usr/local/bin/wlcompositor",
            new Uint8Array(compBytes),
            0o755,
          );
          writeVfsBinary(
            kernelForWayland.fs,
            "/usr/local/bin/wlterm",
            new Uint8Array(termBytes),
            0o755,
          );
          writeVfsBinary(
            kernelForWayland.fs,
            "/usr/local/bin/wlclock",
            new Uint8Array(clockBytes),
            0o755,
          );
          writeVfsBinary(
            kernelForWayland.fs,
            "/usr/local/bin/wlpaint",
            new Uint8Array(paintBytes),
            0o755,
          );

          // Keyboard on event0 → compositor libinput → wl_keyboard →
          // wlterm → dash. The POINTER is owned by the Modeset pane
          // (sendPointerAbs → event1), so disable this source's pointer
          // feed (its window-relative coords would fight the pane's). A
          // terminal has no wheel use, so wheel is off too. The dims are
          // only consumed by pointer/ABS scaling, which this source has
          // disabled — the 1080p defaults are inert here.
          tick("attaching input source...");
          const WL_FB_W = 1920;
          const WL_FB_H = 1080;
          kernelForWayland.attachInputSource(
            new BrowserInputSource(window, { pointer: false, wheel: false }),
            { width: WL_FB_W, height: WL_FB_H },
          );

          // The compositor sizes its desktop from the connector's
          // preferred mode, which the host derives from the display's
          // device-pixel size (host_kms_mode_info → aspect-matched
          // width at 1080 logical height, so the desktop fills the
          // pane with no letterbox). Measure the pane's canvas directly
          // as soon as it is laid out; while it isn't (hidden slot),
          // wait briefly for the Modeset pane's ResizeObserver to
          // report instead. On timeout (pane hidden or headless
          // embedder) the mode stays the 1920×1080 default and the
          // presenter letterboxes.
          tick("sizing display mode...");
          const sizeDeadline = performance.now() + 1500;
          let displaySize = host.getKmsDisplaySize(1);
          while (!displaySize && performance.now() < sizeDeadline) {
            const paneCanvas = document.querySelector<HTMLCanvasElement>(
              ".kmachine-primary-slot:not(.is-hidden) canvas",
            );
            const rect = paneCanvas?.getBoundingClientRect();
            if (rect && rect.width >= 1 && rect.height >= 1) {
              const dpr = window.devicePixelRatio || 1;
              displaySize = { width: rect.width * dpr, height: rect.height * dpr };
              kernelForWayland.kmsSetDisplaySize(
                1,
                displaySize.width,
                displaySize.height,
              );
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
            displaySize = host.getKmsDisplaySize(1);
          }

          // Spawn the compositor in the background. All clients retry
          // their connect to /tmp/wayland-0, so they tolerate the
          // compositor not yet having bound the socket — no explicit
          // barrier needed.
          tick("running wlcompositor...");
          const spawnBg = (bytes: ArrayBuffer, name: string) =>
            void kernelForWayland.spawn(bytes, [name], {
              env: SHELL_ENV,
              cwd: DEMO_HOME,
              uid: DEMO_UID,
              gid: DEMO_GID,
            }).then(
              () => tick(`${name} exited`),
              (err: unknown) =>
                tick(`${name} failed: ${err instanceof Error ? err.message : String(err)}`),
            );
          spawnBg(compBytes, "wlcompositor");
          tick("running wlclock + wlpaint...");
          spawnBg(clockBytes, "wlclock");
          spawnBg(paintBytes, "wlpaint");

          tick("running wlterm...");
          await host.runShellCommand("/usr/local/bin/wlterm");
          tick("wlterm exited");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          tick(`wayland failed: ${msg}`);
        }
      })();
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
    host.setStatus("running");
    return kernel;
  } catch (err) {
    stopDinitStartingPoller();
    if (kernel && !isCurrent()) {
      await kernel.destroy().catch(() => {});
    }
    throw err;
  }
}

/**
 * Wraps `BrowserAudioDriver` so the per-period tick callback also
 * bumps `window.__alsaFramesConsumed`. Playwright reads that counter
 * to confirm the AudioWorklet is alive and the kernel is being
 * ticked. The forwarding contract is exercised by
 * `host/test/instrumented-audio-driver.test.ts`.
 */
function createInstrumentedAudioDriver(): InstrumentedAudioDriver {
  return instrumentAudioDriver(
    new BrowserAudioDriver(wpkAudioWorkletUrl),
    (_frames, total) => {
      (window as unknown as { __alsaFramesConsumed?: number })
        .__alsaFramesConsumed = total;
    },
  );
}

function genericPresentationForProfile(profile: LiveProfile): DemoPresentation {
  if (profile.init?.web) return genericDemoPresentation("web");
  if (
    profile.modesetDemo
    || profile.sdl2Demo
    || profile.waylandDemo
    || profile.descriptor.runtime.features.includes("kms")
  ) {
    return genericDemoPresentation("kms");
  }
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
  if (kind === "sqlite") {
    ensureOwnedDir(fs, "/var/www/html/wp-content/database", 0o775, PHP_FPM_UID, PHP_FPM_GID);
  } else if (kind === "mariadb") {
    for (const dir of ["/data", "/data/mysql", "/data/tmp", "/data/test"]) {
      ensureOwnedDir(fs, dir, 0o775, MYSQL_UID, MYSQL_GID);
    }
    patchWordPressPersistentMysqli(fs);
    writeVfsFile(fs, "/var/www/html/kandelo-mysql-bench.php", MYSQL_BENCHMARK_PHP);
  }
  ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");
  writeVfsFile(
    fs,
    "/var/www/html/wp-content/mu-plugins/kandelo-url.php",
    WORDPRESS_URL_MU_PLUGIN,
  );
}

function patchMariaDbUnixSocketConfig(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/tmp");
  fs.chmod("/tmp", 0o1777);

  const phpIniPath = "/etc/php.ini";
  const phpIni = readOptionalVfsText(fs, phpIniPath);
  if (phpIni !== null) {
    let patched = phpIni;
    if (!/^mysqli\.default_socket\s*=/m.test(patched)) {
      patched += `${patched.endsWith("\n") ? "" : "\n"}mysqli.default_socket=${MARIADB_SOCKET_PATH}\n`;
    }
    if (!/^mysqli\.allow_persistent\s*=/m.test(patched)) {
      patched += `mysqli.allow_persistent=1\n`;
    }
    if (!/^mysqli\.max_persistent\s*=/m.test(patched)) {
      patched += `mysqli.max_persistent=-1\n`;
    }
    if (!/^pdo_mysql\.default_socket\s*=/m.test(patched)) {
      patched += `pdo_mysql.default_socket=${MARIADB_SOCKET_PATH}\n`;
    }
    if (patched !== phpIni) writeVfsFile(fs, phpIniPath, patched);
  }

  const mariadbServicePath = "/etc/dinit.d/mariadb";
  const mariadbService = readOptionalVfsText(fs, mariadbServicePath);
  if (mariadbService !== null) {
    const patched = mariadbService
      .replace(/--socket=(?:\S*)?/g, `--socket=${MARIADB_SOCKET_PATH}`)
      .replace(/\s*--thread-handling=no-threads\b/g, "");
    if (patched !== mariadbService) writeVfsFile(fs, mariadbServicePath, patched);
  }

  ensureMariaDbReadyService(fs);
  patchPhpFpmMariaDbDependency(fs);
}

function ensureMariaDbReadyService(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, dirname(MARIADB_READY_SCRIPT_PATH));
  writeVfsFile(fs, MARIADB_READY_SCRIPT_PATH, `#!/bin/sh
set -u

i=0
while [ "$i" -lt 60 ]; do
    if [ -S "${MARIADB_SOCKET_PATH}" ] || [ -e "${MARIADB_SOCKET_PATH}" ]; then
        exit 0
    fi
    sleep 1
    i=$((i + 1))
done

echo "MariaDB readiness timed out waiting for ${MARIADB_SOCKET_PATH}" >&2
exit 1
`, 0o755);
  writeVfsFile(fs, `/etc/dinit.d/${MARIADB_READY_SERVICE}`, `type = scripted
command = /bin/sh ${MARIADB_READY_SCRIPT_PATH}
depends-on = mariadb
restart = false
`);
}

function patchPhpFpmMariaDbDependency(fs: MemoryFileSystem): void {
  const phpFpmServicePath = "/etc/dinit.d/php-fpm";
  const phpFpmService = readOptionalVfsText(fs, phpFpmServicePath);
  if (phpFpmService === null) return;
  if (new RegExp(`^depends-on\\s*=\\s*${MARIADB_READY_SERVICE}$`, "m").test(phpFpmService)) {
    return;
  }
  const patched = phpFpmService.replace(
    /^depends-on\s*=\s*mariadb\s*$/m,
    `depends-on = ${MARIADB_READY_SERVICE}`,
  );
  if (patched !== phpFpmService) {
    writeVfsFile(fs, phpFpmServicePath, patched);
  } else {
    writeVfsFile(
      fs,
      phpFpmServicePath,
      `${phpFpmService}${phpFpmService.endsWith("\n") ? "" : "\n"}depends-on = ${MARIADB_READY_SERVICE}\n`,
    );
  }
}

function patchWordPressPersistentMysqli(fs: MemoryFileSystem): void {
  for (const path of [
    "/var/www/html/wp-includes/class-wpdb.php",
    "/var/www/html/wp-includes/wp-db.php",
  ]) {
    const source = readOptionalVfsText(fs, path);
    if (source === null) continue;
    const patched = patchWordPressMysqliPersistentSource(source);
    if (patched !== source) writeVfsFile(fs, path, patched);
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

async function reportTcpListener(
  kernel: BrowserKernel,
  pid: number,
  port: number,
  tick: (msg: string) => void,
  isCurrent: () => boolean,
): Promise<void> {
  const processName = await processNameForPid(kernel, pid).catch(() => null);
  if (!isCurrent()) return;
  tick(`${processName ?? "service"} listening on :${port}`);
}

async function processNameForPid(kernel: BrowserKernel, pid: number): Promise<string | null> {
  if (pid <= 0) return null;
  const proc = (await kernel.enumProcs()).find((entry) => entry.pid === pid);
  if (!proc) return null;
  const comm = proc.comm.trim();
  if (comm && !comm.startsWith("[")) return comm;
  const arg0 = basename(proc.cmdline.trim().split(/\s+/)[0] ?? "").trim();
  return arg0 && !arg0.startsWith("[") ? arg0 : null;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

async function loadArchiveArtifact(archiveUrl: string, artifactPath: string): Promise<Uint8Array> {
  const archiveBytes = await fetchBytesNoStore(archiveUrl);
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
    const buffer: ArrayBuffer = await fetch(demoAssetFetchUrl(asset))
      .then(failOn(asset.path))
      .then((r) => r.arrayBuffer());
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

function demoAssetFetchUrl(asset: DemoAssetConfig): string {
  if (!asset.devCorsProxy || !import.meta.env.DEV) return asset.url;
  const proxyUrl = new URL(DEV_CORS_PROXY_PATH, window.location.href);
  proxyUrl.searchParams.set("url", asset.url);
  return proxyUrl.href;
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
  dinitBootTracker: DinitBootStatusTracker,
  tick: (msg: string) => void,
  isCurrent: () => boolean,
): void {
  const web = profile.init?.web;
  if (!web) return;
  const portsReady = web.requiredPorts.every((p) => seenPorts.has(p));
  const servicesReady = (web.requiredServices ?? [])
    .every((serviceName) => dinitBootTracker.hasCompleted(serviceName));
  if (!portsReady || !servicesReady || !bridgeSent) return;
  const readyMessage = web.probeHttp ? "HTTP bridge ready" : "Service stack ready";
  if (readiness.ready) {
    if (!isCurrent()) return;
    host.setWebPreview({
      label: web.label,
      url: APP_PREFIX,
      status: "running",
      message: readyMessage,
    });
    return;
  }
  if (!web.probeHttp) {
    readiness.ready = true;
    tick("Web preview ready");
    host.setWebPreview({
      label: web.label,
      url: APP_PREFIX,
      status: "running",
      message: readyMessage,
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
      if (!isCurrent()) return;
      readiness.ready = true;
      tick("HTTP preview ready");
      host.setWebPreview({
        label: web.label,
        url: APP_PREFIX,
        status: "running",
        message: "HTTP bridge ready",
      });
    },
    (err) => {
      if (!isCurrent()) return;
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
    if (!isCurrent()) return;
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
    base: software ? `kandelo:shell@abi${ABI_VERSION}` : item.base,
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
  // Multiple presets share the shell VFS image (doom, modeset, sdl2).
  // When the URL doesn't pin one via the hash, fall back to the shell
  // preset so the ambiguous shell-image link doesn't auto-launch a
  // demo binary.
  return matches.find((id) =>
    id !== "doom" && id !== "modeset" && id !== "sdl2",
  ) ?? null;
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
  const manifestText = await fetchTextNoStore(manifestUrl);
  const manifest = JSON.parse(manifestText) as SoftwareGalleryManifest;
  const sourceId = sourceIdForManifest(manifest, manifestUrl);
  const indexUrl = manifest.index_url
    ? new URL(manifest.index_url, manifestUrl).href
    : new URL("index.toml", manifestUrl).href;
  const index = parseIndexToml(await fetchTextNoStore(indexUrl));
  if (index.abiVersion !== undefined && index.abiVersion !== ABI_VERSION) {
    console.warn(
      `Ignoring Kandelo software index ${indexUrl}: ABI ${index.abiVersion}, expected ${ABI_VERSION}`,
    );
    return [];
  }
  const items: GalleryItem[] = [];
  for (const entry of manifest.entries) {
    if (!entry.packages.every((pkg) => packageAvailable(index, pkg))) continue;
    const item = softwareEntryToGalleryItem(entry, sourceId, index, indexUrl);
    if (item) items.push(item);
  }
  return items;
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
  index: SoftwareIndex,
  indexUrl: string,
): GalleryItem | null {
  const primaryPackage = entry.packages[entry.packages.length - 1];
  const archiveUrl = archiveUrlFor(index, indexUrl, primaryPackage);
  if (!primaryPackage || !archiveUrl) return null;
  const id = `${sourceId}-${entry.id}`;
  const profile = softwareProfileForEntry(id, entry, index, indexUrl, archiveUrl);
  if (!profile) return null;
  SOFTWARE_PROFILES.set(id, profile);
  return {
    id,
    title: entry.title,
    summary: archiveUrl
      ? `${entry.description} Archive: ${archiveUrl}`
      : entry.description,
    base: `kandelo:shell@abi${ABI_VERSION}`,
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
  index: SoftwareIndex,
  indexUrl: string,
  vfsArchiveUrl: string,
): SoftwareProfile | null {
  const primaryPackage = entry.packages[entry.packages.length - 1];
  if (!primaryPackage) return null;
  const vfsArtifactPath = `artifacts/${primaryPackage.name}.vfs.zst`;

  const base: SoftwareProfile = {
    id,
    vfsArchiveUrl,
    vfsArtifactPath,
    binaries: [],
    shellEnv: SHELL_ENV,
  };

  if (entry.id.includes("python")) {
    const runtimePackage = runtimePackageForEntry(entry, ["cpython", "python"]);
    const runtimeArchiveUrl = archiveUrlFor(index, indexUrl, runtimePackage);
    if (!runtimeArchiveUrl) return null;
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

  if (entry.id.includes("perl")) {
    const runtimePackage = runtimePackageForEntry(entry, ["perl"]);
    const runtimeArchiveUrl = archiveUrlFor(index, indexUrl, runtimePackage);
    if (!runtimeArchiveUrl) return null;
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

  if (entry.id.includes("erlang")) {
    const runtimePackage = runtimePackageForEntry(entry, ["erlang"]);
    const runtimeArchiveUrl = archiveUrlFor(index, indexUrl, runtimePackage);
    if (!runtimeArchiveUrl) return null;
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

function runtimePackageForEntry(
  entry: SoftwareGalleryEntry,
  names: string[],
): GalleryPackageRequirement | undefined {
  const wanted = new Set(names);
  return entry.packages.find((pkg) => wanted.has(pkg.name));
}

function packageKey(pkg: GalleryPackageRequirement): string {
  return `${pkg.name}@${pkg.version}`;
}

function packageAvailable(
  index: SoftwareIndex,
  requirement: GalleryPackageRequirement,
): boolean {
  const entry = index.packages.get(packageKey(requirement));
  return entry?.binary.wasm32?.status === "success";
}

function archiveUrlFor(
  index: SoftwareIndex,
  indexUrl: string,
  requirement: GalleryPackageRequirement | undefined,
): string | undefined {
  if (!requirement) return undefined;
  const archiveUrl = index.packages.get(packageKey(requirement))?.binary.wasm32?.archive_url;
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

function parseIndexToml(text: string): SoftwareIndex {
  const packages = new Map<string, IndexPackageEntry>();
  let abiVersion: number | undefined;
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
    if (!assignment) continue;

    const [, key, rawValue] = assignment;
    const value = parseTomlValue(rawValue);
    if (!currentPackage) {
      if (key === "abi_version") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) abiVersion = parsed;
      }
      continue;
    }
    if (currentBinary) {
      currentBinary[key as keyof IndexBinaryEntry] = value;
    } else if (key === "name" || key === "version") {
      currentPackage[key] = value;
      if (currentPackage.name && currentPackage.version) {
        packages.set(`${currentPackage.name}@${currentPackage.version}`, currentPackage);
      }
    }
  }

  return { abiVersion, packages };
}

async function fetchTextNoStore(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return await response.text();
}

async function fetchBytesNoStore(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
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
