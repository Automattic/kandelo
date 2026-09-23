// Builds a LiveKernelHost over a real BrowserKernel for the Kandelo page.

import { BrowserKernel } from "@host/browser-kernel-host";
import { ensureServiceWorkerReady } from "../../../lib/init/service-worker-bridge";
import { setupServiceWorkerFetchBridge } from "../../../lib/init/sw-bridge-fetch";
import {
  bindImageOwnedRuntimeUrls,
  type ImageOwnedRuntimeLazyAssets,
} from "../../../lib/init/image-owned-runtime-urls";
import { BrowserInputSource } from "../../../../../host/src/input/browser-input-source";
import { demoSurfaceCaptureGate } from "../../../../../host/src/input/demo-surface-gate";
import sdl2PlasmaFragSrc from "../../../../../programs/sdl2/presets/image/plasma.frag?raw";
import sdl2AudioBarsFragSrc from "../../../../../programs/sdl2/presets/image/audio_bars.frag?raw";
import sdl2TunnelwispFragSrc from "../../../../../programs/sdl2/presets/image/tunnelwisp.frag?raw";
import sdl2SoundSineFragSrc from "../../../../../programs/sdl2/presets/sound/sine.frag?raw";
import sdl2SoundTunnelwispFragSrc from "../../../../../programs/sdl2/presets/sound/tunnelwisp.frag?raw";
import sdl2SoundFmBellFragSrc from "../../../../../programs/sdl2/presets/sound/fm_bell.frag?raw";
import sdl2SoundNoiseSweepFragSrc from "../../../../../programs/sdl2/presets/sound/noise_sweep.frag?raw";
import sdl2SoundChordFragSrc from "../../../../../programs/sdl2/presets/sound/chord.frag?raw";
import {
  WORDPRESS_CONFIG_INIT_SCRIPT,
  WORDPRESS_URL_MU_PLUGIN,
  patchWordPressMysqliPersistentSource,
  renderWordPressConfig,
  wordpressConfigTemplate,
  type WordPressDatabaseKind,
} from "../../../lib/init/wordpress-runtime-config";
import { MYSQL_BENCHMARK_PHP } from "../../../lib/init/mysql-benchmark";
import {
  WORDPRESS_MARIADB_READY_FILE,
  WORDPRESS_MARIADB_READY_PATH,
  WORDPRESS_MARIADB_READY_PHP,
  WORDPRESS_MARIADB_SOCKET_PATH,
} from "../../../lib/init/wordpress-mariadb-readiness";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  extractZipEntry,
  parseZipCentralDirectory,
} from "../../../../../host/src/vfs/zip";
import {
  resolveBrowserCorsProxyConfig,
} from "../../../lib/browser-cors-proxy";
import {
  finalizeKernelOwnedImage,
  settleWebKitReclaim,
  trackTransientImageBuffer,
} from "../../../lib/kernel-owned-boot";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../../../host/src/vfs/image-helpers";
import { ABI_VERSION } from "../../../../../host/src/generated/abi";
import {
  LiveKernelHost,
  type BootDescriptor,
  type BootInput,
  type BootJsonValue,
  type BootParameters,
  type DemoPresentation,
  type GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { validateBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import { webPreviewForMachineChromeMessage } from "../../../../../web-libs/kandelo-session/src/machine-chrome-message";
import {
  materializeBootInputs,
  type BootInputManifest,
} from "../../../../../web-libs/kandelo-session/src/boot-inputs";
import {
  genericDemoPresentation,
  resolveDemoAssets,
  resolveDemoGuide,
  resolveDemoIngest,
  resolveDemoPresentation,
  type KandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import { readKandeloDemoConfigFromVfs } from "../../../../../web-libs/kandelo-session/src/demo-config-vfs";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES,
  experimentalTerminalSessionPolicy,
  parseExperimentalTerminalSession,
  type ExperimentalTerminalProgram,
  type ExperimentalTerminalSession,
} from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import {
  CUSTOM_VFS_PROFILE_MAX_BYTES,
  DEFAULT_VFS_PROFILE_MAX_BYTES,
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
  assertVfsImageFitsProfile,
  declaredVfsMaxByteLength,
} from "../../../../../web-libs/kandelo-session/src/vfs-capacity";
import {
  builtinDemoAssets,
  builtinDemoGuide,
  builtinDemoPresentation,
} from "../../../../../web-libs/kandelo-session/src/demo-guides";
import { PRESET_LIBRARY } from "../presets";
import {
  descriptorWithVfsImageUrl,
  demoIdFromVfsImageUrl,
  matchTrustedVfsSourceId,
  normalizeVfsImageUrl,
  titleFromVfsImageUrl,
  vfsImageUrlFromDescriptor,
} from "../url-state";
import { verifyImportedSealsForCurrentBoot } from "./boot-current-boundary";
import {
  candidateEvidenceBootDescriptor,
  candidateEvidenceKernelInitOptions,
  candidateEvidenceLiveDemoId,
  createProtectedCandidatePagesVfsPlacement,
  installProtectedCandidatePagesActivation,
  fetchProtectedCandidateVfs,
  PROTECTED_BROWSER_EVIDENCE_MAX_PROCESS_MEMORY_BYTES,
  readInjectedProtectedBrowserEvidence,
  type InjectedProtectedCandidateVfsV1,
  type ProtectedCandidatePagesVfsPlacement,
} from "./candidate-evidence-vfs";
import {
  resolveOptionalDemoVfsUrl,
  type OptionalDemoVfsImage,
} from "./optional-demo-vfs";
import {
  createPagesVfsProductLoader,
  type PagesVfsProductEntry,
} from "./pages-vfs-product-loader";
import { stageConfiguredAssets } from "./configured-assets";
import {
  deploymentScopeFromServiceWorkerUrl,
} from "../../../../../web-libs/kandelo-session/src/deployment-scope";
import { createCoiReloadSessionState } from "./coi-reload-session-state";
import {
  DinitBootStatusTracker,
  REQUIRED_DINIT_SERVICES,
} from "./dinit-boot-status";

import kernelWasmUrl from "@kernel-wasm?url";
import shellVfsUrl from "@binaries/programs/wasm32/shell.vfs.zst?url";
// @ts-expect-error Vite owns this virtual module in both canonical and normal mode.
import canonicalPagesVfsProducts from "virtual:kandelo-pages-vfs-products";

const CANONICAL_PAGES_VFS_PRODUCTS = canonicalPagesVfsProducts as
  | readonly PagesVfsProductEntry[]
  | null;
const CANONICAL_PAGES_VFS_LOADER = CANONICAL_PAGES_VFS_PRODUCTS === null
  ? undefined
  : createPagesVfsProductLoader(
    CANONICAL_PAGES_VFS_PRODUCTS,
    (url, init) => fetch(url, init),
  );

const OPTIONAL_BINARY_URLS = {
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/fbtest.wasm",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/fbtest.wasm", {
    query: "?url",
    import: "default",
  }),
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/nginx-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../binaries/programs/wasm32/nginx-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/sdl2.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/sdl2.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ruby-todo-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ruby-todo-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/evdev_demo.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/evdev_demo.wasm", {
    query: "?url", import: "default",
  }),
  // espeak-ng publishes a wasm output plus a runtime file, so the resolver
  // mirrors its whole closure under the package directory.
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/espeak-ng/espeak-ng.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/espeak-ng/espeak-ng.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/espeak-ng/espeak-ng-data.zip", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/espeak-ng/espeak-ng-data.zip", {
    query: "?url", import: "default",
  }),
} as Record<string, () => Promise<string>>;

async function optionalBinaryUrl(
  relPaths: string[],
  label: string,
): Promise<string> {
  for (const relPath of relPaths) {
    const loader = OPTIONAL_BINARY_URLS[relPath];
    if (loader) return loader();
  }
  throw new Error(
    `${label} is not built. Run: ./run.sh build programs, ` +
      `or for package-owned binaries: ` +
      `cargo xtask build-deps resolve <package>`,
  );
}

const HTTP_PORT = 8080;
const PHP_FPM_PORT = 9000;
const MARIADB_SOCKET_PATH = WORDPRESS_MARIADB_SOCKET_PATH;
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
const DEMO_USER = "maker";
const DEMO_HOME = "/home/maker";

class BootSuperseded extends Error {
  constructor() {
    super("boot superseded");
  }
}

type LiveVfsImage =
  "shell" | "node" | "nginx" | "nginx-php" | "wordpress" | "lamp" | "ruby-todo";

type PagesVfsProductId =
  | "platform-rootfs"
  | "browser-main-shell"
  | "browser-node"
  | "browser-nginx"
  | "browser-nginx-php"
  | "browser-wordpress"
  | "browser-lamp"
  | "browser-ruby-todo";

type LiveVfsSource =
  | { kind: "url"; productId: PagesVfsProductId; url: string }
  | { kind: "optional-demo"; image: OptionalDemoVfsImage; productId: PagesVfsProductId }
  | {
    kind: "optional-binary";
    label: string;
    productId: PagesVfsProductId;
    relPaths: string[];
  };

type ShellProfile = "default" | "node";
type InitEnvProfile = "service" | "wordpress";

interface LiveDemoSpec {
  image: LiveVfsImage;
  shell?: ShellProfile;
  autoCommand?: string;
  memoryPages?: number;
  maxVfsByteLength?: number;
  network?: boolean;
  features?: string[];
  init?: {
    argv: string[];
    env?: InitEnvProfile;
    cwd?: string;
    uid?: number;
    gid?: number;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: {
      requiredPorts: number[];
      requiredServices?: string[];
      probeHttp?: boolean;
      probePath?: string;
    };
  };
}

