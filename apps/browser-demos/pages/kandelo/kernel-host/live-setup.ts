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
  KANDELO_DEMO_CONFIG_PATH,
  genericDemoPresentation,
  resolveDefaultProfileId,
  resolveDemoAssets,
  resolveDemoDisplay,
  resolveDemoGuide,
  resolveDemoIdentity,
  resolveDemoIngest,
  resolveDemoInit,
  resolveDemoPresentation,
  resolveDemoRuntime,
  resolveDemoWeb,
  type DemoDisplayConfig,
  type DemoIdentityConfig,
  type DemoInitConfig,
  type DemoRuntimeConfig,
  type DemoWebConfig,
  type KandeloDemoConfig,
} from "../../../../../web-libs/kandelo-session/src/demo-config";
import { readKandeloDemoConfigFromVfs } from "../../../../../web-libs/kandelo-session/src/demo-config-vfs";
import { readDinitBootTargets } from "../../../../../web-libs/kandelo-session/src/dinit-boot-targets";
import {
  parseGalleryRoster,
  resolveEntryAvailability,
  type EntryAvailability,
  type RosterEntry,
} from "../../../../../web-libs/kandelo-session/src/gallery-roster";
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
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
  assertVfsImageFitsProfile,
  declaredVfsMaxByteLength,
} from "../../../../../web-libs/kandelo-session/src/vfs-capacity";
import {
  descriptorWithVfsImageUrl,
  demoIdFromVfsImageUrl,
  matchTrustedVfsSourceId,
  normalizeVfsImageUrl,
  profileIdFromVfsImageUrl,
  titleFromVfsImageUrl,
  vfsImageUrlFromDescriptor,
} from "../url-state";
import { TRACKED_DEMO_CONFIG_BY_PRODUCT } from "./tracked-demo-configs";
import galleryRosterSource from "../gallery-roster.json?raw";
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
  optionalDemoVfsIsBuilt,
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
import { DinitBootStatusTracker } from "./dinit-boot-status";

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
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ruby-todo-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ruby-todo-vfs.vfs.zst", {
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

