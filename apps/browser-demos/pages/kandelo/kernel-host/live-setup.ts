// Builds a LiveKernelHost over a real BrowserKernel for the Kandelo page.

import { BrowserKernel } from "@host/browser-kernel-host";
import { ensureServiceWorkerReady } from "../../../lib/init/service-worker-bridge";
import { setupServiceWorkerFetchBridge } from "../../../lib/init/sw-bridge-fetch";
import { bindImageOwnedRuntimeUrls } from "../../../lib/init/image-owned-runtime-urls";
import { BrowserInputSource } from "../../../../../host/src/input/browser-input-source";
import sdl2PlasmaFragSrc from "../../../../../programs/sdl2/presets/image/plasma.frag?raw";
import sdl2AudioBarsFragSrc from "../../../../../programs/sdl2/presets/image/audio_bars.frag?raw";
import sdl2TunnelwispFragSrc from "../../../../../programs/sdl2/presets/image/tunnelwisp.frag?raw";
import sdl2SoundSineFragSrc from "../../../../../programs/sdl2/presets/sound/sine.frag?raw";
import sdl2SoundTunnelwispFragSrc from "../../../../../programs/sdl2/presets/sound/tunnelwisp.frag?raw";
import sdl2SoundFmBellFragSrc from "../../../../../programs/sdl2/presets/sound/fm_bell.frag?raw";
import sdl2SoundNoiseSweepFragSrc from "../../../../../programs/sdl2/presets/sound/noise_sweep.frag?raw";
import sdl2SoundChordFragSrc from "../../../../../programs/sdl2/presets/sound/chord.frag?raw";
import { HttpBridgeHost } from "../../../lib/http-bridge";
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
import {
  WORDPRESS_MARIADB_READY_FILE,
  WORDPRESS_MARIADB_READY_PATH,
  WORDPRESS_MARIADB_READY_PHP,
  WORDPRESS_MARIADB_SOCKET_PATH,
} from "../../../lib/init/wordpress-mariadb-readiness";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
} from "../../../../../host/src/vfs/zip";
import { loadHomebrewBottleMirrorClosedAssets } from "../../../../../host/src/homebrew-bottle-mirror-browser";
import { HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH } from "../../../../../host/src/homebrew-bottle-mirror-plan";
import {
  loadClosedLazyAssetSources,
  type ClosedLazyAsset,
} from "../../../../../host/src/vfs/closed-lazy-assets";
import {
  composeBootDescriptorVfs,
  homebrewRuntimeLayerReferences,
} from "../../../lib/init/homebrew-package-layers";
import {
  publishRuntimeLayerPrivilegedPrograms,
  type RegisteredHomebrewRuntimeLayer,
} from "../../../../../host/src/homebrew-runtime-layer-consumer";
import type {
  PublishedPrivilegedProgramProduct,
  ReviewedPrivilegedProgramPolicy,
} from "../../../../../host/src/vfs/privileged-projection";
import {
  homebrewBootstrapClosedBinding,
  homebrewClosedAcceptanceAssetRoot,
} from "../../../lib/homebrew-closed-acceptance";
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
import { decompress as decompressZstd } from "fzstd";
import {
  LiveKernelHost,
  type BootDescriptor,
  type DemoPresentation,
  type GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { validateBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
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
  KANDELO_SHELL_CONFIG_PATH,
  MAX_KANDELO_SHELL_CONFIG_BYTES,
  MAX_KANDELO_SHELL_EXECUTABLE_BYTES,
  parseKandeloShellConfig,
  type KandeloShellConfig,
} from "../../../../../web-libs/kandelo-session/src/shell-config";
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
import { hasConfiguredDemoLogin } from "../../../../../images/vfs/lib/demo-login";
import { PRESET_LIBRARY } from "../presets";
import {
  OMARCHY_APPS,
  OMARCHY_APPS_DIR,
  OMARCHY_CONF_PATH,
  OMARCHY_THEME_DIR,
  OMARCHY_THEMES,
  OMARCHY_WLCOMPOSITOR_CONF,
  renderWallpaperKwlp,
} from "./omarchy-desktop";
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
  resolveCandidateEvidenceBootExecutable,
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
import { DEMO_TERMINAL_SESSION_POLICY } from "./demo-terminal-sessions";
import { stageConfiguredAssets } from "./configured-assets";
import { initializeDemoLoginKernel } from "./demo-login-loader";

import kernelWasmUrl from "@kernel-wasm?url";
import shellVfsUrl from "@binaries/programs/wasm32/shell.vfs.zst?url";
import dinitWasmUrl from "@binaries/programs/wasm32/dinit/dinit.wasm?url";
import dashWasmUrl from "@binaries/programs/wasm32/dash.wasm?url";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
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
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/kbar.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/kbar.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/klauncher.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/klauncher.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/knotify.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/knotify.wasm", {
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

type TomlValue = string | number | boolean;

type IndexBinaryEntry = Record<string, TomlValue | undefined> & {
  status?: TomlValue;
  archive_url?: TomlValue;
  browser_compatible?: TomlValue;
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
  "shell" | "node" | "nginx" | "nginx-php" | "wordpress" | "lamp";

type PagesVfsProductId =
  | "platform-rootfs"
  | "browser-main-shell"
  | "browser-node"
  | "browser-nginx"
  | "browser-nginx-php"
  | "browser-wordpress"
  | "browser-lamp";

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
    programUrl?: string;
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
  "wordpress-sqlite",
  "wordpress-mariadb",
  "doom",
  "modeset",
  "sdl2",
  "wayland",
  "hyprland",
  "omarchy",
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
      programUrl: dinitWasmUrl,
      maxWorkers: 6,
      web: { requiredPorts: [HTTP_PORT] },
    },
  },
  "nginx-php": {
    image: "nginx-php",
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
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
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
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
    maxVfsByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
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
  wayland: {
    image: "shell",
    features: ["kms"],
  },
  hyprland: {
    image: "shell",
    features: ["kms"],
  },
  omarchy: {
    image: "shell",
    features: ["kms"],
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
  /** Canonical built-in image family, or null for custom/software images. */
  image: LiveVfsImage | null;
  vfsUrl: string;
  vfsSource?: LiveVfsSource;
  candidateEvidence?: InjectedProtectedCandidateVfsV1;
  candidateVfsPlacement?: ProtectedCandidatePagesVfsPlacement;
  software?: SoftwareProfile;
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
   * Stage the Wayland stack — `wlcompositor` (a wl_shm/xdg_shell server
   * that drives /dev/dri/card0 via KMS) plus its `wlterm` client (a
   * libkwl VT100 terminal running a forkpty'd dash) — attach a
   * `BrowserInputSource`, then spawn the compositor and the terminal.
   * The compositor composites the client to card0; the Modeset pane
   * picks up PAGE_FLIP, and keyboard input routes through the compositor
   * to the shell. Runs until the terminal's shell exits.
   */
  waylandDemo: boolean;
  /**
   * Like waylandDemo, but boots `wlcompositor` with WLC_LAYOUT=dwindle so the
   * clients (two `wlterm` + a `wlclock`) tile into borderless slots and resize
   * to fill them. Browser-only page wiring; runs until the shell exits.
   */
  hyprlandDemo: boolean;
  /**
   * Like hyprlandDemo, plus the desktop shell Omarchy is made of: `kbar` on a
   * wlr-layer-shell surface reserving the top strip, `klauncher` on
   * SUPER/CTRL+Space, and the theme directory the compositor and both clients
   * read. This is the O1 milestone of
   * docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md.
   */
  omarchyDemo: boolean;
}

interface WebReadinessState {
  ready: boolean;
  probing: boolean;
}

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const BROWSER_CORS_PROXY = resolveBrowserCorsProxyConfig({
  configuredUrl: import.meta.env.VITE_CORS_PROXY_URL,
  development: import.meta.env.DEV,
  baseUrl: import.meta.env.BASE_URL,
  pageUrl: window.location.href,
});
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

// Staged to /etc/kandelo/wlcompositor.conf and read via WLC_CONFIG. The demo
// gate asserts the compositor loaded it (BINDS_LOADED source=…); the dwindle
// layout is selected separately by WLC_LAYOUT (the parser only reads binds).
// SUPER mirrors real Hyprland, but a browser reserves it (Cmd/Win), so every
// bind is duplicated on CTRL — the modifier that actually reaches the page.
const HYPRLAND_WLCOMPOSITOR_CONF = `# Kandelo wlcompositor — Hyprland-class tiling desktop (layout via WLC_LAYOUT).
# App-launch binds (the "new pane" chooser, done Hyprland-style with per-app
# keys rather than a launcher UI): Return spawns a terminal, K a clock (K as in
# clocK — Ctrl+C is left to the terminal's SIGINT), P a paint canvas. A browser
# reserves SUPER (=Cmd/Win), so every action is bound on CTRL too — that's the
# modifier users actually press in-browser. Note the compositor grabs bound
# combos before the focused client, so CTRL+W here shadows the terminal's
# werase (see docs/browser-support.md).
bind = SUPER, Return, exec, /usr/local/bin/wlterm
bind = CTRL, Return, exec, /usr/local/bin/wlterm
bind = SUPER, K, exec, /usr/local/bin/wlclock
bind = CTRL, K, exec, /usr/local/bin/wlclock
bind = SUPER, P, exec, /usr/local/bin/wlpaint
bind = CTRL, P, exec, /usr/local/bin/wlpaint
bind = SUPER, W, killactive
bind = CTRL, W, killactive
bind = SUPER, 1, workspace, 1
bind = SUPER, 2, workspace, 2
bind = SUPER, 3, workspace, 3
bind = SUPER, 4, workspace, 4
bind = SUPER, 5, workspace, 5
bind = SUPER, 6, workspace, 6
bind = SUPER, 7, workspace, 7
bind = SUPER, 8, workspace, 8
bind = SUPER, 9, workspace, 9
bind = CTRL, 1, workspace, 1
bind = CTRL, 2, workspace, 2
bind = CTRL, 3, workspace, 3
bind = CTRL, 4, workspace, 4
bind = CTRL, 5, workspace, 5
bind = CTRL, 6, workspace, 6
bind = CTRL, 7, workspace, 7
bind = CTRL, 8, workspace, 8
bind = CTRL, 9, workspace, 9
`;

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
  /** Product-owned reviewed authority; boot descriptors cannot construct it. */
  reviewedPrivilegedProgramPolicy?: ReviewedPrivilegedProgramPolicy;
  /** Separately published authority; image/config/descriptor data cannot mint it. */
  publishedPrivilegedProgramProduct?: PublishedPrivilegedProgramProduct;
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

  const initialDescriptor = protectedProfile?.descriptor ??
    await descriptorForBootQuery(opts.vfsUrl, opts.demo);
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
    );
    void requireServiceWorker()
      .then(() => refreshSoftwareGallery(host, localGalleryItems))
      .catch((err) => {
        console.warn("Service worker gate failed before gallery refresh:", err);
        host.setGalleryItems(localGalleryItems);
      });
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
    // Wayland demo: present the Modeset pane's canvas through the vblank
    // pump's WebGL2 scanout presenter (texture upload, shader-side
    // swizzle, GPU scaling at display resolution). In the browser the
    // compositor's GLES probe normally succeeds and its GL context then
    // claims the canvas for GPU compositing as the steady state — the
    // presenter covers boot (before the claim) and the permanent CPU
    // fallback if the probe or a GL frame fails. GL demos (modeset.c,
    // sdl2) keep the webgl2 default — the GL bridge claims their canvas on
    // eglCreateContext, and the pump never touches it.
    h.setKmsDisplayMode(
      profile.waylandDemo || profile.hyprlandDemo || profile.omarchyDemo
        ? "webgl2-scanout"
        : null,
    );
    const bootStartedAt = performance.now();

    try {
      const kernel = await bootProfile(
        h,
        profile,
        descriptor,
        bootStartedAt,
        () => seq === bootSeq,
        requireServiceWorker,
        opts.reviewedPrivilegedProgramPolicy,
        opts.publishedPrivilegedProgramProduct,
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
    software: undefined,
    descriptor: desc,
    init: profile.init === undefined
      ? undefined
      : {
        ...profile.init,
        // WHY: an explicit VFS image is a complete product closure. Fetching
        // the built-in init binary would hide an incomplete image and makes
        // canonical Pages depend on the forbidden legacy binary graph.
        programUrl: undefined,
      },
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
    software: undefined,
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
        // Candidate products own their complete executable closure. Pulling
        // dinit or another program from the default Vite graph would make
        // evidence pass with an incomplete candidate image.
        programUrl: undefined,
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
    waylandDemo: false,
    hyprlandDemo: false,
    omarchyDemo: false,
  };
}

function profileFor(id: string, fb?: FbDemo): LiveProfile {
  const software = SOFTWARE_PROFILES.get(id);
  if (software) {
    const desc = descriptorFor(id);
    return {
      id: software.id,
      image: null,
      vfsUrl: software.vfsArchiveUrl,
      software,
      descriptor: desc,
      shell: "default",
      maxVfsByteLength: DEFAULT_VFS_PROFILE_MAX_BYTES,
      autoCommand: software.autoCommand,
      fallbackPresentation: software.presentation,
      init: software.init,
      framebufferTest: false,
      sdl2Demo: false,
      waylandDemo: false,
      hyprlandDemo: false,
      omarchyDemo: false,
    };
  }

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
      // Canonical Pages products own their complete executable closure just
      // like an explicit VFS descriptor does. The legacy URL is available
      // only when the ordinary checked-out binary graph owns the image.
      programUrl: CANONICAL_PAGES_VFS_LOADER === undefined
        ? spec.init.programUrl
        : undefined,
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
    waylandDemo: normalized === "wayland",
    hyprlandDemo: normalized === "hyprland",
    omarchyDemo: normalized === "omarchy",
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
  } else if (
    profile.software?.shellEnv &&
    profile.software.shellEnv !== SERVICE_ENV
  ) {
    identity = {
      env: profile.software.shellEnv,
      cwd: DEMO_HOME,
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
    const normalized = `${this.outputTails.get(stream) ?? ""}${text}`.replace(
      /\r/g,
      "",
    );
    const lines = normalized.split("\n");
    this.outputTails.set(
      stream,
      text.endsWith("\n") ? "" : (lines.pop() ?? ""),
    );
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
  const match = stripAnsi(line)
    .trim()
    .match(/^\[(?:\s*OK\s*|FAILED)\]\s+(.+)$/);
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
  hasDinitctl: boolean;
  tracker: DinitBootStatusTracker;
  isCurrent: () => boolean;
  shouldStop?: () => boolean;
}): () => void {
  if (!options.hasDinitctl) return () => {};

  let stopped = false;
  void (async () => {
    const deadline = Date.now() + DINIT_STARTING_POLL_TIMEOUT_MS;
    let failures = 0;
    while (!stopped && options.isCurrent() && Date.now() < deadline) {
      if (options.shouldStop?.()) break;
      // The kernel owns the FS now, so the main thread can't stat the dinit
      // control socket. readDinitctlList probes it via an in-kernel
      // `dinitctl list`, which returns null until the socket is up.
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
  const { pid, exit } = await kernel.spawnFromVfs(
    DINITCTL_PATH,
    [DINITCTL_PATH, "-p", DINITCTL_SOCKET_PATH, "list"],
    {
      cwd: "/",
      uid: ROOT_UID,
      gid: ROOT_GID,
      pty: true,
    },
  );
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
  requireServiceWorker: (
    tick?: (msg: string) => void,
  ) => Promise<ServiceWorker>,
  reviewedPrivilegedProgramPolicy?: ReviewedPrivilegedProgramPolicy,
  publishedPrivilegedProgramProduct?: PublishedPrivilegedProgramProduct,
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
  const [kernelBytes, vfsBytes, softwareBinaries] = await Promise.all([
    fetch(kernelWasmUrl)
      .then(failOn("kernel.wasm"))
      .then((r) => r.arrayBuffer()),
    loadVfsImageBytes(profile),
    loadSoftwareBinaries(profile.software),
  ]);
  assertCurrent();

  tick(
    `kernel: ${kib(kernelBytes.byteLength)} · vfs: ${kib(vfsBytes.byteLength)}`,
  );
  const fetchedVfsImageBytes = new Uint8Array(vfsBytes);
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
  const runtimeLayers = homebrewRuntimeLayerReferences(requestedDescriptor);
  let buildFs: MemoryFileSystem;
  let registeredRuntimeLayers: RegisteredHomebrewRuntimeLayer[] = [];
  if (runtimeLayers.length > 0) {
    tick(
      `verifying ${runtimeLayers.length} selected runtime layer${
        runtimeLayers.length === 1 ? "" : "s"
      }...`,
    );
    const composed = await composeBootDescriptorVfs({
      descriptor: requestedDescriptor,
      baseImageBytes: fetchedVfsImageBytes,
      maxByteLength: profile.maxVfsByteLength,
      kernelAbi: ABI_VERSION,
      onStagedFileSystemDiscarded: trackTransientImageBuffer,
    });
    buildFs = composed.fs;
    registeredRuntimeLayers = composed.layers;
  } else {
    buildFs = MemoryFileSystem.fromImage(fetchedVfsImageBytes, {
      maxByteLength: profile.maxVfsByteLength,
    });
  }
  // Track as soon as the caller owns the staged filesystem. This covers every
  // later fetch, staging, supersession, and serialization failure; finalizing
  // the image is intentionally an idempotent second registration.
  trackTransientImageBuffer(buildFs.sharedBuffer);
  // WHY: register cleanup before rejecting a composition superseded while its
  // asynchronous layer loads were in flight. Otherwise its completed buffer
  // becomes unreachable without entering the WebKit reclamation ledger.
  assertCurrent();
  if (runtimeLayers.length > 0) {
    tick(
      "runtime layer files registered; archives remain lazy until first use",
    );
  }
  // WHY: establish cleanup ownership first, then reject forged imported seals
  // before URL rewriting or asset registration can trust their lazy metadata.
  await verifyImportedSealsForCurrentBoot(buildFs);
  // WHY: this check must live in the same continuation as the effects below.
  // Moving it into an async helper creates a microtask gap where a newer boot
  // can take ownership before this boot resumes mutating its staged image.
  assertCurrent();
  const shellConfig = readImageShellConfig(buildFs);
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
    bindImageOwnedRuntimeUrls(buildFs);
    if (profile.init?.programUrl) {
      tick(`staging ${profile.init.argv[0]}...`);
      const bytes = await fetch(profile.init.programUrl)
        .then(failOn(profile.init.argv[0]))
        .then((r) => r.arrayBuffer());
      assertCurrent();
      ensureDirRecursive(buildFs, dirname(profile.init.argv[0]));
      writeVfsBinary(buildFs, profile.init.argv[0], new Uint8Array(bytes), 0o755);
    }
    // The demo runs its binary from a path, so the bytes have to be in the
    // image before the worker takes exclusive ownership of the VFS.
    if (profile.sdl2Demo) {
      tick("staging sdl2...");
      await stageSdl2Runtime(buildFs);
      assertCurrent();
    }
    ensureDemoHomes(buildFs);
  }
  // Bake the shell + gallery-software binaries into the image before the
  // worker takes ownership. In the legacy path these were written into a
  // main-thread-shared memfs *after* boot via `kernel.fs`; the kernel-owned FS
  // has no main-thread handle, so they must be part of the image bytes.
  let shellProgramBytes: ArrayBuffer | undefined;
  let candidateShell: { path: string; argv: string[] } | undefined;
  if (
    profile.candidateEvidence !== undefined &&
    profile.init === undefined
  ) {
    // The candidate evidence VFS does not import fallback binaries. A missing
    // normal shell is an incomplete product, not permission to stage the
    // protected checkout's Bash or Dash into candidate bytes.
    const programPath = resolveCandidateEvidenceBootExecutable(
      buildFs,
      profile.candidateEvidence.boot,
    );
    candidateShell = {
      path: programPath,
      argv: profile.candidateEvidence.boot.argv.slice(),
    };
  } else if (shellConfig) {
    assertImageShellExecutable(buildFs, shellConfig.path);
  } else if (profile.candidateEvidence !== undefined) {
    throw new Error(
      "candidate service product lacks its image-owned shell configuration",
    );
  } else {
    const [bashBytes, dashBytes] = await Promise.all([
      fetch(bashWasmUrl)
        .then(failOn("bash.wasm"))
        .then((r) => r.arrayBuffer()),
      fetch(dashWasmUrl)
        .then(failOn("dash.wasm"))
        .then((r) => r.arrayBuffer()),
    ]);
    assertCurrent();
    stageShellUtilities(buildFs, dashBytes, bashBytes);
    shellProgramBytes = bashBytes;
  }
  if (profile.candidateEvidence === undefined) {
    stageSoftwareBinaries(buildFs, softwareBinaries);
  }
  const hasDinitctl = vfsPathExists(buildFs, DINITCTL_PATH);
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

  const closedLazyAssets = await loadProfileClosedLazyAssets(
    buildFs,
    tick,
    assertCurrent,
  );
  assertCurrent();

  let privilegedProduct = publishedPrivilegedProgramProduct;
  if (
    privilegedProduct === undefined &&
    reviewedPrivilegedProgramPolicy !== undefined &&
    hasConfiguredDemoLogin(buildFs)
  ) {
    tick("publishing reviewed privileged programs...");
    privilegedProduct = await publishRuntimeLayerPrivilegedPrograms(
      buildFs,
      registeredRuntimeLayers,
      reviewedPrivilegedProgramPolicy,
    );
    assertCurrent();
  }

  // Serialize the assembled image to transferable bytes, then let `buildFs`
  // go out of scope. `saveImage()` emits raw (uncompressed) bytes that
  // `MemoryFileSystem.fromImage` restores directly in the worker.
  tick("assembling kernel-owned VFS image...");
  // Serialize to transferable bytes + register the transient build buffer for
  // reclamation tracking, then let `buildFs` fall out of scope when bootProfile
  // returns. `settleAfterKernelDestroy` reclaims it on WebKit.
  const vfsImageBytes = await finalizeKernelOwnedImage(buildFs);
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
        ...(closedLazyAssets === undefined ? {} : { closedLazyAssets }),
      }
      : candidateEvidenceKernelInitOptions(
        profile.candidateEvidence,
        kernelBytes,
        vfsImageBytes,
        closedLazyAssets,
      );
    const loginSessionsEnabled = await initializeDemoLoginKernel({
      kernel,
      fs: buildFs,
      ...kernelInitOptions,
      ...(privilegedProduct === undefined ? {} : { privilegedProduct }),
    });
    assertCurrent();
    host.attachKernel(kernel);
    const shellIdentity = shellIdentityForProfile(
      profile,
      profile.init ? undefined : effectiveBoot,
    );
    if (loginSessionsEnabled) {
      host.setTerminalSessionPolicy(DEMO_TERMINAL_SESSION_POLICY);
    } else {
      // Custom and legacy images without the exact account, policy, message,
      // and reviewed login entry keep their declared shell identity.
      host.setDefaultShell({
        programPath: shellConfig?.path ?? "/bin/bash",
        ...(shellProgramBytes ? { programBytes: shellProgramBytes } : {}),
        argv: shellConfig?.argv ?? ["bash", "-l", "-i"],
        env: shellIdentity.env,
        cwd: shellIdentity.cwd,
        uid: shellIdentity.uid,
        gid: shellIdentity.gid,
      });
    }

    if (profile.init?.web) {
      tick("initializing HTTP bridge...");
      host.setWebPreview({
        label: profile.init.web.label,
        url: APP_PREFIX,
        status: "starting",
        message: "Waiting for services",
      });
      try {
        // Unique id for this machine instance. Scopes the service worker's
        // cookie jar so sessions never share cookies. Temporary instances get a
        // fresh random id per boot; when machines become persistable this is
        // where their durable id would be passed instead.
        const sessionId = crypto.randomUUID();
        await setupServiceWorkerFetchBridge(
          SW_URL,
          APP_PREFIX,
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
      // host by the time the acknowledgement returns, so do not attach its
      // poller or exit handlers to this superseded activation.
      assertCurrent();
      stopDinitStartingPoller = startDinitStartingPoller({
        kernel,
        hasDinitctl,
        tracker: dinitBootTracker,
        isCurrent,
        shouldStop: () => webReadiness.ready,
      });
      void initExit.then(
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
            new BrowserInputSource(window, { pointer: false, wheel: true }),
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
          // Keep-alive foreground client. Launch it through the non-forking
          // `spawn` path (like the clock + paint clients) instead of
          // runShellCommand, which makes the pts/0 shell fork()+exec the client.
          // That shell-fork intermittently fails to start the client under CI's
          // Linux headless-chromium worker scheduling, so it never connects
          // (CLIENT_CONNECTED count=3 never fires). `spawn` resolves on process
          // EXIT (it is used as an exitPromise in kernel-host.ts), so awaiting
          // it keeps the demo alive exactly as the foreground shell command did.
          await kernelForWayland.spawn(termBytes, ["wlterm"], {
            env: SHELL_ENV,
            cwd: DEMO_HOME,
            uid: DEMO_UID,
            gid: DEMO_GID,
          }).then(
            () => tick("wlterm exited"),
            (err: unknown) =>
              tick(`wlterm failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          tick(`wayland failed: ${msg}`);
        }
      })();
    } else if (profile.hyprlandDemo || profile.omarchyDemo) {
      // Like waylandDemo but with WLC_LAYOUT=dwindle: the compositor tiles its
      // clients and dictates each one's size via xdg configure, which the
      // libkwl/vt100 clients honor by rebuilding at the tile size (KWL_RESIZE).
      // That client-side resize is the crux — floating clients never resize.
      //
      // The omarchy demo is the same desktop with its shell on top: kbar on a
      // layer-shell surface, klauncher on SUPER+Space, and the theme set. Only
      // the extra staging and the two extra binaries differ, so it shares this
      // path rather than duplicating the KMS sizing and spawn ordering.
      const omarchy = profile.omarchyDemo;
      const kernelForHyprland = kernel;
      let omarchyBarBytes: ArrayBuffer | null = null;
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
          // wlpaint is staged so the CTRL+P launch bind can exec it on demand;
          // unlike the wayland demo it is not auto-spawned into the initial
          // layout (the user opens it via the keybind, the "new pane" flow).
          const wlpaintUrl = await optionalBinaryUrl([
            "../../../../../local-binaries/programs/wasm32/wlpaint.wasm",
            "../../../../../binaries/programs/wasm32/wlpaint.wasm",
          ], "wlpaint.wasm");
          const kbarUrl = omarchy
            ? await optionalBinaryUrl([
              "../../../../../local-binaries/programs/wasm32/kbar.wasm",
              "../../../../../binaries/programs/wasm32/kbar.wasm",
            ], "kbar.wasm")
            : null;
          const klauncherUrl = omarchy
            ? await optionalBinaryUrl([
              "../../../../../local-binaries/programs/wasm32/klauncher.wasm",
              "../../../../../binaries/programs/wasm32/klauncher.wasm",
            ], "klauncher.wasm")
            : null;
          const knotifyUrl = omarchy
            ? await optionalBinaryUrl([
              "../../../../../local-binaries/programs/wasm32/knotify.wasm",
              "../../../../../binaries/programs/wasm32/knotify.wasm",
            ], "knotify.wasm")
            : null;
          tick(omarchy ? "staging omarchy binaries..." : "staging hyprland binaries...");
          const [compBytes, termBytes, clockBytes, paintBytes] = await Promise.all([
            fetch(compositorUrl).then(failOn("wlcompositor.wasm")).then((r) => r.arrayBuffer()),
            fetch(wltermUrl).then(failOn("wlterm.wasm")).then((r) => r.arrayBuffer()),
            fetch(wlclockUrl).then(failOn("wlclock.wasm")).then((r) => r.arrayBuffer()),
            fetch(wlpaintUrl).then(failOn("wlpaint.wasm")).then((r) => r.arrayBuffer()),
          ]);
          ensureDirRecursive(kernelForHyprland.fs, "/usr/local/bin");
          writeVfsBinary(
            kernelForHyprland.fs,
            "/usr/local/bin/wlcompositor",
            new Uint8Array(compBytes),
            0o755,
          );
          writeVfsBinary(
            kernelForHyprland.fs,
            "/usr/local/bin/wlterm",
            new Uint8Array(termBytes),
            0o755,
          );
          writeVfsBinary(
            kernelForHyprland.fs,
            "/usr/local/bin/wlclock",
            new Uint8Array(clockBytes),
            0o755,
          );
          writeVfsBinary(
            kernelForHyprland.fs,
            "/usr/local/bin/wlpaint",
            new Uint8Array(paintBytes),
            0o755,
          );

          // The Omarchy desktop adds its shell: the bar and the launcher, plus
          // the files they and the compositor read — one config, one app
          // registry, one theme directory.
          if (omarchy) {
            const [barBytes, launcherBytes, notifyBytes] = await Promise.all([
              fetch(kbarUrl!).then(failOn("kbar.wasm")).then((r) => r.arrayBuffer()),
              fetch(klauncherUrl!).then(failOn("klauncher.wasm"))
                .then((r) => r.arrayBuffer()),
              fetch(knotifyUrl!).then(failOn("knotify.wasm"))
                .then((r) => r.arrayBuffer()),
            ]);
            writeVfsBinary(kernelForHyprland.fs, "/usr/local/bin/kbar",
              new Uint8Array(barBytes), 0o755);
            writeVfsBinary(kernelForHyprland.fs, "/usr/local/bin/klauncher",
              new Uint8Array(launcherBytes), 0o755);
            writeVfsBinary(kernelForHyprland.fs, "/usr/local/bin/knotify",
              new Uint8Array(notifyBytes), 0o755);
            omarchyBarBytes = barBytes;

            ensureDirRecursive(kernelForHyprland.fs, OMARCHY_APPS_DIR);
            for (const [name, body] of Object.entries(OMARCHY_APPS))
              writeVfsFile(kernelForHyprland.fs, `${OMARCHY_APPS_DIR}/${name}`,
                body, 0o644);
            for (const [name, theme] of Object.entries(OMARCHY_THEMES)) {
              ensureDirRecursive(kernelForHyprland.fs, `${OMARCHY_THEME_DIR}/${name}`);
              writeVfsFile(kernelForHyprland.fs,
                `${OMARCHY_THEME_DIR}/${name}/theme.conf`, theme.conf, 0o644);
              writeVfsBinary(kernelForHyprland.fs,
                `${OMARCHY_THEME_DIR}/${name}/background.kwlp`,
                renderWallpaperKwlp(theme), 0o644);
            }
          }

          ensureDirRecursive(kernelForHyprland.fs, "/etc/kandelo");
          writeVfsFile(
            kernelForHyprland.fs,
            OMARCHY_CONF_PATH,
            omarchy ? OMARCHY_WLCOMPOSITOR_CONF : HYPRLAND_WLCOMPOSITOR_CONF,
            0o644,
          );

          // Pointer is owned by the Modeset pane (event1); feed keyboard only.
          tick("attaching input source...");
          const WL_FB_W = 1920;
          const WL_FB_H = 1080;
          kernelForHyprland.attachInputSource(
            new BrowserInputSource(window, { pointer: false, wheel: false }),
            { width: WL_FB_W, height: WL_FB_H },
          );

          // Size the desktop from the Modeset pane's canvas exactly like
          // the wayland demo (see that block for the rationale).
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
              kernelForHyprland.kmsSetDisplaySize(
                1,
                displaySize.width,
                displaySize.height,
              );
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
            displaySize = host.getKmsDisplaySize(1);
          }

          // Clients retry their connect to /tmp/wayland-0, so the compositor
          // and clients can be spawned without an ordering barrier.
          tick("running wlcompositor...");
          const spawnBg = (bytes: ArrayBuffer, name: string, extraEnv: string[] = []) =>
            void kernelForHyprland.spawn(bytes, [name], {
              env: extraEnv.length ? [...SHELL_ENV, ...extraEnv] : SHELL_ENV,
              cwd: DEMO_HOME,
              uid: DEMO_UID,
              gid: DEMO_GID,
            }).then(
              () => tick(`${name} exited`),
              (err: unknown) =>
                tick(`${name} failed: ${err instanceof Error ? err.message : String(err)}`),
            );
          spawnBg(compBytes, "wlcompositor", [
            "WLC_LAYOUT=dwindle",
            "WLC_CONFIG=/etc/kandelo/wlcompositor.conf",
          ]);

          // The bar first: its exclusive zone must be reserved before the
          // windows tile, or they would lay out over the full output and be
          // re-configured a frame later.
          if (omarchyBarBytes) {
            tick("running kbar...");
            spawnBg(omarchyBarBytes, "kbar");
          }

          // The clock + first terminal run in the background; the foreground
          // terminal's shell keeps the demo alive (as waylandDemo does).
          tick("running wlclock + wlterm...");
          spawnBg(clockBytes, "wlclock");
          spawnBg(termBytes, "wlterm");

          tick("running wlterm...");
          // Keep-alive 3rd tiling client. Launch it through the non-forking
          // `spawn` path (like the clock + first terminal) instead of
          // runShellCommand, which makes the pts/0 shell fork()+exec the client.
          // That shell-fork races the first terminal's forkpty under CI's Linux
          // headless-chromium worker scheduling and intermittently fails to
          // start the client, so it never connects (CLIENT_CONNECTED count=3
          // never fires). `spawn` resolves on process EXIT (it is used as an
          // exitPromise in kernel-host.ts), so awaiting it keeps the demo alive
          // exactly as the foreground shell command did.
          await kernelForHyprland.spawn(termBytes, ["wlterm"], {
            env: SHELL_ENV,
            cwd: DEMO_HOME,
            uid: DEMO_UID,
            gid: DEMO_GID,
          }).then(
            () => tick("wlterm exited"),
            (err: unknown) =>
              tick(`wlterm failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          tick(`${omarchy ? "omarchy" : "hyprland"} failed: ${msg}`);
        }
      })();
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

    tick("ready");
    host.setStatus("running");
    return kernel;
  } catch (err) {
    stopDinitStartingPoller();
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

async function loadVfsImageBytes(profile: LiveProfile): Promise<ArrayBuffer> {
  if (profile.candidateEvidence !== undefined) {
    if (profile.candidateVfsPlacement === undefined) {
      throw new Error("candidate evidence VFS lacks its Pages placement boundary");
    }
    return profile.candidateVfsPlacement.bytes();
  }
  if (profile.vfsSource !== undefined && CANONICAL_PAGES_VFS_LOADER !== undefined) {
    return CANONICAL_PAGES_VFS_LOADER.bytes(profile.vfsSource.productId);
  }
  if (!profile.software) {
    const vfsUrl = await resolveProfileVfsUrl(profile);
    return fetch(vfsUrl)
      .then(failOn(`${profile.id}.vfs.zst`))
      .then((r) => r.arrayBuffer());
  }
  const vfsImage = await loadArchiveArtifact(
    profile.software.vfsArchiveUrl,
    profile.software.vfsArtifactPath,
  );
  const copy = new Uint8Array(vfsImage.byteLength);
  copy.set(vfsImage);
  return copy.buffer;
}

async function resolveProfileVfsUrl(profile: LiveProfile): Promise<string> {
  if (profile.vfsSource) return resolveLiveVfsSourceUrl(profile.vfsSource);
  if (profile.vfsUrl) return profile.vfsUrl;
  throw new Error(`No VFS image URL configured for ${profile.id}`);
}

async function loadSoftwareBinaries(
  software: SoftwareProfile | undefined,
): Promise<Array<{ spec: SoftwareBinary; bytes: Uint8Array }>> {
  if (!software) return [];
  return Promise.all(
    software.binaries.map(async (spec) => ({
      spec,
      bytes: await loadArchiveArtifact(spec.archiveUrl, spec.artifactPath),
    })),
  );
}

function stageSoftwareBinaries(
  fs: MemoryFileSystem,
  binaries: Array<{ spec: SoftwareBinary; bytes: Uint8Array }>,
): void {
  for (const { spec, bytes } of binaries) {
    ensureDirRecursive(fs, dirname(spec.installPath));
    writeVfsBinary(fs, spec.installPath, bytes, 0o755);
    for (const symlinkPath of spec.symlinks ?? []) {
      ensureDirRecursive(fs, dirname(symlinkPath));
      try {
        fs.symlink(spec.installPath, symlinkPath);
      } catch {
        /* exists */
      }
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

async function loadArchiveArtifact(
  archiveUrl: string,
  artifactPath: string,
): Promise<Uint8Array> {
  const archiveBytes = await fetchBytesNoStore(archiveUrl);
  const tarBytes = decompressZstd(archiveBytes);
  const artifact = extractTarFile(tarBytes, artifactPath);
  if (!artifact) {
    throw new Error(`${artifactPath} not found in ${archiveUrl}`);
  }
  return artifact;
}

function extractTarFile(
  tarBytes: Uint8Array,
  wantedPath: string,
): Uint8Array | undefined {
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
  return tarDecoder
    .decode(block.subarray(offset, offset + length))
    .replace(/\0.*$/, "");
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
  readiness: WebReadinessState,
  dinitBootTracker: DinitBootStatusTracker,
  tick: (msg: string) => void,
  isCurrent: () => boolean,
): void {
  const web = profile.init?.web;
  if (!web) return;
  const portsReady = web.requiredPorts.every((p) => seenPorts.has(p));
  const servicesReady = (web.requiredServices ?? []).every((serviceName) =>
    dinitBootTracker.hasCompleted(serviceName),
  );
  if (!portsReady || !servicesReady || !bridgeSent) return;
  const readyMessage = web.probeHttp
    ? "HTTP bridge ready"
    : "Service stack ready";
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
  const probeUrl = previewUrlForPath(web.probePath ?? "/");
  host.setWebPreview({
    label: web.label,
    url: APP_PREFIX,
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

function previewUrlForPath(path: string): string {
  const root = new URL(APP_PREFIX, window.location.href);
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
  software: SoftwareProfile | undefined,
  shell: ShellProfile,
): { env: string[]; cwd: string; uid: number; gid: number } {
  const serviceIds = new Set([
    "nginx",
    "nginx-php",
    "wordpress-sqlite",
    "wordpress-mariadb",
  ]);
  if (
    software?.init ||
    serviceIds.has(id) ||
    software?.shellEnv === SERVICE_ENV
  ) {
    return {
      env: software?.shellEnv ?? SERVICE_ENV,
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
    env: software?.shellEnv ?? shellEnvFor(shell),
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
  const software = SOFTWARE_PROFILES.get(id);
  const normalized = software ? "shell" : (normalizeDemoId(id) ?? "shell");
  const spec = LIVE_DEMO_SPECS[normalized];
  const item = software
    ? liveGalleryItems().find((p) => p.id === "shell")!
    : (liveGalleryItems().find((p) => p.id === normalized) ??
      liveGalleryItems()[0]);
  const shell = spec.shell ?? "default";
  const network = software ? false : (spec.network ?? false);
  const bootIdentity = descriptorBootIdentity(normalized, software, shell);
  return {
    version: 1,
    id: software?.id ?? item.id,
    title: software
      ? software.id.replace(/^kandelo-software-/, "")
      : item.title,
    base: software ? `kandelo:shell@abi${ABI_VERSION}` : item.base,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: software ? 4096 : (spec.memoryPages ?? 2048),
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
      {
        path: "/",
        source: "image",
        ref: `${software?.id ?? item.id}.vfs@local`,
        readonly: false,
      },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: software?.init
        ? software.init.argv
        : software
          ? ["bash", "-l", "-i"]
          : item.bootCommand,
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
  if (source.kind !== "optional-demo") return undefined;
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
    return CANONICAL_PAGES_VFS_LOADER?.activate(source.productId) ?? source.url;
  }
  if (source.kind === "optional-demo") {
    return resolveOptionalDemoVfsUrl(
      source.image,
      undefined,
      undefined,
      CANONICAL_PAGES_VFS_LOADER === undefined
        ? undefined
        : () => CANONICAL_PAGES_VFS_LOADER.activate(source.productId),
    );
  }
  if (CANONICAL_PAGES_VFS_LOADER !== undefined) {
    return CANONICAL_PAGES_VFS_LOADER.activate(source.productId);
  }
  return optionalBinaryUrl(source.relPaths, source.label);
}

async function resolveTrustedLiveVfsSourceUrl(source: LiveVfsSource): Promise<string> {
  if (CANONICAL_PAGES_VFS_LOADER !== undefined) {
    return CANONICAL_PAGES_VFS_LOADER.path(source.productId);
  }
  return resolveLiveVfsSourceUrl(source);
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
  const groups = await Promise.all(
    softwareManifestUrls().map(async (manifestUrl) => {
      try {
        return await loadSoftwareGalleryItemsFromManifest(manifestUrl);
      } catch (err) {
        console.warn(
          `Could not load Kandelo software gallery manifest ${manifestUrl}:`,
          err,
        );
        return [];
      }
    }),
  );
  return groups.flat();
}

async function loadSoftwareGalleryItemsFromManifest(
  manifestUrl: string,
): Promise<GalleryItem[]> {
  const resolvedManifestUrl = new URL(manifestUrl, location.href).href;
  const manifestText = await fetchTextNoStore(resolvedManifestUrl);
  const manifest = JSON.parse(manifestText) as SoftwareGalleryManifest;
  const sourceId = sourceIdForManifest(manifest, resolvedManifestUrl);
  const indexUrl = manifest.index_url
    ? new URL(manifest.index_url, resolvedManifestUrl).href
    : new URL("index.toml", resolvedManifestUrl).href;
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
  const queryUrls = params
    .getAll("softwareManifest")
    .flatMap(splitManifestUrls);
  const envUrls = splitManifestUrls(
    (import.meta.env.VITE_KANDELO_SOFTWARE_MANIFEST_URLS as
      string | undefined) ?? "",
  );
  const urls =
    queryUrls.length > 0
      ? queryUrls
      : envUrls.length > 0
        ? envUrls
        : [];
  return [...new Set(urls)];
}

function splitManifestUrls(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function sourceIdForManifest(
  manifest: SoftwareGalleryManifest,
  manifestUrl: string,
): string {
  const raw =
    manifest.source_id ??
    manifest.repository?.split("/").pop() ??
    new URL(manifestUrl, location.href).pathname
      .split("/")
      .filter(Boolean)[0] ??
    "software";
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  const profile = softwareProfileForEntry(
    id,
    entry,
    index,
    indexUrl,
    archiveUrl,
  );
  if (!profile) return null;
  SOFTWARE_PROFILES.set(id, profile);
  return {
    id,
    title: entry.title,
    summary: entry.description,
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
      binaries: [
        {
          archiveUrl: runtimeArchiveUrl,
          artifactPath: "artifacts/python.wasm",
          installPath: "/usr/bin/python",
          symlinks: [
            "/usr/bin/python3",
            "/usr/local/bin/python",
            "/usr/local/bin/python3",
          ],
        },
      ],
      shellEnv: [
        ...SHELL_ENV,
        "PYTHONHOME=/usr",
        "PYTHONDONTWRITEBYTECODE=1",
        "PYTHONNOUSERSITE=1",
      ],
      autoCommand:
        "python3 -c \"import sys, json; print('Python', sys.version.split()[0]); print(json.dumps({'kandelo': 'software'}))\"",
    };
  }

  if (entry.id.includes("perl")) {
    const runtimePackage = runtimePackageForEntry(entry, ["perl"]);
    const runtimeArchiveUrl = archiveUrlFor(index, indexUrl, runtimePackage);
    if (!runtimeArchiveUrl) return null;
    return {
      ...base,
      binaries: [
        {
          archiveUrl: runtimeArchiveUrl,
          artifactPath: "artifacts/perl.wasm",
          installPath: "/usr/bin/perl",
          symlinks: ["/usr/local/bin/perl"],
        },
      ],
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
      binaries: [
        {
          archiveUrl: runtimeArchiveUrl,
          artifactPath: "artifacts/erlang.wasm",
          installPath: "/usr/bin/erlang",
          symlinks: ["/usr/bin/erl", "/usr/local/bin/erl"],
        },
      ],
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
      autoCommand:
        "echo 'Redis VFS from kandelo-software'; ls -l /usr/local/bin/redis-server /etc/dinit.d/redis",
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
  const wasm32 = index.packages.get(packageKey(requirement))?.binary.wasm32;
  return (
    stringTomlValue(wasm32?.status) === "success" &&
    Boolean(stringTomlValue(wasm32?.archive_url)) &&
    booleanTomlValue(wasm32?.browser_compatible) === true
  );
}

function archiveUrlFor(
  index: SoftwareIndex,
  indexUrl: string,
  requirement: GalleryPackageRequirement | undefined,
): string | undefined {
  if (!requirement) return undefined;
  const archiveUrl = stringTomlValue(
    index.packages.get(packageKey(requirement))?.binary.wasm32?.archive_url,
  );
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

function parseTomlValue(value: string): TomlValue {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function stringTomlValue(value: TomlValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanTomlValue(value: TomlValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
        const parsed =
          typeof value === "number"
            ? value
            : Number.parseInt(String(value), 10);
        if (Number.isFinite(parsed)) abiVersion = parsed;
      }
      continue;
    }
    if (currentBinary) {
      currentBinary[key] = value;
    } else if (key === "name" || key === "version") {
      const stringValue = stringTomlValue(value);
      if (!stringValue) continue;
      currentPackage[key] = stringValue;
      if (currentPackage.name && currentPackage.version) {
        packages.set(
          `${currentPackage.name}@${currentPackage.version}`,
          currentPackage,
        );
      }
    }
  }

  return { abiVersion, packages };
}

async function fetchTextNoStore(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);
  return await response.text();
}

async function fetchBytesNoStore(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);
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
  const packageName =
    entry.packages[entry.packages.length - 1]?.name ?? entry.id;
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
  return Object.hasOwn(LIVE_DEMO_SPECS, id);
}

function readImageShellConfig(fs: MemoryFileSystem): KandeloShellConfig | null {
  let stat;
  try {
    stat = fs.lstat(KANDELO_SHELL_CONFIG_PATH);
  } catch (err) {
    if (isMissingVfsPath(err)) return null;
    throw err;
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`${KANDELO_SHELL_CONFIG_PATH} must be a regular file`);
  }
  if (stat.size > MAX_KANDELO_SHELL_CONFIG_BYTES) {
    throw new Error(
      `${KANDELO_SHELL_CONFIG_PATH} exceeds ${MAX_KANDELO_SHELL_CONFIG_BYTES} bytes`,
    );
  }
  const json = new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(readVfsFile(fs, KANDELO_SHELL_CONFIG_PATH)),
  );
  const config = parseKandeloShellConfig(json);
  if (!config) {
    throw new Error(
      `VFS image has unsupported ${KANDELO_SHELL_CONFIG_PATH} version`,
    );
  }
  return config;
}

async function loadProfileClosedLazyAssets(
  fs: MemoryFileSystem,
  tick: (message: string) => void,
  assertCurrent: () => void,
) {
  const bundleRoot = homebrewClosedAcceptanceAssetRoot(
    import.meta.env.MODE,
    import.meta.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT as
      string | undefined,
  );
  if (!bundleRoot) return undefined;
  // WHY: Node and service images are layered on the main shell and inherit
  // its deferred bottle URLs. The embedded mirror plan—not the gallery
  // profile label—is the authority that says an image needs the closed
  // pre-publication mirror.
  const embeddedPlan = readOptionalVfsFile(
    fs,
    HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  );
  if (embeddedPlan === null) return undefined;
  tick("verifying exact local Homebrew bottle mirror...");
  const embeddedPlanBytes = new Uint8Array(embeddedPlan);
  const bundle = await loadHomebrewBottleMirrorClosedAssets({
    embeddedPlanBytes,
    bundleRoot,
  });
  assertCurrent();
  const packageAssets = await loadHomebrewBootstrapClosedAssets(fs);
  assertCurrent();
  tick(
    `verified ${bundle.assets.length} exact deferred bottle payloads and ` +
      `${packageAssets.length} package source ` +
      `${packageAssets.length === 1 ? "tree" : "trees"}`,
  );
  return [...bundle.assets, ...packageAssets];
}

async function loadHomebrewBootstrapClosedAssets(
  fs: MemoryFileSystem,
): Promise<ClosedLazyAsset[]> {
  const binding = homebrewBootstrapClosedBinding(fs.getImageMetadata());
  const sourceUrl = resolveShellLazyArchiveUrl(binding.url);
  const closedUrl =
    `https://closed-lazy.kandelo.invalid/homebrew-bootstrap/` +
    `${binding.sha256}/${binding.output}`;
  // WHY: rewriteLazyArchiveUrls is filesystem-wide. Refuse an ambiguous source
  // URL so binding this one verified package cannot retarget another lazy tree.
  const pendingForSource = fs
    .exportLazyArchiveEntries()
    .filter((tree) =>
      tree.content?.transports.some((transport) => transport === sourceUrl),
    );
  if (
    pendingForSource.length !== 1 ||
    pendingForSource[0]!.content?.sha256 !== binding.sha256 ||
    pendingForSource[0]!.content?.bytes !== binding.bytes ||
    pendingForSource[0]!.content?.transports.length !== 1
  ) {
    throw new Error(
      "closed Homebrew image does not bind the Homebrew bootstrap source " +
        "to exactly one matching pending tree",
    );
  }
  // WHY: the worker's closed fetcher intentionally rejects every unbound URL.
  // Keep the Vite file as an acceptance-only transport source, then bind its
  // verified bytes to one canonical HTTPS identity before worker ownership.
  fs.rewriteLazyArchiveUrls((url) => (url === sourceUrl ? closedUrl : url));
  return loadClosedLazyAssetSources([
    {
      url: closedUrl,
      sourceUrl,
      sha256: binding.sha256,
      size: binding.bytes,
    },
  ]);
}

function assertImageShellExecutable(fs: MemoryFileSystem, path: string): void {
  let stat;
  try {
    stat = fs.stat(path);
  } catch {
    throw new Error(`VFS image default shell is missing: ${path}`);
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`VFS image default shell is not a regular file: ${path}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`VFS image default shell is not executable: ${path}`);
  }
  if (stat.size > MAX_KANDELO_SHELL_EXECUTABLE_BYTES) {
    throw new Error(
      `VFS image default shell exceeds ${MAX_KANDELO_SHELL_EXECUTABLE_BYTES} bytes: ${path}`,
    );
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