const VFS_SOURCES: Record<LiveVfsImage, LiveVfsSource> = {
  shell: { kind: "url", productId: "browser-main-shell", url: shellVfsUrl },
  node: { kind: "optional-demo", image: "node", productId: "browser-node" },
  nginx: {
    kind: "optional-binary",
    label: "nginx-vfs.vfs.zst",
    productId: "browser-nginx",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/nginx-vfs.vfs.zst",
      "../../../../../binaries/programs/wasm32/nginx-vfs.vfs.zst",
    ],
  },
  "nginx-php": {
    kind: "optional-binary",
    label: "nginx-php-vfs.vfs.zst",
    productId: "browser-nginx-php",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
      "../../../../../binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    ],
  },
  wordpress: {
    kind: "optional-demo",
    image: "wordpress",
    productId: "browser-wordpress",
  },
  lamp: { kind: "optional-demo", image: "lamp", productId: "browser-lamp" },
  "ruby-todo": {
    kind: "optional-binary",
    label: "ruby-todo-vfs.vfs.zst",
    productId: "browser-ruby-todo",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/ruby-todo-vfs.vfs.zst",
      "../../../../../binaries/programs/wasm32/ruby-todo-vfs.vfs.zst",
    ],
  },
};

const DINIT_NGINX_ARGV = [
  "/sbin/dinit",
  "--container",
  "-p",
  "/tmp/dinitctl",
  "nginx",
];

const LIVE_DEMO_IDS = [
  "shell",
  "node",
  "nginx",
  "nginx-php",
  "ruby-todo",
  "wordpress-sqlite",
  "wordpress-mariadb",
  "doom",
  "modeset",
  "sdl2",
  "evdev",
  "espeak",
] as const;

type LiveDemoId = (typeof LIVE_DEMO_IDS)[number];

// Boot-resource reclamation (worker-owned live filesystems and transient
// image-build buffers) lives in the shared helper so every kernel-owned demo
// shares one implementation, including failures before a kernel exists.
async function settleAfterBootResourcesReleased(): Promise<void> {
  await settleWebKitReclaim();
}