// pid 1's environment, as HOST POLICY rather than machine identity.
//
// A machine booted through `init.target` gets its real per-service
// environment from the image's own dinit env-file
// (`/etc/dinit.d/env`, see images/vfs/scripts/dinit-image-helpers.ts), so
// dinit itself needs nothing from the host. A machine booted through
// `init.program` has no service manager at all (see
// images/vfs/products/browser-ruby-todo.toml, which deliberately ships no
// dinit tree), so nothing inside the image would otherwise establish the
// POSIX baseline every program expects. The host supplies that baseline
// uniformly, for every direct-program machine, never per machine id — and it
// is deliberately identical to the image-owned dinit baseline so the two
// shapes agree.
const PID1_BASELINE_ENV: string[] = [
  `HOME=${ROOT_HOME}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  `USER=root`,
  `LOGNAME=root`,
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

/**
 * The two env vars no baked artifact can know: they are computed from THIS
 * page's deployment prefix and protocol at boot time. Supplied to every
 * machine's init uniformly rather than to a list of WordPress ids, so the
 * host holds no machine identities. Unused names are inert.
 */
function hostSuppliedInitEnv(): string[] {
  return [`WP_APP_PATH=${APP_PATH}`, `WP_PROTO=${PROTO}`];
}

/**
 * The single launcher that turns an image-declared dinit TARGET into a
 * command. `demo.json` names which target to bring up; composing the
 * `dinit --container` invocation is the host's job, and it is one constant
 * shared by every dinit machine rather than an argv copied per machine.
 */
function dinitContainerArgv(target: string): string[] {
  return ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", target];
}

class BootSuperseded extends Error {
  constructor() {
    super("boot superseded");
  }
}

type PagesVfsProductId =
  | "platform-rootfs"
  | "browser-main-shell"
  | "browser-node"
  | "browser-nginx"
  | "browser-nginx-php"
  | "browser-wordpress"
  | "browser-lamp"
  | "browser-ruby-todo";

/** Every product the gallery can list, i.e. every one except the kernel's
 *  own platform rootfs. */
type GalleryProductId = Exclude<PagesVfsProductId, "platform-rootfs">;

/**
 * Where a product's VFS bytes come from in THIS deployment.
 *
 * This is artifact plumbing, not machine identity: it maps a product id to
 * the bytes on disk (or the Pages activation that serves them) and says
 * nothing about what machine those bytes contain. Everything a machine IS
 * comes from its own `/etc/kandelo/demo.json`.
 */
type VfsProductSource =
  | { kind: "url"; productId: GalleryProductId; url: string }
  | {
    kind: "optional-demo";
    image: OptionalDemoVfsImage;
    productId: GalleryProductId;
  }
  | {
    kind: "optional-binary";
    label: string;
    productId: GalleryProductId;
    relPaths: string[];
  };

const VFS_PRODUCTS: Record<GalleryProductId, VfsProductSource> = {
  "browser-main-shell": {
    kind: "url",
    productId: "browser-main-shell",
    url: shellVfsUrl,
  },
  "browser-node": {
    kind: "optional-demo",
    image: "node",
    productId: "browser-node",
  },
  "browser-nginx": {
    kind: "optional-binary",
    label: "nginx-vfs.vfs.zst",
    productId: "browser-nginx",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/nginx-vfs.vfs.zst",
      "../../../../../binaries/programs/wasm32/nginx-vfs.vfs.zst",
    ],
  },
  "browser-nginx-php": {
    kind: "optional-binary",
    label: "nginx-php-vfs.vfs.zst",
    productId: "browser-nginx-php",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
      "../../../../../binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    ],
  },
  "browser-wordpress": {
    kind: "optional-demo",
    image: "wordpress",
    productId: "browser-wordpress",
  },
  "browser-lamp": {
    kind: "optional-demo",
    image: "lamp",
    productId: "browser-lamp",
  },
  "browser-ruby-todo": {
    kind: "optional-binary",
    label: "ruby-todo-vfs.vfs.zst",
    productId: "browser-ruby-todo",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/ruby-todo-vfs.vfs.zst",
      "../../../../../binaries/programs/wasm32/ruby-todo-vfs.vfs.zst",
    ],
  },
};

/**
 * HOST POLICY for how large a product's live filesystem may grow. An image
 * asks for nothing here; the host decides, so an untrusted `?vfs=` image
 * cannot declare its own ceiling. The base shell image carries the full
 * utility set, so it gets the larger allowance; everything derived from it
 * gets the shell-derived allowance; anything the host does not recognise
 * gets the custom-image allowance.
 */
function maxVfsByteLengthForProduct(
  productId: GalleryProductId | null,
): number {
  if (productId === null) return CUSTOM_VFS_PROFILE_MAX_BYTES;
  return productId === "browser-main-shell"
    ? MAIN_SHELL_VFS_PROFILE_MAX_BYTES
    : SHELL_DERIVED_VFS_PROFILE_MAX_BYTES;
}

/**
 * HOST POLICY ceilings clamped over `runtime.requests` in `demo.json`. The
 * image REQUESTS; the host decides. `demo-config.ts` already rejects values
 * above its own parse-time ceiling; these are the narrower runtime limits
 * this deployment is willing to hand out.
 */
const HOST_MAX_WORKERS = 24;
const HOST_MAX_MEMORY_PAGES = 16384;
const HOST_DEFAULT_WORKERS = 4;
const HOST_DEFAULT_DESCRIPTOR_MEMORY_PAGES = 2048;

function clampRequest(
  requested: number | undefined,
  ceiling: number,
): number | undefined {
  return requested === undefined ? undefined : Math.min(requested, ceiling);
}

/**
 * The curated gallery roster. Membership only: every displayed byte comes
 * from the named product's own tracked/baked `demo.json`, never from here,
 * and an image cannot put itself on this list.
 */
const GALLERY_ROSTER = parseGalleryRoster(galleryRosterSource);

function galleryProductSource(productId: string): VfsProductSource | undefined {
  return Object.hasOwn(VFS_PRODUCTS, productId)
    ? VFS_PRODUCTS[productId as GalleryProductId]
    : undefined;
}

// Boot-resource reclamation (worker-owned live filesystems and transient
// image-build buffers) lives in the shared helper so every kernel-owned demo
// shares one implementation, including failures before a kernel exists.
async function settleAfterBootResourcesReleased(): Promise<void> {
  await settleWebKitReclaim();
}

/**
 * Everything the host knows about the machine it is ABOUT to boot, before
 * that machine's image has been read.
 *
 * Deliberately almost empty: which image, which profile of it was asked for,
 * and the host policy that applies to those bytes. What the machine IS — its
 * init, features, resource requests, panes, guide, readiness probe — comes
 * out of the image's own `/etc/kandelo/demo.json` inside `bootProfile`, and
 * from nowhere else.
 */
interface LiveProfile {
  /**
   * The profile id the caller asked for, or `null` to boot the image's own
   * declared `defaultProfile`. An id here that the image does not declare is
   * a LOUD failure, never a silent fall back to the default.
   */
  requestedProfileId: string | null;
  /** Which channel supplied `requestedProfileId`, so a rejection can name
   *  the thing the caller should fix. */
  requestedProfileSource:
    | "&profile="
    | "the image URL fragment"
    | "the boot descriptor"
    | null;
  /**
   * Both profile channels as they arrived: `&profile=` and the `#fragment`
   * on the `?vfs=` URL. Kept so a disagreement can be logged instead of
   * resolved in silence.
   */
  profileChannels: { query: string | null; fragment: string | null };
  /** Resolved product id when the image is one this deployment ships. */
  productId: GalleryProductId | null;
  vfsUrl: string;
  vfsSource?: VfsProductSource;
  candidateEvidence?: InjectedProtectedCandidateVfsV1;
  candidateVfsPlacement?: ProtectedCandidatePagesVfsPlacement;
  descriptor: BootDescriptor;
  maxVfsByteLength: number;
  /** App-level dev toggle (`?fb=test`). Explicitly NOT part of demo.json. */
  framebufferTest: boolean;
}

/**
 * The machine, as the image itself declares it. Every field here was read
 * out of the booting image's `/etc/kandelo/demo.json`.
 */
interface ImageMachine {
  profileId: string;
  identity: DemoIdentityConfig | null;
  runtime: DemoRuntimeConfig;
  init: DemoInitConfig | null;
  web: DemoWebConfig | null;
  display: DemoDisplayConfig | null;
}

/** How the host launches the machine's pid 1. */
interface InitLaunch {
  argv: string[];
  cwd: string;
  uid: number;
  gid: number;
  env: string[];
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

// fbtest is spawned directly by path+bytes (see spawnLazy below), not
// through the login/bash path that sources /etc/profile.d, so it still
// needs an explicit env from the caller. Every other shell and service
// identity now comes entirely from the image: the base shell's own
// /etc/profile.d/00-kandelo-shell.sh (see shell-lazy-archives.ts) and
// node's /etc/profile.d/kandelo-node-workspace.sh (see
// images/vfs/lib/init/spidermonkey-npm-runtime.ts) cover the interactive
// shells; dinit's per-service env-file covers the service demos.
const FBTEST_ENV: string[] = [
  `HOME=${DEMO_HOME}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  `USER=${DEMO_USER}`,
  `LOGNAME=${DEMO_USER}`,
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
];

export type FbDemo = "none" | "test";

export interface CreateLiveHostOptions {
  /**
   * `&profile=<id>` — which machine inside the image to boot. The app knows
   * no profile names; an id the image does not declare is a loud boot error,
   * never a silent fall back to the image's default.
   */
  profile?: string | null;
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
    await descriptorForBootQuery(opts.vfsUrl, opts.profile);
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
      // A descriptor applied in place (gallery launch, pasted link) carries
      // its own profile. The page's `&profile=` belongs to the machine the
      // visitor ARRIVED on and must not follow them onto a different image.
      await startBoot(h, profileForDescriptor(desc, "none", null), desc);
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
      profileForDescriptor(initialDescriptor, opts.fb, opts.profile ?? null),
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

/**
 * The boot descriptor for the requested URL, BEFORE the image has been read.
 *
 * Almost nothing here is machine identity: a first boot descriptor can only
 * describe which image to fetch and which profile of it was asked for. Title,
 * packages, features, argv, and caps are placeholders that `bootProfile`
 * replaces the moment the image's own `/etc/kandelo/demo.json` has been
 * parsed. That order is deliberate — the gallery's aggregate of tracked
 * sources never feeds the boot path, so the listing and the machine cannot
 * disagree about what runs.
 */
async function descriptorForBootQuery(
  vfsUrl: string | null | undefined,
  profileId: string | null | undefined,
): Promise<BootDescriptor> {
  const normalizedVfsUrl = normalizeVfsImageUrl(vfsUrl)
    ?? await defaultVfsImageUrl();
  const base = provisionalDescriptor(normalizedVfsUrl);
  const fragmentProfile = profileIdFromVfsImageUrl(normalizedVfsUrl);
  const selected = nonEmptyId(profileId) ?? fragmentProfile;
  return descriptorWithVfsImageUrl(base, normalizedVfsUrl, {
    id: selected ?? demoIdFromVfsImageUrl(normalizedVfsUrl),
    title: titleFromVfsImageUrl(normalizedVfsUrl),
    packages: [],
  });
}

/**
 * With no `?vfs=` at all, boot the first machine on the curated roster. The
 * app picks a ROSTER POSITION, not a machine: what that entry is comes from
 * its product's own image.
 */
async function defaultVfsImageUrl(): Promise<string> {
  const entry = GALLERY_ROSTER.entries[0];
  const source = galleryProductSource(entry.product);
  if (source === undefined) {
    throw new Error(
      `gallery roster's first entry names unknown product ${
        JSON.stringify(entry.product)
      }`,
    );
  }
  const url = new URL(await resolveVfsProductUrl(source), location.href);
  url.hash = entry.profile;
  return url.href;
}

/**
 * A descriptor shaped enough to satisfy `validateBootDescriptor` before any
 * image bytes exist. `boot.argv` must be non-empty there, so this carries the
 * default interactive login session every Kandelo image can run; `bootProfile`
 * overwrites the whole boot block with the image's declared init as soon as
 * `/etc/kandelo/demo.json` is parsed.
 */
function provisionalDescriptor(vfsImageUrl: string): BootDescriptor {
  return {
    version: 1,
    id: demoIdFromVfsImageUrl(vfsImageUrl),
    title: titleFromVfsImageUrl(vfsImageUrl),
    base: `kandelo:shell@abi${ABI_VERSION}`,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: HOST_DEFAULT_DESCRIPTOR_MEMORY_PAGES,
      features: ["shared-array-buffer", "pty"],
      time: "real",
    },
    packages: [],
    mounts: [
      { path: "/", source: "image", ref: vfsImageUrl, readonly: false },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: ["bash", "-l", "-i"],
      cwd: DEMO_HOME,
      env: {},
      uid: DEMO_UID,
      gid: DEMO_GID,
    },
    caps: { network: false },
  };
}

function profileForDescriptor(
  desc: BootDescriptor,
  fb: FbDemo | undefined,
  queryProfileId: string | null,
): LiveProfile {
  const vfsUrl = vfsImageUrlFromDescriptor(desc) ?? "";
  const fragmentProfileId = vfsUrl ? profileIdFromVfsImageUrl(vfsUrl) : null;
  // A descriptor applied in place carries its profile as its id. Ignore the
  // id when it is only the placeholder `descriptorForBootQuery` derived from
  // the image FILENAME — that is not a profile anybody asked for, and
  // treating it as one would fail a bare `?vfs=` boot that should have used
  // the image's declared default.
  const descriptorProfileId = vfsUrl && desc.id === demoIdFromVfsImageUrl(vfsUrl)
    ? null
    : nonEmptyId(desc.id);
  const requestedProfileId = queryProfileId ?? fragmentProfileId
    ?? descriptorProfileId;
  return {
    requestedProfileId,
    requestedProfileSource: queryProfileId !== null
      ? "&profile="
      : fragmentProfileId !== null
      ? "the image URL fragment"
      : descriptorProfileId !== null
      ? "the boot descriptor"
      : null,
    profileChannels: { query: queryProfileId, fragment: fragmentProfileId },
    // Which product (if any) these bytes are is resolved asynchronously in
    // `bootProfile`, because matching a URL to a product may have to activate
    // a Pages product to learn its URL. Until then the host assumes the
    // widest, least trusting policy.
    productId: null,
    maxVfsByteLength: CUSTOM_VFS_PROFILE_MAX_BYTES,
    vfsUrl,
    descriptor: desc,
    framebufferTest: fb === "test",
  };
}

/**
 * Bind the image URL to a product this deployment ships, when it is one, and
 * apply that product's host policy.
 *
 * A third-party `?vfs=` URL simply has no product: it travels the SAME code
 * path under the custom-image policy, and its machine still comes entirely
 * from its own `demo.json`. There is no separate "custom VFS" profile any
 * more — that asymmetry is what this work removes.
 */
async function bindVfsProduct(profile: LiveProfile): Promise<LiveProfile> {
  if (profile.candidateEvidence !== undefined) return profile;
  // A descriptor that names no image (an older pasted link that carried only
  // a script) gets the same image a bare page load gets: the roster's first
  // entry. That is the app choosing a DEFAULT MACHINE, which it is allowed to
  // do — not inventing one, which it is not.
  profile = profile.vfsUrl
    ? profile
    : { ...profile, vfsUrl: await defaultVfsImageUrl() };
  // Fast path for a product whose URL is statically known (the base shell
  // image). The asynchronous match has to resolve EVERY product to compare
  // URLs, and under a Pages deployment resolving a product activates it —
  // i.e. fetches and verifies its image. Answering the common case without
  // that avoids pulling six images the visitor did not ask for.
  const productId = eagerProductIdForVfsUrl(profile.vfsUrl)
    ?? await matchTrustedVfsProductId(profile.vfsUrl);
  return {
    ...profile,
    productId,
    ...(productId === null ? {} : { vfsSource: VFS_PRODUCTS[productId] }),
    maxVfsByteLength: maxVfsByteLengthForProduct(productId),
  };
}

function nonEmptyId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function profileForCandidateEvidence(
  evidence: InjectedProtectedCandidateVfsV1,
  placement: ProtectedCandidatePagesVfsPlacement,
): LiveProfile {
  // The allow-list here is a protected-path boundary, not a machine table:
  // it decides which evidence profiles the live Kandelo page will host at
  // all. The machine itself still comes from the candidate image.
  const profileId = candidateEvidenceLiveDemoId(evidence.vfs.profile);
  const productId = Object.hasOwn(VFS_PRODUCTS, evidence.vfs.productId)
    ? (evidence.vfs.productId as GalleryProductId)
    : null;
  const descriptor = candidateEvidenceBootDescriptor(
    provisionalDescriptor(evidence.vfs.url),
    evidence,
  );
  return {
    requestedProfileId: profileId,
    requestedProfileSource: null,
    profileChannels: { query: null, fragment: null },
    productId,
    vfsUrl: evidence.vfs.url,
    vfsSource: undefined,
    descriptor,
    maxVfsByteLength: maxVfsByteLengthForProduct(productId),
    candidateEvidence: evidence,
    candidateVfsPlacement: placement,
    framebufferTest: false,
  };
}

/**
 * Which profile of the image to boot, per the spec's resolution order:
 * `&profile=`, else the `#fragment` on the image URL, else the image's own
 * `defaultProfile`. An id the image does not declare is a loud failure.
 */
function resolveImageProfileId(
  config: KandeloDemoConfig,
  profile: LiveProfile,
  tick: (msg: string) => void,
): string {
  const { query, fragment } = profile.profileChannels;
  if (query !== null && fragment !== null && query !== fragment) {
    // Both channels are legitimate (see the spec's "Two profile channels,
    // both kept"), so the override wins — but say so rather than dropping
    // the loser in silence.
    tick(
      `&profile=${query} overrides the image URL fragment #${fragment}`,
    );
  }
  const declared = declaredProfileIds(config);
  const requested = profile.requestedProfileId;
  if (requested !== null) {
    if (declared.includes(requested)) return requested;
    // A profile id nobody declared is a real boundary: refusing to guess is
    // what keeps `&profile=` from silently booting a different machine.
    throw new Error(
      `${profile.requestedProfileSource ?? "the request"} selected profile ${
        JSON.stringify(requested)
      }, which this image's ${KANDELO_DEMO_CONFIG_PATH} does not declare`
        + ` (declared: ${declared.length > 0 ? declared.join(", ") : "none"})`,
    );
  }
  if (declared.length === 0) return TOP_LEVEL_PROFILE_ID;
  const defaultProfileId = resolveDefaultProfileId(config);
  if (defaultProfileId === null) {
    throw new Error(
      `${KANDELO_DEMO_CONFIG_PATH} declares ${declared.length} profiles but no`
        + ` defaultProfile; select one with &profile= (declared: ${
          declared.join(", ")
        })`,
    );
  }
  return defaultProfileId;
}

/**
 * An image may put its whole machine at the top level with no `profiles`
 * block at all. The resolvers already fall back to the top level for an
 * unknown profile id, so this sentinel selects exactly that.
 */
const TOP_LEVEL_PROFILE_ID = "";

function declaredProfileIds(config: KandeloDemoConfig): string[] {
  const profiles = config.profiles;
  return profiles !== undefined && profiles !== null && !Array.isArray(profiles)
    ? Object.keys(profiles)
    : [];
}

/** Read the whole machine out of the image, for one selected profile. */
function imageMachine(
  config: KandeloDemoConfig,
  profileId: string,
): ImageMachine {
  return {
    profileId,
    identity: resolveDemoIdentity(config, profileId),
    runtime: resolveDemoRuntime(config, profileId),
    init: resolveDemoInit(config, profileId),
    web: resolveDemoWeb(config, profileId),
    display: resolveDemoDisplay(config, profileId),
  };
}

/**
 * Turn the image's declared `init` into the pid-1 launch.
 *
 * `demo.json` SELECTS (which dinit target, or which program in the image);
 * the host composes the launcher and supplies pid 1's baseline identity as
 * policy. Neither shape lets anything outside the image name what runs.
 */
function initLaunchForMachine(init: DemoInitConfig): InitLaunch {
  if ("target" in init) {
    return {
      argv: dinitContainerArgv(init.target),
      cwd: ROOT_HOME,
      uid: ROOT_UID,
      gid: ROOT_GID,
      // dinit's services read the image's own /etc/dinit.d/env, so the only
      // thing the host adds is what no baked artifact can know.
      env: hostSuppliedInitEnv(),
    };
  }
  return {
    argv: [init.program, ...init.args],
    cwd: init.cwd ?? ROOT_HOME,
    uid: ROOT_UID,
    gid: ROOT_GID,
    env: [...PID1_BASELINE_ENV, ...hostSuppliedInitEnv()],
  };
}

/**
 * The readiness service list, derived from the image's own dinit tree
 * instead of a hand-maintained copy: the transitive `depends-on` closure of
 * the target `demo.json` selected, including the target itself. A dependency
 * with no `/etc/dinit.d/<name>` file throws, naming it — a machine that can
 * never become ready is a defect, not something to wait out.
 */
function dinitServiceClosure(
  fs: MemoryFileSystem,
  target: string,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const pending = [target];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
    if (seen.size > MAX_DINIT_SERVICE_CLOSURE) {
      throw new Error(
        `image dinit tree exceeds ${MAX_DINIT_SERVICE_CLOSURE} services`,
      );
    }
    for (const dependency of readDinitBootTargets(fs, name)) {
      pending.push(dependency);
    }
  }
  return ordered;
}