const LIVE_DEMO_SPECS: Record<LiveDemoId, LiveDemoSpec> = {
  shell: {
    image: "shell",
  },
  node: {
    image: "node",
    shell: "node",
    memoryPages: 4096,
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    features: ["js-workers"],
  },
  nginx: {
    image: "nginx",
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
      env: "service",
      maxWorkers: 6,
      web: {
        requiredPorts: [HTTP_PORT],
        requiredServices: [...REQUIRED_DINIT_SERVICES.nginx],
      },
    },
  },
  "nginx-php": {
    image: "nginx-php",
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
      env: "service",
      maxWorkers: 12,
      web: {
        requiredPorts: [HTTP_PORT],
        requiredServices: [...REQUIRED_DINIT_SERVICES["nginx-php"]],
      },
    },
  },
  "ruby-todo": {
    image: "ruby-todo",
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    init: {
      // Single-process server: boot the resident Ruby directly as init (no
      // dinit needed for one long-running process).
      argv: ["/usr/bin/ruby", "/var/lib/todo/server.rb"],
      env: "service",
      cwd: "/var/lib/todo",
      maxWorkers: 12,
      maxMemoryPages: 4096,
      web: {
        requiredPorts: [HTTP_PORT],
      },
    },
  },
  "wordpress-sqlite": {
    image: "wordpress",
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
      env: "wordpress",
      maxWorkers: 12,
      maxMemoryPages: 4096,
      web: {
        requiredPorts: [HTTP_PORT],
        requiredServices: [...REQUIRED_DINIT_SERVICES["wordpress-sqlite"]],
      },
    },
  },
  "wordpress-mariadb": {
    image: "lamp",
    // MariaDB's Aria recovery can grow beyond the 4096-page cap used by
    // lighter PHP presets.
    memoryPages: 16384,
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    network: true,
    init: {
      argv: DINIT_NGINX_ARGV,
      env: "wordpress",
      maxWorkers: 24,
      maxMemoryPages: 16384,
      web: {
        requiredPorts: [HTTP_PORT, PHP_FPM_PORT],
        requiredServices: [...REQUIRED_DINIT_SERVICES["wordpress-mariadb"]],
        probeHttp: true,
        probePath: WORDPRESS_MARIADB_READY_PATH,
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
  evdev: {
    image: "shell",
  },
  espeak: {
    image: "shell",
  },
};

const DEFAULT_DEMO_FOR_VFS_IMAGE: Record<LiveVfsImage, LiveDemoId> = {
  shell: "shell",
  node: "node",
  nginx: "nginx",
  "nginx-php": "nginx-php",
  wordpress: "wordpress-sqlite",
  lamp: "wordpress-mariadb",
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
  /** Canonical built-in image family, or null for custom images. */
  image: LiveVfsImage | null;
  vfsUrl: string;
  vfsSource?: LiveVfsSource;
  candidateEvidence?: InjectedProtectedCandidateVfsV1;
  candidateVfsPlacement?: ProtectedCandidatePagesVfsPlacement;
  descriptor: BootDescriptor;
  shell: ShellProfile;
  maxVfsByteLength: number;
  maxMemoryPages?: number;
  autoCommand?: string;
  fallbackPresentation?: DemoPresentation;
  init?: {
    argv: string[];
    env?: string[];
    cwd?: string;
    uid?: number;
    gid?: number;
    maxWorkers?: number;
    maxMemoryPages?: number;
    web?: {
      label: string;
      requiredPorts: number[];
      requiredServices?: string[];
      probeHttp: boolean;
      probePath?: string;
    };
  };
  framebufferTest: boolean;
  /**
   * Stage the SDL2 GLSL playground at `/usr/local/bin/sdl2` with its
   * shader presets, attach a `BrowserInputSource` for the keyboard and
   * wheel (the Modeset pane owns the pointer through `sendPointerAbs`),
   * and run the binary from bash. Audio rides the /dev/dsp path every
   * other sound demo uses.
   */
  sdl2Demo: boolean;
  /**
   * Stage `evdev_demo` into `/usr/local/bin`, attach a `BrowserInputSource`
   * to the window so keyboard/pointer events flow into the kernel's
   * `/dev/input/event{0,1}`, and run the binary from bash so its event
   * log streams to the user's Shell pane.
   */
  evdevDemo: boolean;
  /**
   * Spawn `espeak-ng "..."` from the booted shell. espeak-ng links
   * upstream pcaudiolib built with only its OSS backend, so
   * `create_audio_device_object` falls through to `/dev/dsp` and a
   * single binary invocation produces audible synthesised speech
   * without any host-side pipeline. The binary + data dir are baked
   * into the image via `stageEspeakRuntime`.
   */
  espeakDemo: boolean;
}

interface WebReadinessState {
  ready: boolean;
  probing: boolean;
  failed: boolean;
}

// The public URL segment for a booted machine's web surface:
// <base>/computer/<name>/. Machines are "computers" in the product vocabulary;
// the per-machine <name> is minted by the service worker at bridge handshake.
// APP_PREFIX here is only the pre-mint placeholder (used by error states that
// never mount the iframe); live web previews use the minted /computer/<name>/.
const APP_PREFIX = import.meta.env.BASE_URL + "computer/";
const APP_PATH = import.meta.env.BASE_URL + "computer";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const SW_SCOPE = deploymentScopeFromServiceWorkerUrl(
  new URL(SW_URL, window.location.href).href,
  window.location.href,
);
const BROWSER_CORS_PROXY = resolveBrowserCorsProxyConfig({
  configuredUrl: import.meta.env.VITE_CORS_PROXY_URL,
  development: import.meta.env.DEV,
  baseUrl: import.meta.env.BASE_URL,
  pageUrl: window.location.href,
});
const COI_RELOAD_SESSION_STATE = createCoiReloadSessionState(
  SW_SCOPE,
  sessionStorage,
);
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
  `PWD=${DEMO_HOME}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  `USER=${DEMO_USER}`,
  `LOGNAME=${DEMO_USER}`,
  "PS1=spidermonkey-node$ ",
  `HISTFILE=${DEMO_HOME}/.bash_history`,
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
  "npm_config_cache=/tmp/.npm-cache",
  "npm_config_registry=https://registry.npmjs.org/",
  "npm_config_fund=false",
  "npm_config_audit=false",
  "npm_config_progress=false",
  "npm_config_update_notifier=false",
  "NPM_CONFIG_FUND=false",
  "NPM_CONFIG_AUDIT=false",
  "NPM_CONFIG_PROGRESS=false",
  "NPM_CONFIG_UPDATE_NOTIFIER=false",
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
  node: { env: NODE_SHELL_ENV, cwd: DEMO_HOME },
};

const INIT_ENV_PROFILES: Record<InitEnvProfile, () => string[]> = {
  service: () => SERVICE_ENV,
  wordpress: () => [
    ...SERVICE_ENV,
    `WP_APP_PATH=${APP_PATH}`,
    `WP_PROTO=${PROTO}`,
  ],
};

export type FbDemo = "none" | "test";

export interface CreateLiveHostOptions {
  demo?: string | null;
  vfsUrl?: string | null;
  fb?: FbDemo;
  /** Boot inputs from a #k1= boot link (e.g. a script input). */
  inputs?: BootInput[] | null;
  /** Boot parameters from a #k1= boot link (e.g. `{ runScript: "script" }`). */
  parameters?: BootParameters | null;
  /**
   * True when the decoded #k1= link carried the removed top-level `script`
   * field from before boot inputs were folded in. The decoder tolerates
   * unknown fields, so such a link still boots, but its script is silently
   * unmaterialized — this flag drives a visible dmesg warning so that
   * silence isn't mistaken for the script having run.
   */
  legacyScriptIgnored?: boolean;
}

export async function createLiveHost(
  opts: CreateLiveHostOptions = {},
): Promise<LiveKernelHost> {
  if (CANONICAL_PAGES_VFS_LOADER !== undefined) {
    await Promise.all([
      CANONICAL_PAGES_VFS_LOADER.activate("platform-rootfs"),
      CANONICAL_PAGES_VFS_LOADER.activate("browser-main-shell"),
    ]);
  }
  let currentKernel: BrowserKernel | null = null;
  let bootSeq = 0;
  let serviceWorkerReady: Promise<ServiceWorker> | null = null;
  const candidateEvidence = readInjectedProtectedBrowserEvidence(
    window.__KANDELO_ABI_STAGING_BROWSER_EVIDENCE__,
  );
  const candidateVfsPlacement = candidateEvidence === undefined
    ? undefined
    : createProtectedCandidatePagesVfsPlacement(
      candidateEvidence.vfs,
      async (source) => {
        if (source.pagesLoad === "lazy" && source.optionalImage !== undefined) {
          const resolved = await resolveOptionalDemoVfsUrl(
            source.optionalImage,
            undefined,
            source,
          );
          if (resolved !== source.url) {
            throw new Error("candidate Pages VFS resolver changed its protected URL");
          }
        }
        return fetchProtectedCandidateVfs(source);
      },
    );
  const protectedProfile = candidateEvidence === undefined
    ? undefined
    : profileForCandidateEvidence(candidateEvidence, candidateVfsPlacement!);
  const localGalleryItems = protectedProfile === undefined
    ? liveGalleryItems()
    : [];

  let initialDescriptor = protectedProfile?.descriptor ??
    await descriptorForBootQuery(opts.vfsUrl, opts.demo);
  if (opts.inputs || opts.parameters) {
    if (protectedProfile !== undefined) {
      // Protected candidate boots pin their descriptor byte-for-byte;
      // silently dropping the link's boot inputs would misrepresent the link.
      throw new Error(
        "protected browser candidate boots do not accept boot-link scripts",
      );
    }
    initialDescriptor = {
      ...initialDescriptor,
      boot: {
        ...initialDescriptor.boot,
        ...(opts.inputs ? { inputs: opts.inputs } : {}),
        ...(opts.parameters ? { parameters: opts.parameters } : {}),
      },
    };
  }
  let host: LiveKernelHost;
  let protectedBoot: Promise<void> | undefined;
  const activateProtectedProfile = (): Promise<void> => {
    if (protectedProfile === undefined || candidateVfsPlacement === undefined) {
      return Promise.reject(new Error("protected candidate profile is unavailable"));
    }
    protectedBoot ??= (async () => {
      await candidateVfsPlacement.activate();
      await startBoot(host, protectedProfile, protectedProfile.descriptor);
    })();
    return protectedBoot;
  };
  host = new LiveKernelHost({
    status: "booting",
    descriptor: initialDescriptor,
    galleryItems: localGalleryItems,
    applyBootDescriptor: async (desc, h) => {
      if (protectedProfile !== undefined) {
        assertProtectedCandidateDescriptor(desc, protectedProfile.descriptor);
        await activateProtectedProfile();
        return;
      }
      await startBoot(h, profileForDescriptor(desc, "none"), desc);
    },
  });

  const requireServiceWorker = (
    tick?: (msg: string) => void,
  ): Promise<ServiceWorker> => {
    if (!serviceWorkerReady) {
      tick?.("preparing service worker...");
      serviceWorkerReady = ensureServiceWorkerReady(SW_URL, SW_SCOPE)
        .then(async (controller): Promise<ServiceWorker> => {
          if (window.crossOriginIsolated) {
            COI_RELOAD_SESSION_STATE.clear();
            return controller;
          }

          if (COI_RELOAD_SESSION_STATE.wasAttempted()) {
            COI_RELOAD_SESSION_STATE.clear();
            throw new Error(
              "Kandelo could not enable cross-origin isolation after the service worker became active. " +
                "Reload the page; if this persists, clear site data for this site and check whether a browser extension is blocking service workers or COOP/COEP headers.",
            );
          }

          COI_RELOAD_SESSION_STATE.markAttempted();
          tick?.(
            "service worker active; reloading to enable cross-origin isolation...",
          );
          window.location.reload();
          return new Promise<never>((_, reject) => {
            window.setTimeout(() => {
              reject(
                new Error(
                  "Kandelo requested a reload to enable cross-origin isolation, but the page did not unload.",
                ),
              );
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
      throw new Error(
        "Kandelo service worker readiness promise was not initialized.",
      );
    }
    return ready;
  };

  if (protectedProfile === undefined) {
    void startBoot(
      host,
      profileForDescriptor(initialDescriptor, opts.fb),
      initialDescriptor,
      opts.legacyScriptIgnored ?? false,
    );
  } else if (candidateVfsPlacement!.pagesLoad === null) {
    void activateProtectedProfile();
  } else {
    installProtectedCandidatePagesActivation(
      window,
      candidateVfsPlacement!,
      activateProtectedProfile,
    );
  }
  return host;

  async function startBoot(
    h: LiveKernelHost,
    profile: LiveProfile,
    descriptor: BootDescriptor,
    legacyScriptIgnored = false,
  ): Promise<void> {
    const seq = ++bootSeq;
    const previousKernel = currentKernel;
    currentKernel = null;
    // WHY: detach while this activation still owns the previous generation.
    // If we await teardown first, a newer boot can attach its kernel and this
    // superseded activation would detach that newer generation on resume.
    h.detachKernel();
    if (previousKernel) {
      await previousKernel.destroy().catch(() => {});
      await settleAfterBootResourcesReleased();
    }
    const bootStartedAt = performance.now();

    try {
      const kernel = await bootProfile(
        h,
        profile,
        descriptor,
        bootStartedAt,
        () => seq === bootSeq,
        requireServiceWorker,
        legacyScriptIgnored,
      );
      if (seq !== bootSeq) {
        await kernel.destroy().catch(() => {});
        await settleAfterBootResourcesReleased();
        return;
      }
      currentKernel = kernel;
    } catch (err) {
      // Failed composition can abandon a private staged filesystem before a
      // BrowserKernel exists. Its discard hook registered the buffer; run the
      // same bounded WebKit reclamation pass used after worker teardown.
      await settleAfterBootResourcesReleased();
      if (err instanceof BootSuperseded || seq !== bootSeq) return;
      currentKernel = null;
      h.detachKernel();
      showBootError(h, descriptor, err, bootStartedAt);
    }
  }
}

function assertProtectedCandidateDescriptor(
  actual: BootDescriptor,
  expected: BootDescriptor,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "protected browser candidate evidence cannot switch boot descriptors",
    );
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
  host.setStatus("error");
}

function bootElapsedMs(bootStartedAt: number): number {
  return Math.max(0, performance.now() - bootStartedAt);
}

async function descriptorForBootQuery(
  vfsUrl: string | null | undefined,
  demo: string | null | undefined,
): Promise<BootDescriptor> {
  const normalizedVfsUrl = normalizeVfsImageUrl(vfsUrl);
  if (!normalizedVfsUrl) return descriptorFor(normalizeDemoId(demo) ?? "shell");

  const liveId = await liveDemoIdForVfsImageUrl(normalizedVfsUrl, demo);
  const base = descriptorFor(liveId ?? "shell");
  return descriptorWithVfsImageUrl(
    base,
    normalizedVfsUrl,
    liveId
      ? {
          id: liveId,
          title: base.title,
          packages: base.packages,
        }
      : {
          id: demoIdFromVfsImageUrl(normalizedVfsUrl),
          title: titleFromVfsImageUrl(normalizedVfsUrl),
          packages: [],
        },
  );
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
    descriptor: desc,
  };
}

function profileForCandidateEvidence(
  evidence: InjectedProtectedCandidateVfsV1,
  placement: ProtectedCandidatePagesVfsPlacement,
): LiveProfile {
  const liveDemoId = candidateEvidenceLiveDemoId(evidence.vfs.profile);
  const base = profileFor(liveDemoId, "none");
  const descriptor = candidateEvidenceBootDescriptor(base.descriptor, evidence);
  return {
    ...base,
    vfsUrl: evidence.vfs.url,
    vfsSource: undefined,
    descriptor,
    candidateEvidence: evidence,
    candidateVfsPlacement: placement,
    init: base.init === undefined
      ? undefined
      : {
        ...base.init,
        argv: evidence.boot.argv.slice(),
        env: envArray(evidence.boot.env),
        cwd: evidence.boot.cwd,
        uid: evidence.boot.uid,
        gid: evidence.boot.gid,
      },
  };
}

function customVfsProfile(
  desc: BootDescriptor,
  vfsUrl: string,
  fb?: FbDemo,
): LiveProfile {
  return {
    id: desc.id,
    image: null,
    vfsUrl,
    descriptor: desc,
    shell: "default",
    maxVfsByteLength: CUSTOM_VFS_PROFILE_MAX_BYTES,
    framebufferTest: fb === "test",
    sdl2Demo: false,
    evdevDemo: false,
    espeakDemo: false,
  };
}

function profileFor(id: string, fb?: FbDemo): LiveProfile {
  const normalized = normalizeDemoId(id) ?? "shell";
  const spec = LIVE_DEMO_SPECS[normalized];
  const desc = descriptorFor(normalized);
  const vfsSource = VFS_SOURCES[spec.image];
  return {
    id: normalized,
    image: spec.image,
    vfsUrl: vfsSource.kind === "url" ? vfsSource.url : "",
    vfsSource,
    descriptor: desc,
    shell: spec.shell ?? "default",
    maxVfsByteLength:
      spec.maxVfsByteLength ??
      (spec.image === "shell"
        ? MAIN_SHELL_VFS_PROFILE_MAX_BYTES
        : DEFAULT_VFS_PROFILE_MAX_BYTES),
    // WHY: memoryPages is a runtime cap, not just descriptor presentation.
    // Preserve Node's WebKit-safe 256 MiB process ceiling when it is launched
    // through the shared boot assembler.
    maxMemoryPages: spec.memoryPages,
    autoCommand: spec.autoCommand,
    init: spec.init && {
      argv: spec.init.argv.slice(),
      env: initEnv(spec.init.env),
      cwd: spec.init.cwd,
      uid: spec.init.uid,
      gid: spec.init.gid,
      maxWorkers: spec.init.maxWorkers,
      maxMemoryPages: spec.init.maxMemoryPages,
      web: spec.init.web && {
        label: desc.title,
        requiredPorts: spec.init.web.requiredPorts.slice(),
        requiredServices: spec.init.web.requiredServices?.slice(),
        probeHttp: spec.init.web.probeHttp ?? true,
        probePath: spec.init.web.probePath,
      },
    },
    framebufferTest: fb === "test",
    sdl2Demo: normalized === "sdl2",
    evdevDemo: normalized === "evdev",
    espeakDemo: normalized === "espeak",
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

function shellIdentityForProfile(
  profile: LiveProfile,
  boot?: BootDescriptor["boot"],
): {
  env: string[];
  cwd: string;
  uid: number;
  gid: number;
} {
  let identity: { env: string[]; cwd: string; uid: number; gid: number };
  if (profile.shell === "node") {
    identity = {
      env: shellEnvFor(profile.shell),
      cwd: shellCwdFor(profile.shell),
      uid: DEMO_UID,
      gid: DEMO_GID,
    };
  } else {
    identity = {
      env: shellEnvFor(profile.shell),
      cwd: shellCwdFor(profile.shell),
      uid: DEMO_UID,
      gid: DEMO_GID,
    };
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
      ...presentation.runningPrimary.filter(
        (surface) => surface !== "web" && surface !== "syslog",
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
      port: HTTP_PORT,
      status: "error",
      message,
    });
  }
  host.setStatus("error");
}

// Shell used to run a boot-link script when the link did not record one
// (links authored before runScriptShell existed). Kandelo browser images
// ship bash as their default shell, so this matches what those links intended
// and keeps the invocation unconditional.
const DEFAULT_BOOT_LINK_SHELL = "bash";

// A recorded shell is untrusted, URL-carried input that is interpolated into a
// shell command line, so it must be a bare command word with no shell
// metacharacters. Anything else is rejected in favour of the default rather
// than trusted, which closes the injection vector while keeping the run
// unconditional.
function safeBootLinkShell(recorded: BootJsonValue | undefined): string {
  return typeof recorded === "string" && /^[a-z][a-z0-9_-]{0,15}$/.test(recorded)
    ? recorded
    : DEFAULT_BOOT_LINK_SHELL;
}

async function runLinkScript(
  host: LiveKernelHost,
  path: string,
  recordedShell: BootJsonValue | undefined,
  tick: (msg: string) => void,
): Promise<void> {
  // The script was already written (mode 0755, writable and executable) by
  // materializeBootInputs during image staging, at `path`.
  //
  // The interpreter comes from the link itself (boot.parameters.runScriptShell,
  // set by ShareDialog to the authoring machine's default shell), so the script
  // runs directly as `<shell> script` with no visible `command -v bash` probe.
  // A main-thread host.stat("/bin/bash") is not a usable substitute: the kernel
  // owns the VFS in its worker and exposes no synchronous surface in the
  // browser, so that probe always reads empty and would silently drop the
  // script onto sh. The shell token is validated to a bare command word first.
  const shell = safeBootLinkShell(recordedShell);
  tick("showing boot-link script in the terminal...");
  // Show the actual script contents in the terminal before running them —
  // the visitor sees exactly what the link asked their machine to execute.
  // `path` is derived from the URL-carried input id, so it is double-quoted
  // here even though the descriptor validator already restricts input ids
  // and filenames to a safe character set — defense in depth against a
  // future relaxation of that validation.
  await host.runShellCommand(`cat "${path}"`);
  tick(`running boot-link script with ${shell}...`);
  await host.runShellCommand(`${shell} "${path}"`);
}

async function bootProfile(
  host: LiveKernelHost,
  profile: LiveProfile,
  requestedDescriptor: BootDescriptor,
  bootStartedAt: number,
  isCurrent: () => boolean,
  requireServiceWorker: (
    tick?: (msg: string) => void,
  ) => Promise<ServiceWorker>,
  legacyScriptIgnored = false,
): Promise<BrowserKernel> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new BootSuperseded();
  };

  assertCurrent();
  validateBootDescriptor(requestedDescriptor);
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
    packages:
      requestedDescriptor.packages.length > 0
        ? requestedDescriptor.packages
        : profile.descriptor.packages,
    mounts: requestedDescriptor.mounts,
    boot: effectiveBoot,
  });
  const genericPresentation =
    profile.fallbackPresentation ?? genericPresentationForProfile(profile);
  host.setPresentation(genericPresentation);
  host.setStatus("booting");

  const tick = (msg: string) => {
    if (!isCurrent()) return;
    host.pushDmesg({
      t: bootElapsedMs(bootStartedAt),
      level: "info",
      facility: "kandelo",
      msg,
    });
  };
  if (legacyScriptIgnored) {
    // The decoded #k1= link carried the removed top-level `script` field
    // from before boot inputs were folded in. The decoder tolerates unknown
    // fields (so old links still boot), but that field's script is never
    // materialized or run. Say so loudly rather than silently dropping it —
    // see docs/browser-support.md's script-carrying share links section.
    host.pushDmesg({
      t: bootElapsedMs(bootStartedAt),
      level: "warn",
      facility: "kandelo",
      msg:
        "this link was built for an older Kandelo: its embedded script " +
        "field is no longer supported and was ignored",
    });
  }
  const webReadiness: WebReadinessState = {
    ready: false,
    probing: false,
    failed: false,
  };
  let maybeUpdateWebReadiness = () => {};
  const requiredServices = new Set(
    profile.init?.web?.requiredServices ?? [],
  );
  const dinitBootTracker = new DinitBootStatusTracker(tick, (completion) => {
    if (
      completion.outcome === "failed" &&
      requiredServices.has(completion.serviceName)
    ) {
      if (webReadiness.failed) return;
      webReadiness.failed = true;
      reportInitError(
        host,
        profile,
        `Required service ${completion.serviceName} failed to start`,
        tick,
      );
      return;
    }
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
  const [kernelBytes, loadedVfs] = await Promise.all([
    fetch(kernelWasmUrl)
      .then(failOn("kernel.wasm"))
      .then((r) => r.arrayBuffer()),
    loadVfsImage(profile),
  ]);
  assertCurrent();

  tick(
    `kernel: ${kib(kernelBytes.byteLength)} · vfs: ${kib(loadedVfs.imageBytes.byteLength)}`,
  );
  const fetchedVfsImageBytes = new Uint8Array(loadedVfs.imageBytes);
  const vfsMetadata = MemoryFileSystem.readImageMetadata(fetchedVfsImageBytes);
  assertVfsImageFitsProfile(
    MemoryFileSystem.readImageCapacity(fetchedVfsImageBytes),
    profile.maxVfsByteLength,
    declaredVfsMaxByteLength(vfsMetadata),
    `${profile.id}.vfs.zst`,
  );
  MemoryFileSystem.assertImageKernelAbi(
    fetchedVfsImageBytes,
    ABI_VERSION,
    `${profile.id}.vfs.zst`,
  );
  // Assemble the demo image in a TRANSIENT build-time filesystem. Its
  // SharedArrayBuffer never becomes the machine's live VFS — after
  // `saveImage()` it is dropped, and the kernel worker rebuilds+owns the live
  // FS from the serialized bytes (kernelOwnedFs). This keeps the main thread
  // out of the live-VFS ownership set so WebKit reclaims it on teardown via
  // Worker.terminate() rather than lazy GC — the root fix for the Safari
  // image-switch OOM.
  const buildFs = MemoryFileSystem.fromImage(fetchedVfsImageBytes, {
    maxByteLength: profile.maxVfsByteLength,
  });
  // Track as soon as the caller owns the staged filesystem. This covers every
  // later fetch, staging, supersession, and serialization failure; finalizing
  // the image is intentionally an idempotent second registration.
  trackTransientImageBuffer(buildFs.sharedBuffer);
  // WHY: register cleanup before rejecting a composition superseded while its
  // asynchronous layer loads were in flight. Otherwise its completed buffer
  // becomes unreachable without entering the WebKit reclamation ledger.
  assertCurrent();
  // WHY: establish cleanup ownership first, then reject forged imported seals
  // before URL rewriting or asset registration can trust their lazy metadata.
  await verifyImportedSealsForCurrentBoot(buildFs);
  // WHY: this check must live in the same continuation as the effects below.
  // Moving it into an async helper creates a microtask gap where a newer boot
  // can take ownership before this boot resumes mutating its staged image.
  assertCurrent();
  const terminalSession = readImageExperimentalTerminalSession(buildFs);
  if (profile.candidateEvidence === undefined) {
    if (
      profile.id === "nginx-php" ||
      profile.id === "wordpress-sqlite" ||
      profile.id === "wordpress-mariadb"
    ) {
      writeVfsFile(buildFs, "/etc/php-fpm.conf", PATCHED_PHP_FPM_CONF);
      ensureDirRecursive(buildFs, "/var/cache/opcache");
    }
    if (profile.id === "wordpress-sqlite") {
      patchWordPressRuntimeConfig(buildFs, "sqlite");
    } else if (profile.id === "wordpress-mariadb") {
      patchMariaDbUnixSocketConfig(buildFs);
      patchWordPressRuntimeConfig(buildFs, "mariadb");
    }
    // Each demo runs its binary from a path, so the bytes have to be in the
    // image before the worker takes exclusive ownership of the VFS.
    if (profile.sdl2Demo) {
      tick("staging sdl2...");
      await stageSdl2Runtime(buildFs);
      assertCurrent();
    }
    if (profile.espeakDemo) {
      tick("staging espeak-ng...");
      await stageEspeakRuntime(buildFs);
      assertCurrent();
    }
    if (profile.evdevDemo) {
      tick("staging evdev_demo...");
      await stageEvdevDemo(buildFs);
      assertCurrent();
    }
    ensureDemoHomes(buildFs);
  }
  assertImageTerminalProgram(buildFs, terminalSession.initial);
  if (terminalSession.afterExit !== undefined) {
    assertImageTerminalProgram(buildFs, terminalSession.afterExit);
  }
  const imageConfig = readImageConfig(buildFs);
  const rawPresentation =
    (imageConfig ? resolveDemoPresentation(imageConfig, profile.id) : null) ??
    builtinDemoPresentation(profile.id) ??
    genericPresentation;
  const presentation = presentationForProfile(profile, rawPresentation);
  host.setPresentation(presentation);
  const demoGuide =
    (imageConfig ? resolveDemoGuide(imageConfig, profile.id) : null) ??
    builtinDemoGuide(profile.id);
  host.setDemoGuide(demoGuide);
  // Ingest is an image-owned capability. Absence is valid and must not be
  // replaced with a package- or profile-name-specific UI promise.
  host.setDemoIngest(
    imageConfig ? resolveDemoIngest(imageConfig, profile.id) : null,
  );
  const imageAssets = imageConfig
    ? resolveDemoAssets(imageConfig, profile.id)
    : [];
  const assets =
    imageAssets.length > 0 ? imageAssets : builtinDemoAssets(profile.id);
  if (profile.candidateEvidence === undefined) {
    await stageConfiguredAssets(buildFs, assets, tick, assertCurrent);
    assertCurrent();
  }

  // Boot inputs (e.g. a #k1= link's script) are untrusted, URL-carried
  // payloads. Materialize the whole declared set now, at the same
  // image-staging point as the asset patches above: every input must verify
  // its byte length and sha256 before anything is written, and a
  // materialization failure must fail the boot loudly rather than silently
  // continue without the input the link promised.
  let bootInputManifest: BootInputManifest | undefined;
  if (requestedDescriptor.boot.inputs?.length) {
    tick("materializing boot inputs...");
    bootInputManifest = await materializeBootInputs(requestedDescriptor, {
      resolvers: {},
      mkdir: (p) => ensureDirRecursive(buildFs, p),
      writeFile: (p, b, m) => writeVfsBinary(buildFs, p, b, m),
    });
    assertCurrent();
  }

  // Serialize the assembled image to transferable bytes, then let `buildFs`
  // go out of scope. `saveImage()` emits raw (uncompressed) bytes that
  // `MemoryFileSystem.fromImage` restores directly in the worker.
  // WHY: this is the final synchronous image mutation. Binding before any
  // later staging could leave newly-added lazy metadata outside the manifest
  // authority copied from the authenticated product activation.
  bindImageOwnedRuntimeUrls(buildFs, loadedVfs.lazyAssets);
  tick("assembling kernel-owned VFS image...");
  // Serialize to transferable bytes + register the transient build buffer for
  // reclamation tracking, then let `buildFs` fall out of scope when bootProfile
  // returns. `settleAfterKernelDestroy` reclaims it on WebKit.
  const vfsImageBytes = await finalizeKernelOwnedImage(buildFs);
  assertCurrent();

  tick("instantiating kernel...");
  const seenPorts = new Set<number>();
  let bridgeSent = false;
  // The service worker mints this machine's app prefix (/base/computer/<name>/) and
  // returns it from the bridge handshake. Every web-preview URL must use the
  // minted value: the bare /computer/ no longer routes to any machine, so the SW
  // serves it as the Kandelo shell — mounting the whole app inside its own
  // web-preview iframe and recursing (stacked docks). Until the handshake
  // returns, this holds the base prefix (only used by error states, which
  // never mount the iframe).
  let machineAppPrefix = APP_PREFIX;
  maybeUpdateWebReadiness = () => {
    maybeMarkWebReady(
      host,
      profile,
      seenPorts,
      bridgeSent,
      machineAppPrefix,
      webReadiness,
      dinitBootTracker,
      tick,
      isCurrent,
    );
  };
  let kernel: BrowserKernel | null = null;
  try {
    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      ...(profile.candidateEvidence === undefined
        ? {}
        : {
          maxProcessMemoryBytes:
            PROTECTED_BROWSER_EVIDENCE_MAX_PROCESS_MEMORY_BYTES,
        }),
      // WHY: the service worker, guest sockets, and lazy VFS are separate
      // transports. The live shell must explicitly give its kernel the same
      // deployment proxy or release-hosted lazy bottles bypass it under COEP.
      corsProxy: BROWSER_CORS_PROXY,
      maxWorkers: profile.init?.maxWorkers ?? 4,
      maxMemoryPages:
        profile.init?.maxMemoryPages ?? profile.maxMemoryPages,
      onStdout: (data) => recordProcessOutput(data, "stdout"),
      onStderr: (data) => recordProcessOutput(data, "stderr"),
      onHostDiagnostic: (diagnostic) => {
        if (!isCurrent()) return;
        host.pushDmesg({
          t: bootElapsedMs(bootStartedAt),
          level: "warn",
          facility: "kernel",
          msg: diagnostic.message,
        });
      },
      onProcessEvent: (event) => {
        if (isCurrent()) host.emitProcessEvent(event);
      },
      onHttpBridgePendingRequests: (count) => {
        if (isCurrent()) host.setWebPreviewPendingRequests(count);
      },
      onListenTcp: (pid, _fd, port) => {
        if (!isCurrent()) return;
        seenPorts.add(port);
        void reportTcpListener(kernel!, pid, port, tick, isCurrent).finally(
          () => {
            maybeUpdateWebReadiness();
          },
        );
      },
    });
    const kernelInitOptions = profile.candidateEvidence === undefined
      ? {
        kernelWasm: kernelBytes,
        vfsImage: vfsImageBytes,
      }
      : candidateEvidenceKernelInitOptions(
        profile.candidateEvidence,
        kernelBytes,
        vfsImageBytes,
      );
    await kernel.initFromImage(kernelInitOptions);
    assertCurrent();
    host.attachKernel(kernel);
    host.setTerminalSessionPolicy(
      experimentalTerminalSessionPolicy(terminalSession),
    );

    if (profile.init?.web) {
      tick("initializing HTTP bridge...");
      try {
        // Unique id for this machine instance. Scopes the service worker's
        // cookie jar so sessions never share cookies. Temporary instances get a
        // fresh random id per boot; when machines become persistable this is
        // where their durable id would be passed instead.
        const sessionId = crypto.randomUUID();
        // The service worker mints the machine name and app prefix; the
        // web-preview URL comes from the returned prefix, not a static
        // constant, so this tab addresses its own machine.
        const { name, appPrefix } = await setupServiceWorkerFetchBridge(
          SW_URL,
          SW_SCOPE,
          kernel,
          HTTP_PORT,
          sessionId,
          {
            timeoutMs: 90_000,
            debugLog: (line) => tick(line),
            onPendingRequests: (count) => {
              if (isCurrent()) host.setWebPreviewPendingRequests(count);
            },
          },
        );
        assertCurrent();
        // Every later web-preview update (readiness "running", probe URL) must
        // address this machine's minted prefix, not the bare /computer/ constant.
        machineAppPrefix = appPrefix;
        host.setWebPreview({
          label: profile.init.web.label,
          url: appPrefix,
          port: HTTP_PORT,
          status: "starting",
          message: "Waiting for services",
        });
        bridgeSent = true;
        maybeUpdateWebReadiness();
        // The service worker pushes machine-offline (owning tab closed) and
        // machine-reconnecting (transient SW restart) to viewer clients. React
        // to pushes for THIS machine's SW-minted name only, and let the shared
        // mapping decide whether the pane should change — it enforces the
        // strict name match, the isCurrent() supersession guard, and preserves
        // the preview identity while switching status/message.
        navigator.serviceWorker.addEventListener("message", (event) => {
          const next = webPreviewForMachineChromeMessage({
            data: (event as MessageEvent).data,
            mintedName: name,
            current: host.getWebPreview(),
            isCurrent,
          });
          if (next !== null) host.setWebPreview(next);
        });
      } catch (err) {
        if (!isCurrent()) throw err;
        const message = err instanceof Error ? err.message : String(err);
        tick(`HTTP bridge failed: ${message}`);
        host.setWebPreview({
          label: profile.init.web.label,
          url: APP_PREFIX,
          port: HTTP_PORT,
          status: "error",
          message: "HTTP bridge unavailable",
        });
      }
    }

    if (profile.init) {
      const initArgv =
        effectiveBoot.argv.length > 0 ? effectiveBoot.argv : profile.init.argv;
      tick(`spawning ${initArgv[0]}...`);
      // The init binary lives in the kernel-owned VFS; spawn it by path rather
      // than shipping bytes the kernel already has.
      const { exit: initExit } = await kernel.spawnFromVfs(
        initArgv[0],
        initArgv,
        {
          env: mergeEnvArrays(
            profile.init.env ?? [],
            envArray(effectiveBoot.env),
          ),
          cwd: effectiveBoot.cwd || profile.init.cwd || ROOT_HOME,
          uid: effectiveBoot.uid ?? profile.init.uid ?? ROOT_UID,
          gid: effectiveBoot.gid ?? profile.init.gid ?? ROOT_GID,
          stdin: new Uint8Array(),
        },
      );
      // WHY: spawning crosses the worker boundary. A newer boot may own the
      // host by the time the acknowledgement returns, so do not attach exit
      // handlers to this superseded activation.
      assertCurrent();
      void initExit.then(
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

    maybeUpdateWebReadiness();

    if (profile.framebufferTest) {
      const fbtestWasmUrl = await optionalBinaryUrl(
        [
          "../../../../../local-binaries/programs/wasm32/fbtest.wasm",
          "../../../../../binaries/programs/wasm32/fbtest.wasm",
        ],
        "fbtest.wasm",
      );
      assertCurrent();
      void spawnLazy(
        kernel,
        "/usr/local/bin/fbtest",
        fbtestWasmUrl,
        ["fbtest"],
        tick,
        assertCurrent,
      );
    } else if (profile.sdl2Demo) {
      // autoCommand can't run this: the InputSource must be attached before
      // the binary starts polling /dev/input/event{0,1}. The binary and its
      // shader presets are already in the image; see stageSdl2Runtime.
      const kernelForSdl2 = kernel;
      void (async () => {
        try {
          tick("attaching input source...");
          // Keyboard goes through BrowserInputSource (typing, ESC → evdev
          // event0). The POINTER is owned by the Modeset pane, which feeds
          // framebuffer-positioned pointer events into evdev event1 via
          // `sendPointerAbs` — so this source's pointer feed is disabled
          // (its window-relative coordinates would fight the pane's
          // correct ones). WHEEL stays enabled: REL_WHEEL carries no
          // absolute coordinates, so it doesn't fight the pane, and it
          // drives the editor's mouse-scroll (SDL_MOUSEWHEEL).
          // The dims set EVIOCGABS's ABS_X/Y.maximum. SDL treats event1
          // as a relative mouse (it advertises REL_X/Y) and clamps the
          // cursor to the window rather than this range, but the
          // framebuffer size (1920×1080, matching
          // host/src/dri/kms-registry.ts and the Modeset canvas) keeps
          // the bounds sane for any ABS-aware consumer.
          const SDL2_FB_W = 1920;
          const SDL2_FB_H = 1080;
          kernelForSdl2.attachInputSource(
            // Bind to window for global reach, but scope capture to the
            // playground's own Modeset canvas surface so keyboard/wheel
            // over the "New" menu, dialogs, and the sibling terminal and
            // Inspector surfaces stay usable while the playground runs.
            // See demoSurfaceCaptureGate.
            new BrowserInputSource(window, {
              pointer: false,
              wheel: true,
              shouldCapture: demoSurfaceCaptureGate(
                () => document.querySelector(".kmodeset-surface"),
              ),
            }),
            { width: SDL2_FB_W, height: SDL2_FB_H },
          );
          tick("running sdl2...");
          // The playground runs until ESC; runShellCommand resolves when
          // the bash prompt reappears or rejects after its internal
          // 5-minute timeout. Both are expected — log neutrally.
          await host.runShellCommand("/usr/local/bin/sdl2");
          tick("sdl2 exited");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/timed out waiting for PTY prompt/.test(msg)) {
            tick("sdl2 running (long-tail; no further status updates)");
          } else {
            tick(`sdl2 failed: ${msg}`);
          }
        }
      })();
    } else if (profile.espeakDemo) {
      // The binary and its voice data are already in the image; see
      // stageEspeakRuntime. Playback rides the /dev/dsp path every other
      // sound demo uses.
      void (async () => {
        try {
          tick("running espeak-ng...");
          await host.runShellCommand(
            `/usr/bin/espeak-ng "Welcome to Kandelo, the WebAssembly POSIX kernel"`,
          );
          tick("espeak-ng exited");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          tick(`espeak-ng failed: ${msg}`);
        }
      })();
    } else if (profile.evdevDemo) {
      // autoCommand can't run this: the InputSource must be attached before
      // the binary starts polling /dev/input/event{0,1}. The binary itself is
      // already in the image; see stageEvdevDemo.
      const kernelForEvdev = kernel;
      void (async () => {
        try {
          tick("attaching input source...");
          kernelForEvdev.attachInputSource(
            // Re-publish canvas dims on resize so EVIOCGABS maxima track the
            // viewport (injected clientX/clientY grow with the window). The
            // resize listener lives inside BrowserInputSource, so it is
            // removed when the host stops the source on teardown/reboot.
            new BrowserInputSource(window, {
              onResize: () =>
                kernelForEvdev.setInputCanvasDims(
                  window.innerWidth,
                  window.innerHeight,
                ),
              // evdev is the global-input logger, so it captures across the
              // whole demo stage (<main>) by design; the gate still releases
              // the out-of-<main> chrome (the "New" menu, dialogs) so the
              // dock stays usable while it runs. See demoSurfaceCaptureGate.
              shouldCapture: demoSurfaceCaptureGate(
                () => document.querySelector("main"),
              ),
            }),
            {
              width: window.innerWidth,
              height: window.innerHeight,
            },
          );
          tick("running evdev_demo...");
          // evdev_demo runs forever; runShellCommand resolves when the
          // bash prompt reappears (it never will) or rejects after its
          // internal 5-minute timeout. Both are expected — log neutrally.
          await host.runShellCommand("/usr/local/bin/evdev_demo");
          tick("evdev_demo exited");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/timed out waiting for PTY prompt/.test(msg)) {
            tick("evdev_demo running (long-tail; no further status updates)");
          } else {
            tick(`evdev_demo failed: ${msg}`);
          }
        }
      })();
    } else if (requestedDescriptor.boot.parameters?.runScript !== undefined) {
      const runScriptId = requestedDescriptor.boot.parameters.runScript;
      const scriptInput = typeof runScriptId === "string"
        ? bootInputManifest?.inputs.find((entry) => entry.id === runScriptId)
        : undefined;
      if (scriptInput === undefined) {
        // boot.parameters.runScript named an input id that materialization
        // did not produce (typo, or boot.inputs omitted it entirely). The
        // link promised a script; silently continuing without it would
        // misrepresent what the link asked for, so this is a boot error,
        // not just a dmesg note.
        if (!webReadiness.failed) {
          webReadiness.failed = true;
          reportInitError(
            host,
            profile,
            `boot-link script failed: boot.parameters.runScript names an ` +
              `unmaterialized input: ${JSON.stringify(runScriptId)}`,
            tick,
          );
        }
      } else {
        // ⚠️ CONSENT REQUIRED BEFORE PERSISTENT MACHINES ⚠️
        // This auto-runs a URL-supplied script with no confirmation, which is
        // acceptable ONLY because every machine this app boots is ephemeral: a
        // hostile link can at worst waste the visitor's own tab. The moment
        // Kandelo restores persistent machines (OPFS-backed images, restored
        // snapshots), auto-run becomes a drive-by attack on user data. Any
        // persistence feature MUST first add an explicit show-the-script
        // Run/Skip consent step here. See
        // docs/superpowers/specs/2026-09-21-script-bearing-links-design.md.
        const runScriptShell = requestedDescriptor.boot.parameters.runScriptShell;
        void runLinkScript(host, scriptInput.path, runScriptShell, tick).catch((err) => {
          tick(
            `boot-link script failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    } else if (presentation?.autoCommand) {
      tick("starting configured command from the default shell...");
      void host.runShellCommand(presentation.autoCommand).catch((err) => {
        tick(
          `configured command failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } else if (profile.autoCommand) {
      tick(`running ${profile.autoCommand}...`);
      void host.runShellCommand(profile.autoCommand).catch((err) => {
        tick(
          `command failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    if (!webReadiness.failed) {
      tick("ready");
      host.setStatus("running");
    }
    return kernel;
  } catch (err) {
    if (kernel) {
      await kernel.destroy().catch(() => {});
    }
    throw err;
  }
}

function genericPresentationForProfile(profile: LiveProfile): DemoPresentation {
  if (profile.init?.web) return genericDemoPresentation("web");
  if (profile.descriptor.runtime.features.includes("kms")) {
    return genericDemoPresentation("kms");
  }
  if (
    profile.framebufferTest ||
    profile.descriptor.runtime.features.includes("framebuffer")
  ) {
    return genericDemoPresentation("framebuffer");
  }
  return genericDemoPresentation("terminal");
}

function stageShellUtilities(
  fs: MemoryFileSystem,
  dashBytes: ArrayBuffer,
  bashBytes: ArrayBuffer,
): void {
  ensureDemoHomes(fs);
  ensureDirRecursive(fs, "/bin");
  ensureDirRecursive(fs, "/usr/bin");
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes), 0o755);
  try {
    fs.symlink("/bin/dash", "/bin/sh");
  } catch {
    /* exists */
  }
  try {
    fs.symlink("/bin/dash", "/usr/bin/dash");
  } catch {
    /* exists */
  }
  try {
    fs.symlink("/bin/dash", "/usr/bin/sh");
  } catch {
    /* exists */
  }
  writeVfsBinary(fs, "/bin/bash", new Uint8Array(bashBytes), 0o755);
  try {
    fs.symlink("/bin/bash", "/usr/bin/bash");
  } catch {
    /* exists */
  }
}

/**
 * Bake the SDL2 GLSL playground and its shader presets into the image.
 *
 * The playground's source-resolution chain is
 *   1. /home/shaders/<mode>/current.frag       (user-editable)
 *   2. /usr/share/shaders/<mode>/<preset>.frag (preset)
 *   3. built-in fallback compiled into main.c
 * Staging (2) makes the browser path exercise the VFS leg;
 * /home/shaders/<mode> is created so Ctrl+S can write (1) without first
 * creating directories. tunnelwisp is the boot default for both modes;
 * the others are loadable through the editor's Ctrl+L preset browser.
 */
async function stageSdl2Runtime(fs: MemoryFileSystem): Promise<void> {
  const url = await optionalBinaryUrl([
    "../../../../../local-binaries/programs/wasm32/sdl2.wasm",
    "../../../../../binaries/programs/wasm32/sdl2.wasm",
  ], "sdl2.wasm");
  const bytes = await fetch(url)
    .then(failOn("sdl2.wasm"))
    .then((r) => r.arrayBuffer());
  ensureDirRecursive(fs, "/usr/local/bin");
  writeVfsBinary(fs, "/usr/local/bin/sdl2", new Uint8Array(bytes), 0o755);

  ensureDirRecursive(fs, "/usr/share/shaders/image");
  ensureDirRecursive(fs, "/home/shaders/image");
  writeVfsFile(fs, "/usr/share/shaders/image/plasma.frag", sdl2PlasmaFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/image/audio_bars.frag", sdl2AudioBarsFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/image/tunnelwisp.frag", sdl2TunnelwispFragSrc);

  ensureDirRecursive(fs, "/usr/share/shaders/sound");
  ensureDirRecursive(fs, "/home/shaders/sound");
  writeVfsFile(fs, "/usr/share/shaders/sound/tunnelwisp.frag", sdl2SoundTunnelwispFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/sound/sine.frag", sdl2SoundSineFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/sound/fm_bell.frag", sdl2SoundFmBellFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/sound/noise_sweep.frag", sdl2SoundNoiseSweepFragSrc);
  writeVfsFile(fs, "/usr/share/shaders/sound/chord.frag", sdl2SoundChordFragSrc);
}

/**
 * Bake espeak-ng and its voice data into the image.
 *
 * Both come from the espeak-ng package closure, so the demo consumes the same
 * bytes the resolver published. libespeak-ng's PATH_ESPEAK_DATA is fixed to
 * /usr/share at build time, so the data tree has to land unpacked there.
 */
async function stageEspeakRuntime(fs: MemoryFileSystem): Promise<void> {
  const binaryUrl = await optionalBinaryUrl([
    "../../../../../local-binaries/programs/wasm32/espeak-ng/espeak-ng.wasm",
    "../../../../../binaries/programs/wasm32/espeak-ng/espeak-ng.wasm",
  ], "espeak-ng.wasm");
  const binary = await fetch(binaryUrl)
    .then(failOn("espeak-ng.wasm"))
    .then((r) => r.arrayBuffer());
  ensureDirRecursive(fs, "/usr/bin");
  writeVfsBinary(fs, "/usr/bin/espeak-ng", new Uint8Array(binary), 0o755);

  const dataUrl = await optionalBinaryUrl([
    "../../../../../local-binaries/programs/wasm32/espeak-ng/espeak-ng-data.zip",
    "../../../../../binaries/programs/wasm32/espeak-ng/espeak-ng-data.zip",
  ], "espeak-ng-data.zip");
  const data = await fetch(dataUrl)
    .then(failOn("espeak-ng-data.zip"))
    .then((r) => r.arrayBuffer());
  const zipBytes = new Uint8Array(data);
  const root = "/usr/share/espeak-ng-data";
  ensureDirRecursive(fs, root);
  for (const entry of parseZipCentralDirectory(zipBytes)) {
    if (entry.isDirectory) continue;
    const target = `${root}/${entry.fileName}`;
    ensureDirRecursive(fs, target.slice(0, target.lastIndexOf("/")));
    writeVfsBinary(fs, target, extractZipEntry(zipBytes, entry), 0o644);
  }
}

async function stageEvdevDemo(fs: MemoryFileSystem): Promise<void> {
  const url = await optionalBinaryUrl([
    "../../../../../local-binaries/programs/wasm32/evdev_demo.wasm",
    "../../../../../binaries/programs/wasm32/evdev_demo.wasm",
  ], "evdev_demo.wasm");
  const bytes = await fetch(url)
    .then(failOn("evdev_demo.wasm"))
    .then((r) => r.arrayBuffer());
  ensureDirRecursive(fs, "/usr/local/bin");
  writeVfsBinary(fs, "/usr/local/bin/evdev_demo", new Uint8Array(bytes), 0o755);
}

function ensureDemoHomes(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/home");
  ensureOwnedDir(fs, DEMO_HOME, 0o755, DEMO_UID, DEMO_GID);
  ensureOwnedDir(fs, ROOT_HOME, 0o700, ROOT_UID, ROOT_GID);
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
  writeVfsFile(
    fs,
    "/etc/wp-config-template.php",
    wordpressConfigTemplate(kind),
  );
  writeVfsFile(
    fs,
    "/var/www/html/wp-config.php",
    renderWordPressConfig(kind, APP_PATH, PROTO),
  );
  if (kind === "sqlite") {
    ensureOwnedDir(
      fs,
      "/var/www/html/wp-content/database",
      0o775,
      PHP_FPM_UID,
      PHP_FPM_GID,
    );
  } else if (kind === "mariadb") {
    for (const dir of ["/data", "/data/mysql", "/data/tmp", "/data/test"]) {
      ensureOwnedDir(fs, dir, 0o775, MYSQL_UID, MYSQL_GID);
    }
    patchWordPressPersistentMysqli(fs);
    writeVfsFile(
      fs,
      "/var/www/html/kandelo-mysql-bench.php",
      MYSQL_BENCHMARK_PHP,
    );
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
  ensureDirRecursive(fs, dirname(WORDPRESS_MARIADB_READY_FILE));
  writeVfsFile(fs, WORDPRESS_MARIADB_READY_FILE, WORDPRESS_MARIADB_READY_PHP);

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
    if (patched !== mariadbService)
      writeVfsFile(fs, mariadbServicePath, patched);
  }

  ensureMariaDbReadyService(fs);
  patchPhpFpmMariaDbDependency(fs);
}

function ensureMariaDbReadyService(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, dirname(MARIADB_READY_SCRIPT_PATH));
  writeVfsFile(
    fs,
    MARIADB_READY_SCRIPT_PATH,
    `#!/bin/sh
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
`,
    0o755,
  );
  writeVfsFile(
    fs,
    `/etc/dinit.d/${MARIADB_READY_SERVICE}`,
    `type = scripted
command = /bin/sh ${MARIADB_READY_SCRIPT_PATH}
depends-on = mariadb
restart = false
`,
  );
}

function patchPhpFpmMariaDbDependency(fs: MemoryFileSystem): void {
  const phpFpmServicePath = "/etc/dinit.d/php-fpm";
  const phpFpmService = readOptionalVfsText(fs, phpFpmServicePath);
  if (phpFpmService === null) return;
  if (
    new RegExp(`^depends-on\\s*=\\s*${MARIADB_READY_SERVICE}$`, "m").test(
      phpFpmService,
    )
  ) {
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

interface LoadedVfsImage {
  imageBytes: ArrayBuffer;
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
}

async function loadVfsImage(profile: LiveProfile): Promise<LoadedVfsImage> {
  if (profile.candidateEvidence !== undefined) {
    if (profile.candidateVfsPlacement === undefined) {
      throw new Error("candidate evidence VFS lacks its Pages placement boundary");
    }
    return { imageBytes: await profile.candidateVfsPlacement.bytes() };
  }
  if (profile.vfsSource !== undefined && CANONICAL_PAGES_VFS_LOADER !== undefined) {
    const activation = await CANONICAL_PAGES_VFS_LOADER.activate(
      profile.vfsSource.productId,
    );
    return {
      imageBytes: activation.imageBytes.slice(0),
      lazyAssets:
        activation.lazyAssets === undefined
          ? undefined
          : Object.freeze({ ...activation.lazyAssets }),
    };
  }
  const vfsUrl = await resolveProfileVfsUrl(profile);
  return {
    imageBytes: await fetch(vfsUrl)
      .then(failOn(`${profile.id}.vfs.zst`))
      .then((r) => r.arrayBuffer()),
  };
}

async function resolveProfileVfsUrl(profile: LiveProfile): Promise<string> {
  if (profile.vfsSource) return resolveLiveVfsSourceUrl(profile.vfsSource);
  if (profile.vfsUrl) return profile.vfsUrl;
  throw new Error(`No VFS image URL configured for ${profile.id}`);
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

async function processNameForPid(
  kernel: BrowserKernel,
  pid: number,
): Promise<string | null> {
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

async function spawnLazy(
  kernel: BrowserKernel,
  path: string,
  url: string,
  argv: string[],
  tick: (msg: string) => void,
  assertCurrent: () => void,
): Promise<void> {
  try {
    tick(`fetching ${argv[0]}...`);
    const bytes = await fetch(url)
      .then(failOn(argv[0]))
      .then((r) => r.arrayBuffer());
    assertCurrent();
    tick(`spawning ${argv[0]}...`);
    await kernel.spawn(bytes, argv, {
      env: SHELL_ENV,
      cwd: DEMO_HOME,
      uid: DEMO_UID,
      gid: DEMO_GID,
    });
    assertCurrent();
    tick(`${argv[0]} exited`);
  } catch (err) {
    tick(
      `${argv[0]} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function maybeMarkWebReady(
  host: LiveKernelHost,
  profile: LiveProfile,
  seenPorts: Set<number>,
  bridgeSent: boolean,
  appPrefix: string,
  readiness: WebReadinessState,
  dinitBootTracker: DinitBootStatusTracker,
  tick: (msg: string) => void,
  isCurrent: () => boolean,
): void {
  const web = profile.init?.web;
  if (!web) return;
  if (readiness.failed) return;
  const portsReady = web.requiredPorts.every((p) => seenPorts.has(p));
  const servicesReady = (web.requiredServices ?? []).every((serviceName) =>
    dinitBootTracker.hasSucceeded(serviceName),
  );
  if (!portsReady || !servicesReady || !bridgeSent) return;
  const readyMessage = web.probeHttp
    ? "HTTP bridge ready"
    : "Service stack ready";
  if (readiness.ready) {
    if (!isCurrent()) return;
    host.setWebPreview({
      label: web.label,
      url: appPrefix,
      port: HTTP_PORT,
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
      url: appPrefix,
      port: HTTP_PORT,
      status: "running",
      message: readyMessage,
    });
    return;
  }
  if (readiness.probing) return;
  readiness.probing = true;
  const probeUrl = previewUrlForPath(appPrefix, web.probePath ?? "/");
  host.setWebPreview({
    label: web.label,
    url: appPrefix,
    port: HTTP_PORT,
    status: "starting",
    message: web.probePath
      ? "Waiting for application readiness"
      : "Waiting for HTTP response",
  });
  void waitForHttpPreview(probeUrl, 90_000, {
    requireOk: Boolean(web.probePath),
  })
    .then(
      () => {
        if (!isCurrent() || readiness.failed) return;
        readiness.ready = true;
        tick("HTTP preview ready");
        host.setWebPreview({
          label: web.label,
          url: appPrefix,
          port: HTTP_PORT,
          status: "running",
          message: "HTTP bridge ready",
        });
      },
      (err) => {
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : String(err);
        host.setWebPreview({
          label: web.label,
          url: appPrefix,
          port: HTTP_PORT,
          status: "error",
          message: "HTTP preview did not become ready",
        });
        tick(`HTTP preview readiness failed: ${message}`);
      },
    )
    .finally(() => {
      if (!isCurrent()) return;
      readiness.probing = false;
    });
}

async function waitForHttpPreview(
  url: string,
  timeoutMs = 90_000,
  options: { requireOk?: boolean } = {},
): Promise<void> {
  const started = performance.now();
  let delayMs = 250;
  let lastError = "";

  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, 5_000);
      if (options.requireOk ? response.ok : response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(delayMs);
    delayMs = Math.min(1_500, Math.floor(delayMs * 1.4));
  }

  throw new Error(lastError || "timed out");
}

function previewUrlForPath(appPrefix: string, path: string): string {
  const root = new URL(appPrefix, window.location.href);
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return new URL(normalized || ".", root).href;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
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
  shell: ShellProfile,
): { env: string[]; cwd: string; uid: number; gid: number } {
  const serviceIds = new Set([
    "nginx",
    "nginx-php",
    "wordpress-sqlite",
    "wordpress-mariadb",
  ]);
  if (serviceIds.has(id)) {
    return {
      env: SERVICE_ENV,
      cwd: ROOT_HOME,
      uid: ROOT_UID,
      gid: ROOT_GID,
    };
  }
  if (id === "node" || shell === "node") {
    return {
      env: shellEnvFor(shell),
      cwd: shellCwdFor(shell),
      uid: DEMO_UID,
      gid: DEMO_GID,
    };
  }
  return {
    env: shellEnvFor(shell),
    cwd: shellCwdFor(shell),
    uid: DEMO_UID,
    gid: DEMO_GID,
  };
}

function envRecord(env: string[]): Record<string, string> {
  return Object.fromEntries(
    env.map((kv) => {
      const idx = kv.indexOf("=");
      return [kv.slice(0, idx), kv.slice(idx + 1)];
    }),
  );
}

function descriptorFor(id: string): BootDescriptor {
  const normalized = normalizeDemoId(id) ?? "shell";
  const spec = LIVE_DEMO_SPECS[normalized];
  const item =
    liveGalleryItems().find((p) => p.id === normalized) ??
    liveGalleryItems()[0];
  const shell = spec.shell ?? "default";
  const network = spec.network ?? false;
  const bootIdentity = descriptorBootIdentity(normalized, shell);
  return {
    version: 1,
    id: item.id,
    title: item.title,
    base: item.base,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: spec.memoryPages ?? 2048,
      features: [
        "shared-array-buffer",
        "pty",
        ...(spec.features ?? []),
        ...(network ? ["tcp-bridge"] : []),
      ],
      time: "real",
    },
    packages: item.packages,
    mounts: [
      {
        path: "/",
        source: "image",
        ref: `${item.id}.vfs@local`,
        readonly: false,
      },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: item.bootCommand,
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
    resolveVfsImageUrl: vfsImageUrlResolverForPreset(p.id),
    accent: p.accent,
    glyph: p.glyph,
    estimatedUrlBytes: p.estimatedUrlBytes,
  }));
}

function vfsImageUrlForPreset(id: string): string | undefined {
  const liveId = normalizeDemoId(id);
  if (!liveId) return undefined;
  const source = VFS_SOURCES[LIVE_DEMO_SPECS[liveId].image];
  if (source.kind !== "url") return undefined;
  const url = new URL(source.url, location.href);
  url.hash = liveId;
  return url.href;
}

function vfsImageUrlResolverForPreset(
  id: string,
): (() => Promise<string>) | undefined {
  const liveId = normalizeDemoId(id);
  if (!liveId) return undefined;
  const source = VFS_SOURCES[LIVE_DEMO_SPECS[liveId].image];
  // A "url" source already yields an eager vfsImageUrl via
  // vfsImageUrlForPreset. Every other kind (optional-demo AND
  // optional-binary) needs a lazy resolver so the gallery can produce a
  // shareable/navigable ?demo=&vfs= URL — resolveLiveVfsSourceUrl handles all
  // of them. Without this, optional-binary items (nginx, nginx-php) had no
  // way to resolve their image, so Launch fell back to an in-place descriptor
  // apply that never updated the address bar and Copy produced a dead link.
  if (source.kind === "url") return undefined;
  return async () => {
    const url = new URL(
      await resolveLiveVfsSourceUrl(source),
      location.href,
    );
    url.hash = liveId;
    return url.href;
  };
}

async function liveDemoIdForVfsImageUrl(
  vfsUrl: string,
  demo: string | null | undefined,
): Promise<LiveDemoId | null> {
  const image = await matchTrustedVfsSourceId(
    vfsUrl,
    (Object.keys(VFS_SOURCES) as LiveVfsImage[]).map((id) => ({
      id,
      resolveVfsImageUrl: () => resolveTrustedLiveVfsSourceUrl(VFS_SOURCES[id]),
    })),
  );
  if (!image) return null;

  const fragmentDemo = normalizeDemoId(
    new URL(vfsUrl, location.href).hash.slice(1),
  );
  const requestedDemo = normalizeDemoId(demo) ?? fragmentDemo;
  if (!requestedDemo) return DEFAULT_DEMO_FOR_VFS_IMAGE[image];

  // WHY: a demo selects launch behavior, while the matched image owns the VFS
  // bytes and capacity. Never apply a launch profile to a different image.
  return LIVE_DEMO_SPECS[requestedDemo].image === image ? requestedDemo : null;
}

async function resolveLiveVfsSourceUrl(source: LiveVfsSource): Promise<string> {
  if (source.kind === "url") {
    if (CANONICAL_PAGES_VFS_LOADER === undefined) return source.url;
    return (await CANONICAL_PAGES_VFS_LOADER.activate(source.productId)).imageUrl;
  }
  if (source.kind === "optional-demo") {
    return resolveOptionalDemoVfsUrl(
      source.image,
      undefined,
      undefined,
      CANONICAL_PAGES_VFS_LOADER === undefined
        ? undefined
        : async () => (await CANONICAL_PAGES_VFS_LOADER.activate(source.productId)).imageUrl,
    );
  }
  if (CANONICAL_PAGES_VFS_LOADER !== undefined) {
    return (await CANONICAL_PAGES_VFS_LOADER.activate(source.productId)).imageUrl;
  }
  return optionalBinaryUrl(source.relPaths, source.label);
}

async function resolveTrustedLiveVfsSourceUrl(source: LiveVfsSource): Promise<string> {
  if (CANONICAL_PAGES_VFS_LOADER !== undefined) {
    return (await CANONICAL_PAGES_VFS_LOADER.activate(source.productId)).imageUrl;
  }
  return resolveLiveVfsSourceUrl(source);
}

function normalizeDemoId(id: string | null | undefined): LiveDemoId | null {
  if (!id) return null;
  const normalized = DEMO_ALIASES[id] ?? id;
  return isLiveDemoId(normalized) ? normalized : null;
}

function isLiveDemoId(id: string): id is LiveDemoId {
  return Object.hasOwn(LIVE_DEMO_SPECS, id);
}

function readImageExperimentalTerminalSession(
  fs: MemoryFileSystem,
): ExperimentalTerminalSession {
  let stat;
  try {
    stat = fs.lstat(EXPERIMENTAL_TERMINAL_SESSION_PATH);
  } catch (err) {
    if (isMissingVfsPath(err)) {
      throw new Error(
        `VFS image is missing ${EXPERIMENTAL_TERMINAL_SESSION_PATH}`,
      );
    }
    throw err;
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} must be a regular file`,
    );
  }
  if (stat.size > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} exceeds ` +
        `${MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES} bytes`,
    );
  }
  const json = new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(readVfsFile(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH)),
  );
  return parseExperimentalTerminalSession(json);
}

function assertImageTerminalProgram(
  fs: MemoryFileSystem,
  program: ExperimentalTerminalProgram,
): void {
  const path = program.path;
  let stat;
  try {
    stat = fs.stat(path);
  } catch {
    throw new Error(`VFS image terminal program is missing: ${path}`);
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`VFS image terminal program is not a regular file: ${path}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`VFS image terminal program is not executable: ${path}`);
  }
}

function readImageConfig(fs: MemoryFileSystem): KandeloDemoConfig | null {
  return readKandeloDemoConfigFromVfs(fs);
}

function readOptionalVfsText(
  fs: MemoryFileSystem,
  path: string,
): string | null {
  const bytes = readOptionalVfsFile(fs, path);
  return bytes === null
    ? null
    : new TextDecoder().decode(new Uint8Array(bytes));
}

function readOptionalVfsFile(
  fs: MemoryFileSystem,
  path: string,
): ArrayBuffer | null {
  try {
    return readVfsFile(fs, path);
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
    if (!r.ok)
      throw new Error(`fetch failed for ${label}: ${r.status} ${r.statusText}`);
    return r;
  };
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KiB`;
}