/** Far above any real service tree; a hostile image cannot spin this. */
const MAX_DINIT_SERVICE_CLOSURE = 256;

function envArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function presentationForWebMachine(
  web: DemoWebConfig | null,
  presentation: DemoPresentation,
): DemoPresentation {
  // Older released VFS images put Terminal before Syslog for web demos,
  // which briefly focuses a shell while dinit is still bringing services up.
  // Keyed on the machine DECLARING a web readiness probe, not on an id list.
  if (
    web === null ||
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
  webPaneLabel: string | null,
  message: string,
  tick: (msg: string) => void,
): void {
  tick(message);
  if (webPaneLabel !== null) {
    host.setWebPreview({
      label: webPaneLabel,
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
  // Reassigned once the image URL has been matched to a product; see
  // `bindVfsProduct`.
  // eslint-disable-next-line prefer-const
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
  // Nothing is known about the machine yet; the image has not been fetched.
  // The real presentation lands as soon as /etc/kandelo/demo.json is parsed.
  host.setPresentation(genericDemoPresentation("terminal"));
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
  // Filled from the image's own dinit tree once it has been read. It is a
  // live set rather than a value so the tracker, which must exist before the
  // image is fetched, watches the services the image actually declares.
  const requiredServices = new Set<string>();
  let webPaneLabel: string | null = null;
  const dinitBootTracker = new DinitBootStatusTracker(tick, (completion) => {
    if (
      completion.outcome === "failed" &&
      requiredServices.has(completion.serviceName)
    ) {
      if (webReadiness.failed) return;
      webReadiness.failed = true;
      reportInitError(
        host,
        webPaneLabel,
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

  // Resolve which product these bytes are BEFORE fetching them: a Pages
  // deployment serves its products through an integrity-checked activation,
  // and the host's capacity policy depends on the same answer.
  profile = await bindVfsProduct(profile);
  assertCurrent();

  tick("service worker active and cross-origin isolated");
  tick(`loading ${imageLabel(profile)}...`);
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
    imageLabel(profile),
  );
  MemoryFileSystem.assertImageKernelAbi(
    fetchedVfsImageBytes,
    ABI_VERSION,
    imageLabel(profile),
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
    // Keyed on what the image ACTUALLY CONTAINS, never on a machine id: an
    // image that ships a PHP-FPM config gets the host's worker-pool patch, and
    // one that ships WordPress gets the runtime wp-config this page's prefix
    // and protocol determine (which no baked artifact can know). Whether that
    // WordPress talks to MariaDB is likewise read off the image's own dinit
    // tree.
    if (vfsPathExists(buildFs, "/etc/php-fpm.conf")) {
      writeVfsFile(buildFs, "/etc/php-fpm.conf", PATCHED_PHP_FPM_CONF);
      ensureDirRecursive(buildFs, "/var/cache/opcache");
    }
    if (vfsPathExists(buildFs, "/var/www/html/wp-includes")) {
      if (vfsPathExists(buildFs, "/etc/dinit.d/mariadb")) {
        patchMariaDbUnixSocketConfig(buildFs);
        patchWordPressRuntimeConfig(buildFs, "mariadb");
      } else {
        patchWordPressRuntimeConfig(buildFs, "sqlite");
      }
    }
    ensureDemoHomes(buildFs);
  }
  assertImageTerminalProgram(buildFs, terminalSession.initial);
  if (terminalSession.afterExit !== undefined) {
    assertImageTerminalProgram(buildFs, terminalSession.afterExit);
  }
  // ── The machine, read from the image it lives in ────────────────────────
  //
  // Nothing below consults an app-side table. An image with no
  // /etc/kandelo/demo.json, or a malformed one, fails the boot here with the
  // real reason: there is no fallback machine to synthesize any more.
  const imageConfig = readImageConfig(buildFs);
  if (imageConfig === null) {
    throw new Error(
      `VFS image has no ${KANDELO_DEMO_CONFIG_PATH}, so it does not describe`
        + " a machine. Kandelo boots what the image declares; it does not"
        + " invent a default.",
    );
  }
  const machine = imageMachine(
    imageConfig,
    resolveImageProfileId(imageConfig, profile, tick),
  );
  const profileId = machine.profileId;
  const machineTitle = machine.identity?.title
    ?? (profile.vfsUrl ? titleFromVfsImageUrl(profile.vfsUrl) : profileId);
  const rawPresentation = resolveDemoPresentation(imageConfig, profileId)
    ?? genericPresentationForMachine(machine, profile.framebufferTest);
  const presentation = presentationForWebMachine(machine.web, rawPresentation);
  host.setPresentation(presentation);
  host.setDemoGuide(resolveDemoGuide(imageConfig, profileId));
  // Ingest is an image-owned capability. Absence is valid and must not be
  // replaced with a package- or profile-name-specific UI promise.
  host.setDemoIngest(resolveDemoIngest(imageConfig, profileId));
  const assets = resolveDemoAssets(imageConfig, profileId);
  const initLaunch = machine.init === null
    ? null
    : profile.candidateEvidence === undefined
    ? initLaunchForMachine(machine.init)
    : {
      // A protected ABI-staging candidate pins its whole boot block as
      // evidence; honouring the image's init instead would measure a
      // different machine than the one the evidence attests.
      argv: profile.candidateEvidence.boot.argv.slice(),
      cwd: profile.candidateEvidence.boot.cwd,
      uid: profile.candidateEvidence.boot.uid,
      gid: profile.candidateEvidence.boot.gid,
      env: envArray(profile.candidateEvidence.boot.env),
    };
  if (machine.init !== null && "target" in machine.init) {
    for (const service of dinitServiceClosure(buildFs, machine.init.target)) {
      requiredServices.add(service);
    }
  }
  if (machine.web !== null) webPaneLabel = machineTitle;
  host.setDescriptor(
    descriptorForMachine(profile, machine, machineTitle, requestedDescriptor),
  );
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
      machine.web,
      machineTitle,
      requiredServices,
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
      // The image REQUESTS; the host clamps. An untrusted `?vfs=` image
      // cannot hand itself a worker flood or a gigabyte ceiling.
      maxWorkers: clampRequest(
        machine.runtime.requests.maxWorkers,
        HOST_MAX_WORKERS,
      ) ?? HOST_DEFAULT_WORKERS,
      maxMemoryPages: clampRequest(
        machine.runtime.requests.memoryPages,
        HOST_MAX_MEMORY_PAGES,
      ),
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

    if (machine.web !== null) {
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
          label: machineTitle,
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
          label: machineTitle,
          url: APP_PREFIX,
          port: HTTP_PORT,
          status: "error",
          message: "HTTP bridge unavailable",
        });
      }
    }

    if (initLaunch !== null) {
      // BOOT IDENTITY COMES FROM THE IMAGE. A descriptor the caller supplied
      // (a pasted #k1= link, a gallery apply) can carry an argv, because every
      // link ShareDialog has ever produced spreads the authoring machine's
      // whole boot block. That argv is IGNORED rather than rejected — so old
      // links still boot — but the drop is announced instead of silent.
      if (
        !sameArgv(requestedDescriptor.boot.argv, initLaunch.argv) &&
        requestedDescriptor.boot.argv.length > 0
      ) {
        tick(
          "ignoring the boot descriptor's init argv: this machine's pid 1"
            + ` comes from its image (${initLaunch.argv.join(" ")})`,
        );
      }
      const initArgv = initLaunch.argv;
      tick(`spawning ${initArgv[0]}...`);
      // The init binary lives in the kernel-owned VFS; spawn it by path rather
      // than shipping bytes the kernel already has.
      const { exit: initExit } = await kernel.spawnFromVfs(
        initArgv[0],
        initArgv,
        {
          env: initLaunch.env,
          cwd: initLaunch.cwd,
          uid: initLaunch.uid,
          gid: initLaunch.gid,
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
            webPaneLabel,
            `${initArgv[0] ?? "init"} exited with code ${code}`,
            tick,
          );
        },
        (err) => {
          if (!isCurrent()) return;
          reportInitError(
            host,
            webPaneLabel,
            `init failed: ${err instanceof Error ? err.message : String(err)}`,
            tick,
          );
        },
      );
    }

    maybeUpdateWebReadiness();

    // ── Input, then the command ─────────────────────────────────────────
    //
    // The old ladder (framebufferTest → sdl2 → espeak → evdev → runScript →
    // autoCommand) named six machines. It collapses to: attach an input
    // source when the image DECLARES it needs one, then run the one command.
    // Attachment has to precede the command because a program that polls
    // /dev/input/event{0,1} misses everything delivered before it starts.
    if (machine.runtime.features.includes("evdev-input")) {
      attachDeclaredInputSource(kernel, machine, tick);
    }

    if (profile.framebufferTest) {
      // `?fb=test` is an APP-LEVEL DEV TOGGLE, deliberately not expressible
      // in demo.json: it spawns a host-fetched framebuffer probe over
      // whatever machine is booting.
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
            webPaneLabel,
            `boot-link script failed: boot.parameters.runScript names an ` +
              `unmaterialized input: ${JSON.stringify(runScriptId)}`,
            tick,
          );
        }
      } else {
        if (presentation.autoCommand !== undefined) {
          // The link wins, matching what the ladder always did — but the
          // machine's own command is not dropped in silence.
          tick(
            "boot-link script replaces the machine's configured command: "
              + presentation.autoCommand,
          );
        }
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
    } else if (presentation.autoCommand !== undefined) {
      const autoCommand = presentation.autoCommand;
      tick(`running ${autoCommand}...`);
      void host.runShellCommand(autoCommand).then(
        () => tick(`${autoCommand} exited`),
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          // A machine whose configured command never returns (an editor, an
          // input logger) trips runShellCommand's own prompt timeout. That is
          // the expected shape for those machines, not a failure.
          tick(
            /timed out waiting for PTY prompt/.test(message)
              ? `${autoCommand} running (long-tail; no further status updates)`
              : `configured command failed: ${message}`,
          );
        },
      );
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

/**
 * The pane layout for an image that declares no `presentation` block, derived
 * from what it DOES declare: a readiness probe means a web machine, a
 * display feature means that display's pane.
 */
function genericPresentationForMachine(
  machine: ImageMachine,
  framebufferTest: boolean,
): DemoPresentation {
  if (machine.web !== null) return genericDemoPresentation("web");
  if (machine.runtime.features.includes("kms")) {
    return genericDemoPresentation("kms");
  }
  if (framebufferTest || machine.runtime.features.includes("framebuffer")) {
    return genericDemoPresentation("framebuffer");
  }
  return genericDemoPresentation("terminal");
}

/**
 * Attach a `BrowserInputSource` for an image that declares `evdev-input`.
 *
 * Everything about HOW is derived from the declared feature set, never from a
 * selector an image names: an image must not be able to reach into the app's
 * DOM.
 *
 * - `evdev-input` WITH a display feature: that pane owns the pointer (it
 *   feeds framebuffer-positioned absolute events through `sendPointerAbs`, so
 *   this source's window-relative coordinates would fight it). The wheel
 *   stays on — REL_WHEEL carries no coordinates. Capture is scoped to the
 *   display pane so the dock and sibling panes stay usable.
 * - `evdev-input` ALONE: a global input consumer. Pointer comes from the
 *   window and capture is scoped to the demo stage.
 *
 * The viewport is the browser window. `display` in demo.json is a FLOOR the
 * machine states, not a size it imposes, so the published canvas dimensions
 * (which set EVIOCGABS's ABS_X/Y maxima) are the window clamped up to that
 * minimum, republished on resize.
 */
function attachDeclaredInputSource(
  kernel: BrowserKernel,
  machine: ImageMachine,
  tick: (msg: string) => void,
): void {
  const displaySelector = machine.runtime.features.includes("kms")
    ? ".kmodeset-surface"
    : machine.runtime.features.includes("framebuffer")
    ? ".kframebuffer-surface"
    : null;
  const dims = () => ({
    width: Math.max(window.innerWidth, machine.display?.minWidth ?? 0),
    height: Math.max(window.innerHeight, machine.display?.minHeight ?? 0),
  });
  tick("attaching input source...");
  kernel.attachInputSource(
    // Bound to the window for global reach; `shouldCapture` is what keeps the
    // out-of-stage chrome (the "New" menu, dialogs) usable. See
    // demoSurfaceCaptureGate.
    new BrowserInputSource(window, {
      ...(displaySelector === null ? {} : { pointer: false }),
      wheel: true,
      onResize: () => {
        const { width, height } = dims();
        kernel.setInputCanvasDims(width, height);
      },
      shouldCapture: demoSurfaceCaptureGate(
        () => document.querySelector(displaySelector ?? "main"),
      ),
    }),
    dims(),
  );
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
      .then(failOn(imageLabel(profile)))
      .then((r) => r.arrayBuffer()),
  };
}

async function resolveProfileVfsUrl(profile: LiveProfile): Promise<string> {
  if (profile.vfsSource) return resolveVfsProductUrl(profile.vfsSource);
  if (profile.vfsUrl) return profile.vfsUrl;
  throw new Error("this boot descriptor names no VFS image to load");
}

/** What to call this image in a boot log or a failure. Never a machine id:
 *  the machine is not known until the image has been read. */
function imageLabel(profile: LiveProfile): string {
  if (profile.productId !== null) return `${profile.productId} image`;
  return profile.vfsUrl
    ? `${demoIdFromVfsImageUrl(profile.vfsUrl)}.vfs.zst`
    : "VFS image";
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
      env: FBTEST_ENV,
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
  web: DemoWebConfig | null,
  label: string,
  requiredServices: Set<string>,
  seenPorts: Set<number>,
  bridgeSent: boolean,
  appPrefix: string,
  readiness: WebReadinessState,
  dinitBootTracker: DinitBootStatusTracker,
  tick: (msg: string) => void,
  isCurrent: () => boolean,
): void {
  if (web === null) return;
  if (readiness.failed) return;
  const portsReady = web.requiredPorts.every((p) => seenPorts.has(p));
  const servicesReady = [...requiredServices].every((serviceName) =>
    dinitBootTracker.hasSucceeded(serviceName),
  );
  if (!portsReady || !servicesReady || !bridgeSent) return;
  const readyMessage = web.probeHttp
    ? "HTTP bridge ready"
    : "Service stack ready";
  if (readiness.ready) {
    if (!isCurrent()) return;
    host.setWebPreview({
      label,
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
      label,
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
    label,
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
          label,
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
          label,
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

function envRecord(env: string[]): Record<string, string> {
  return Object.fromEntries(
    env.map((kv) => {
      const idx = kv.indexOf("=");
      return [kv.slice(0, idx), kv.slice(idx + 1)];
    }),
  );
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * The machine's real descriptor, built from the image that is booting.
 *
 * Identity, features, caps, requested memory, and the init argv all come out
 * of `/etc/kandelo/demo.json`. The caller's descriptor contributes only the
 * mounts it named (which image to boot) — never what the machine is.
 */
function descriptorForMachine(
  profile: LiveProfile,
  machine: ImageMachine,
  title: string,
  requestedDescriptor: BootDescriptor,
): BootDescriptor {
  const identity = machine.identity;
  const init = machine.init === null ? null : initLaunchForMachine(machine.init);
  return {
    version: 1,
    id: machine.profileId || profile.descriptor.id,
    title,
    base: identity?.base ?? `kandelo:shell@abi${ABI_VERSION}`,
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: machine.runtime.requests.memoryPages
        ?? HOST_DEFAULT_DESCRIPTOR_MEMORY_PAGES,
      features: [
        "shared-array-buffer",
        "pty",
        ...machine.runtime.features,
        ...(machine.runtime.network ? ["tcp-bridge"] : []),
      ],
      time: "real",
    },
    packages: identity?.packages ?? [],
    mounts: requestedDescriptor.mounts,
    boot: init === null
      ? profile.descriptor.boot
      : {
        argv: init.argv,
        cwd: init.cwd,
        env: envRecord(init.env),
        uid: init.uid,
        gid: init.gid,
      },
    caps: { network: machine.runtime.network },
  };
}

/**
 * The gallery listing: one item per curated roster entry, in roster order.
 *
 * Membership comes from `gallery-roster.json`; every displayed byte comes
 * from the named product's own tracked `demo.json`. The app supplies neither.
 * An entry whose product cannot be resolved, is not served here, or has not
 * been built is still LISTED — `resolveEntryAvailability` names the specific
 * boundary, and `resolveVfsImageUrl` rejects with that same reason instead of
 * a generic "not built".
 */
function liveGalleryItems(): GalleryItem[] {
  return GALLERY_ROSTER.entries.flatMap((entry) => {
    const item = galleryItemForRosterEntry(entry);
    return item === null ? [] : [item];
  });
}

function galleryItemForRosterEntry(entry: RosterEntry): GalleryItem | null {
  const config = TRACKED_DEMO_CONFIG_BY_PRODUCT[entry.product];
  const identity = config === undefined
    ? null
    : resolveDemoIdentity(config, entry.profile);
  if (config === undefined || identity === null) {
    // No tracked machine metadata means nothing truthful to display. Log the
    // gap rather than inventing a title for a machine the repo does not
    // describe.
    console.warn(
      `gallery roster entry ${entry.product}/${entry.profile} has no tracked`
        + ` demo-config identity; it cannot be listed`,
    );
    return null;
  }
  const availability = galleryEntryAvailability(entry);
  const source = galleryProductSource(entry.product);
  const init = resolveDemoInit(config, entry.profile);
  const bootCommand = init === null
    ? DEFAULT_LOGIN_SESSION_ARGV
    : initLaunchForMachine(init).argv;
  const eagerUrl = source !== undefined && source.kind === "url"
    ? vfsImageUrlWithProfile(source.url, entry.profile)
    : undefined;
  const item: GalleryItem = {
    id: entry.profile,
    title: identity.title,
    summary: identity.summary,
    base: identity.base ?? `kandelo:shell@abi${ABI_VERSION}`,
    packages: identity.packages ?? [],
    bootCommand,
    ...(eagerUrl === undefined ? {} : { vfsImageUrl: eagerUrl }),
    accent: identity.accent,
    glyph: identity.glyph,
    estimatedUrlBytes: 0,
  };
  item.estimatedUrlBytes = JSON.stringify(item).length;
  if (eagerUrl === undefined) {
    item.resolveVfsImageUrl = async () => {
      if (availability.state !== "available" || source === undefined) {
        throw new Error(
          availability.reason
            ?? `product ${JSON.stringify(entry.product)} cannot be launched here`,
        );
      }
      return vfsImageUrlWithProfile(
        await resolveVfsProductUrl(source),
        entry.profile,
      );
    };
  }
  return item;
}

/** The interactive login session an image boots when it declares no `init`.
 *  Display-only: the actual session is the image's own terminal-session
 *  contract, which the kernel starts from `/etc/kandelo/terminal-session.json`. */
const DEFAULT_LOGIN_SESSION_ARGV = ["bash", "-l", "-i"];

/**
 * Whether a roster entry can be launched in THIS deployment, expressed with
 * the shared availability model so the reason names a specific boundary.
 */
function galleryEntryAvailability(entry: RosterEntry): EntryAvailability {
  const source = galleryProductSource(entry.product);
  if (source === undefined) {
    return resolveEntryAvailability(entry, {
      known: false,
      servedHere: false,
      built: false,
    });
  }
  if (CANONICAL_PAGES_VFS_PRODUCTS !== null) {
    const served = CANONICAL_PAGES_VFS_PRODUCTS.some(
      (product) => product.id === source.productId,
    );
    return resolveEntryAvailability(entry, {
      known: true,
      servedHere: served,
      built: served,
    });
  }
  return resolveEntryAvailability(entry, {
    known: true,
    servedHere: true,
    built: localProductArtifactExists(source),
    buildCommand: localProductBuildCommand(source),
  });
}

function localProductArtifactExists(source: VfsProductSource): boolean {
  if (source.kind === "url") return true;
  if (source.kind === "optional-demo") {
    return optionalDemoVfsIsBuilt(source.image);
  }
  return source.relPaths.some((relPath) => relPath in OPTIONAL_BINARY_URLS);
}

function localProductBuildCommand(source: VfsProductSource): string | undefined {
  if (source.kind === "url") return undefined;
  return source.kind === "optional-demo"
    ? "./run.sh fetch"
    : "./run.sh build programs";
}

/**
 * The image URL carries its profile in the FRAGMENT, so a single URL names a
 * machine. Fragments are a client-side view selector, never part of file
 * identity — `matchTrustedVfsSourceId` strips it, and it never reaches the
 * network or the Cache API key.
 */
function vfsImageUrlWithProfile(rawUrl: string, profileId: string): string {
  const url = new URL(rawUrl, location.href);
  url.hash = profileId;
  return url.href;
}

/** Resolve a product's image URL through whichever channel serves it here. */
async function resolveVfsProductUrl(source: VfsProductSource): Promise<string> {
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

async function resolveTrustedVfsProductUrl(
  source: VfsProductSource,
): Promise<string> {
  if (CANONICAL_PAGES_VFS_LOADER !== undefined) {
    return (await CANONICAL_PAGES_VFS_LOADER.activate(source.productId)).imageUrl;
  }
  return resolveVfsProductUrl(source);
}

/**
 * Match a `?vfs=` URL against the products whose URL this page already knows
 * without resolving anything. Fails closed: an ambiguous or absent match
 * returns `null`, which only defers to the authoritative asynchronous match.
 *
 * Fragments name a profile, not a file, so they are excluded from the
 * comparison exactly as `matchTrustedVfsSourceId` excludes them.
 */
function eagerProductIdForVfsUrl(vfsUrl: string): GalleryProductId | null {
  let requested: string;
  try {
    requested = withoutUrlHash(vfsUrl);
  } catch {
    return null;
  }
  const matches = (Object.keys(VFS_PRODUCTS) as GalleryProductId[]).filter(
    (productId) => {
      const source = VFS_PRODUCTS[productId];
      return source.kind === "url" && withoutUrlHash(source.url) === requested;
    },
  );
  return matches.length === 1 ? matches[0] : null;
}

function withoutUrlHash(rawUrl: string): string {
  const url = new URL(rawUrl, location.href);
  url.hash = "";
  return url.href;
}

/**
 * Which product, if any, a `?vfs=` URL is. Used only to pick host policy
 * (capacity, Pages activation) — never to decide what machine boots.
 */
async function matchTrustedVfsProductId(
  vfsUrl: string,
): Promise<GalleryProductId | null> {
  return matchTrustedVfsSourceId(
    vfsUrl,
    (Object.keys(VFS_PRODUCTS) as GalleryProductId[]).map((id) => ({
      id,
      resolveVfsImageUrl: () => resolveTrustedVfsProductUrl(VFS_PRODUCTS[id]),
    })),
  );
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

/** Does this image actually contain that path? The host's staging patches
 *  key off what the image CONTAINS, never off a machine id. */
function vfsPathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.stat(path);
    return true;
  } catch (err) {
    if (isMissingVfsPath(err)) return false;
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
