import type {
  DemoPresentation,
  PrimarySurface,
} from "./kernel-host";

export const KANDELO_DEMO_CONFIG_PATH = "/etc/kandelo/demo.json";
export const MAX_KANDELO_DEMO_CONFIG_BYTES = 256 * 1024;

export interface DemoPresentationConfig {
  bootPrimary: PrimarySurface;
  runningPrimary: PrimarySurface[];
  terminalAccess: DemoPresentation["terminalAccess"];
  internalsAccess: DemoPresentation["internalsAccess"];
  touchControls?: boolean;
}

/**
 * One file the host stages into the image's filesystem before boot.
 *
 * There is deliberately no "route this through the dev CORS proxy" flag. An
 * image knows where its asset lives; whether fetching it needs a same-origin
 * detour is a property of the HOST doing the fetching (which origin the page
 * is served from, and whether this is a dev server at all), so the host
 * decides it by comparing `url`'s origin with its own. That also means a
 * third-party image gets the dev proxy for its cross-origin assets without
 * knowing any Kandelo-specific flag exists.
 */
export interface DemoAssetConfig {
  path: string;
  url: string;
  sha256?: string;
  mode?: number;
}

/**
 * What a guide button does.
 *
 * `web.wordpressLogin` is ONE APPLICATION'S LOGIN FLOW in a generic schema:
 * the host hard-codes WordPress's form field names and submit button, so any
 * other image with a login form cannot express itself here. The replacement
 * is a generic `web.formFill` action whose payload carries the form URL, the
 * field values, and the submit selector — an application knows its own login
 * form, so that data is legitimately image-owned and needs no host-side
 * knowledge of WordPress. Until that lands, this kind stays: the login
 * feature is kept, not dropped. See "Future work: a generic web form action"
 * in docs/superpowers/specs/2026-09-22-image-owned-machine-definitions-design.md.
 */
export type DemoActionKind = "terminal.run" | "terminal.write" | "web.wordpressLogin";

export interface DemoActionConfig {
  id: string;
  label: string;
  description?: string;
  kind: DemoActionKind;
  payload: string;
}

export interface DemoActionGroupConfig {
  title: string;
  actions: DemoActionConfig[];
}

export interface DemoScriptConfig {
  title: string;
  language: string;
  initialText: string;
}

export interface DemoCompanionConfig {
  title: string;
  srcDoc: string;
}

/**
 * What to do once an ingested file has landed at `targetPath`.
 *
 * `restart` is an author-provided shell command from the VFS image, never
 * user input. The uploaded file's name never reaches it: the payload is
 * always written to the fixed `targetPath`.
 */
export interface DemoIngestOnLoadConfig {
  restart: string;
}

/**
 * Declarative "bring your own file" capability for a demo — e.g. a NES ROM or
 * a DOOM WAD. Content-neutral: the schema knows about extensions, a size cap,
 * and one fixed destination, not about what the bytes mean.
 */
export interface DemoIngestConfig {
  /** Lowercase extension allow-list, each including the dot (".nes"). */
  accept: string[];
  /** Fixed absolute destination. Never derived from the uploaded filename. */
  targetPath: string;
  /** Hard cap, enforced before any byte is written. */
  maxBytes: number;
  /** Human-facing control label, e.g. "Load ROM". */
  label?: string;
  onLoad?: DemoIngestOnLoadConfig;
}

/**
 * Declared runtime shape of a machine.
 *
 * There is deliberately no `network` flag. One was carried here as
 * "descriptive only", but nothing ever gated a socket syscall on it, and a
 * field that READS like a sandbox control is worse than an absent one once
 * third-party images declare it: the first reader to trust it would be
 * trusting a promise the platform never made. Whether the guest socket path
 * should be gated at all is a separate question, and gets a separate field
 * when it is answered.
 */
export interface DemoRuntimeConfig {
  features: DemoRuntimeFeature[];
  requests: DemoResourceRequests;
}

/**
 * The `runtime` block AS IT APPEARS ON DISK. Every field is optional there —
 * `nginx-demo.json` declares `requests` with no `features` — and
 * `parseKandeloDemoConfig` is a cast, so a required-field declaration would
 * let a consumer write `profile.runtime.features.includes(...)` and get a
 * TypeError with no type error to warn them.
 *
 * `resolveDemoRuntime` returns the fully-populated `DemoRuntimeConfig`;
 * reach for that rather than the raw block.
 */
export interface DemoRuntimeConfigInput {
  features?: DemoRuntimeFeature[];
  requests?: DemoResourceRequests;
}

/**
 * Each feature here changes what the host actually does: `framebuffer` and
 * `kms` select a display surface, `evdev-input` makes the host attach a DOM
 * input source before the machine's command runs. A feature with no consumer
 * is a claim the platform does not honour, so it does not belong in this
 * union.
 */
export type DemoRuntimeFeature =
  | "framebuffer"
  | "kms"
  | "evdev-input";

/**
 * What the image ASKS for. The host clamps each of these to its own policy
 * before use; these ceilings only reject values no legitimate image would
 * declare, so a hostile `?vfs=` image cannot request unbounded allocation.
 */
export interface DemoResourceRequests {
  memoryPages?: number;
  maxWorkers?: number;
}

/** 16384 pages = 1 GiB, matching the largest legitimate machine today
 *  (wordpress-mariadb). */
export const MAX_REQUESTED_MEMORY_PAGES = 16384;
/** Comfortably above wordpress-mariadb's 24 without permitting worker floods. */
export const MAX_REQUESTED_WORKERS = 64;

/**
 * WHAT THIS MACHINE RUNS. A profile with no `init` block boots the image's
 * default login session.
 *
 * Three mutually exclusive shapes, and the exclusivity is STRUCTURAL: a
 * machine has exactly one answer to "what runs here", so all three forms
 * live in one union rather than one of them sitting in `presentation` and
 * being kept apart by a validation rule.
 *
 * - `{ target }` — a NAME, not a command vector: dinit is already running
 *   the image's real init configuration (service files under
 *   /etc/dinit.d), and this only selects which dinit target to bring up.
 *   This is the shape every dinit-based service demo (nginx, nginx-php, the
 *   wordpress-* family) uses — they all happen to share one launcher
 *   (`dinit --container <target>`).
 * - `{ program, args, cwd?, uid, gid }` — exec a program from the image
 *   directly as pid 1, no service manager involved. Booting a program
 *   directly as init is a legitimate POSIX shape; not every machine needs or
 *   wants a service manager (see images/vfs/products/browser-ruby-todo.toml,
 *   which deliberately excludes dinit to stay lean for one long-running
 *   process). `program` must be an absolute, normalized path — validated the
 *   same way as `ingest.targetPath` — but this does NOT weaken the "boot
 *   identity is never URL-carried" trust rule: the path names a program that
 *   must already exist inside the image, which is exactly as image-owned as
 *   a dinit target name. What that rule forbids is a *command vector*
 *   supplied by the boot descriptor/URL, not a reference to image content.
 *
 *   `uid` and `gid` are REQUIRED, with no default. A default of 0 would hand
 *   root to any third-party image that picks this shape; a default of 1000
 *   would invent an account convention the image may not share. Requiring
 *   them puts the privilege pid 1 runs with in the reviewed file, where a
 *   reader can see it.
 * - `{ shellCommand }` — a command line for the machine's interactive shell,
 *   run after the image's default login session comes up. This is the shape
 *   for a machine that IS one program over an ordinary shell (fbDOOM, the
 *   KMS fluid sim, espeak): exiting the program returns to that shell. It is
 *   not pid 1, which is exactly why it is a separate arm rather than a
 *   variant of `{ program }`.
 */
export type DemoInitConfig =
  | { target: string }
  | { program: string; args: string[]; cwd?: string; uid: number; gid: number }
  | { shellCommand: string };

/**
 * Readiness signalling for the host's web pane. This is presentation, not
 * init configuration: it tells the UI when to flip from "starting" to
 * "ready". Ports are declared rather than derived because deriving them
 * would mean parsing nginx.conf.
 */
export interface DemoWebConfig {
  requiredPorts: number[];
  probeHttp: boolean;
  probePath?: string;
}

/**
 * The `web` block AS IT APPEARS ON DISK: `probeHttp` defaults to true when
 * omitted, and most tracked files omit it. See `DemoRuntimeConfigInput` for
 * why the raw and normalized shapes are separate types.
 */
export interface DemoWebConfigInput {
  requiredPorts: number[];
  probeHttp?: boolean;
  probePath?: string;
}

/**
 * What the gallery and machine chrome show for this profile.
 *
 * There is deliberately no `base` field. The base image reference an image
 * would have declared (`kandelo:shell@abi<N>`) is not verified against
 * anything — real ABI compatibility is enforced by the `__abi_version` check
 * on the binaries themselves — so a declared string could only ever agree
 * with, or lie about, what the app already computes from `ABI_VERSION`. Let
 * the app compute it, rather than making every image restate a constant that
 * rots on each ABI bump.
 */
export interface DemoIdentityConfig {
  title: string;
  summary: string;
  accent: string;
  glyph: string;
  packages?: string[];
}

/**
 * A FLOOR the machine states, not a size it imposes. The viewport is the
 * browser window; these only tell the host the smallest surface the machine
 * expects to be usable at.
 */
export interface DemoDisplayConfig {
  minWidth: number;
  minHeight: number;
}

export interface DemoGuideConfig {
  title: string;
  summary?: string;
  groups?: DemoActionGroupConfig[];
  script?: DemoScriptConfig;
  companion?: DemoCompanionConfig;
}

/**
 * A profile AS IT APPEARS ON DISK. `parseKandeloDemoConfig` only checks
 * `version`, so these declarations must describe what an author may actually
 * write, not what a resolver returns after normalization.
 */
export interface KandeloDemoProfileConfig {
  presentation?: DemoPresentationConfig;
  assets?: DemoAssetConfig[];
  guide?: DemoGuideConfig;
  ingest?: DemoIngestConfig;
  runtime?: DemoRuntimeConfigInput;
  init?: DemoInitConfig;
  web?: DemoWebConfigInput;
  identity?: DemoIdentityConfig;
  display?: DemoDisplayConfig;
}

/**
 * The file AS IT APPEARS ON DISK. Machine fields live in a profile and
 * NOWHERE ELSE: there is no top-level copy of `presentation`, `runtime`,
 * `init` and the rest that a profile falls back to.
 *
 * Every field used to be declarable at both levels, with each `resolveDemoX`
 * falling back from the profile to the top level. No tracked image ever used
 * it, it doubled the lookup surface a reviewer has to check, and independent
 * per-block fallback is what let one profile resolve two different answers
 * for the same question. One shape means one place to look.
 */
export interface KandeloDemoConfig {
  version: 1;
  defaultProfile?: string;
  profiles?: Record<string, KandeloDemoProfileConfig>;
}

export type GenericDemoPresentationKind = "terminal" | "web" | "framebuffer" | "kms";

export function genericDemoPresentation(
  kind: GenericDemoPresentationKind = "terminal",
): DemoPresentation {
  switch (kind) {
    case "web":
      return {
        bootPrimary: "syslog",
        runningPrimary: ["web", "terminal", "syslog"],
        terminalAccess: "drawer",
        internalsAccess: "drawer",
      };
    case "framebuffer":
      return {
        bootPrimary: "syslog",
        runningPrimary: ["framebuffer", "terminal", "syslog"],
        terminalAccess: "drawer",
        internalsAccess: "drawer",
      };
    case "kms":
      return {
        bootPrimary: "syslog",
        runningPrimary: ["kms", "terminal", "syslog"],
        terminalAccess: "drawer",
        internalsAccess: "drawer",
      };
    case "terminal":
    default:
      return {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer",
      };
  }
}

const PRIMARY_SURFACES = new Set<PrimarySurface>([
  "syslog",
  "terminal",
  "framebuffer",
  "web",
  "kms",
]);
const ACCESS_MODES = new Set(["primary", "drawer", "side"]);
const ACTION_KINDS = new Set<DemoActionKind>([
  "terminal.run",
  "terminal.write",
  "web.wordpressLogin",
]);

export function parseKandeloDemoConfig(text: string): KandeloDemoConfig | null {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1) return null;
  return value as unknown as KandeloDemoConfig;
}

/**
 * Machine fields that belong to a profile. Declared at the top level they
 * are REJECTED rather than ignored: a silently dropped `init` block would
 * boot a different machine than the file describes.
 */
const PROFILE_ONLY_KEYS = [
  "presentation",
  "assets",
  "guide",
  "ingest",
  "runtime",
  "init",
  "web",
  "identity",
  "display",
] as const;

/**
 * Validate every image-owned demo profile eagerly. Runtime resolution stays
 * profile-specific, but an image builder must not publish malformed metadata
 * for a profile that its smoke test happened not to select.
 */
export function validateKandeloDemoConfig(config: KandeloDemoConfig): void {
  if (!isRecord(config) || config.version !== 1) {
    throw new Error("demo config must use version 1");
  }
  const misplaced = PROFILE_ONLY_KEYS.filter(
    (key) => (config as Record<string, unknown>)[key] !== undefined,
  );
  if (misplaced.length > 0) {
    throw new Error(
      `demo config declares ${misplaced.join(", ")} at the top level;`
        + " every machine field belongs to a profile (profiles.<id>)",
    );
  }
  if (config.profiles !== undefined) {
    if (!isRecord(config.profiles)) {
      throw new Error("profiles must be an object");
    }
    for (const [profileId, profile] of Object.entries(config.profiles)) {
      if (!isRecord(profile)) {
        throw new Error(`profiles.${profileId} must be an object`);
      }
      validateProfileFields(profile, `profiles.${profileId}`);
    }
  }
  if (config.defaultProfile !== undefined) {
    const declared = requiredString(config.defaultProfile, "defaultProfile");
    if (!Object.hasOwn(config.profiles ?? {}, declared)) {
      throw new Error(`defaultProfile "${declared}" is not a declared profile`);
    }
  }
}

export function resolveDemoPresentation(
  config: KandeloDemoConfig,
  profileId: string,
): DemoPresentation | null {
  const profile = profileConfig(config, profileId);
  return profile?.presentation === undefined
    ? null
    : normalizePresentationConfig(profile.presentation);
}

export function resolveDemoAssets(
  config: KandeloDemoConfig,
  profileId: string,
): DemoAssetConfig[] {
  const profile = profileConfig(config, profileId);
  return normalizeAssets(profile?.assets, `profiles.${profileId}.assets`);
}

export function resolveDemoGuide(
  config: KandeloDemoConfig,
  profileId: string,
): DemoGuideConfig | null {
  const profile = profileConfig(config, profileId);
  return profile?.guide === undefined
    ? null
    : normalizeGuide(profile.guide, `profiles.${profileId}.guide`);
}

export function resolveDemoIngest(
  config: KandeloDemoConfig,
  profileId: string,
): DemoIngestConfig | null {
  const profile = profileConfig(config, profileId);
  return profile?.ingest === undefined
    ? null
    : normalizeIngest(profile.ingest, `profiles.${profileId}.ingest`);
}

/** Upper bound on any image-declared cap, so a bad image can't ask the browser
 *  to buffer an unbounded upload into the VFS. */
const INGEST_MAX_BYTES_CEILING = 64 * 1024 * 1024;

const RUNTIME_FEATURES = new Set<DemoRuntimeFeature>([
  "framebuffer",
  "kms",
  "evdev-input",
]);

function normalizeRuntime(value: unknown, field: string): DemoRuntimeConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }

  const features: DemoRuntimeFeature[] = [];
  if (value.features !== undefined) {
    if (!Array.isArray(value.features)) {
      throw new Error(`${field}.features must be an array`);
    }
    value.features.forEach((entry, index) => {
      if (
        typeof entry !== "string"
        || !RUNTIME_FEATURES.has(entry as DemoRuntimeFeature)
      ) {
        throw new Error(
          `${field}.features[${index}] must be one of: `
            + `${Array.from(RUNTIME_FEATURES).join(", ")}`,
        );
      }
      if (features.includes(entry as DemoRuntimeFeature)) {
        throw new Error(`${field}.features must not contain duplicate features`);
      }
      features.push(entry as DemoRuntimeFeature);
    });
  }

  return {
    features,
    requests: normalizeResourceRequests(value.requests, `${field}.requests`),
  };
}

function normalizeResourceRequests(
  value: unknown,
  field: string,
): DemoResourceRequests {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const requests: DemoResourceRequests = {};
  if (value.memoryPages !== undefined) {
    requests.memoryPages = boundedCount(
      value.memoryPages,
      `${field}.memoryPages`,
      MAX_REQUESTED_MEMORY_PAGES,
      "page",
    );
  }
  if (value.maxWorkers !== undefined) {
    requests.maxWorkers = boundedCount(
      value.maxWorkers,
      `${field}.maxWorkers`,
      MAX_REQUESTED_WORKERS,
      "worker",
    );
  }
  return requests;
}

function boundedCount(
  value: unknown,
  field: string,
  ceiling: number,
  unit: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  if (value > ceiling) {
    throw new Error(`${field} exceeds the ${ceiling}-${unit} ceiling`);
  }
  return value;
}

/** dinit service names, matching /etc/dinit.d/<name> filenames. */
const INIT_TARGET_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/**
 * An absolute, normalized, NUL-free guest path — no `.`/`..` segments, no
 * trailing slash tricks. Shared by `init.program`/`init.cwd` and
 * `ingest.targetPath`: both name a fixed location inside the image, and a
 * traversal in either would escape the author's intended target even though
 * no user input reaches either field.
 */
function validateAbsoluteNormalizedPath(path: string, field: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`${field} must be absolute`);
  }
  const pathSegments = path.split("/").slice(1);
  if (
    pathSegments.length === 0
    || pathSegments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
    || path.includes("\0")
  ) {
    throw new Error(`${field} must be a normalized file path`);
  }
}

/** The three keys that each select one arm of `DemoInitConfig`. */
const INIT_SHAPE_KEYS = ["target", "program", "shellCommand"] as const;

/** Long enough for any real launch line, short enough that a hostile `?vfs=`
 *  image cannot bury a megabyte in the command the shell is handed. */
const MAX_SHELL_COMMAND_CHARS = 4096;

function normalizeInit(value: unknown, field: string): DemoInitConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const declared = INIT_SHAPE_KEYS.filter((key) => value[key] !== undefined);
  if (declared.length > 1) {
    throw new Error(
      `${field} cannot declare ${declared.join(" and ")}`
        + " — only one thing can be what the machine runs",
    );
  }
  if (value.shellCommand !== undefined) {
    return {
      shellCommand: cappedString(
        value.shellCommand,
        `${field}.shellCommand`,
        MAX_SHELL_COMMAND_CHARS,
      ),
    };
  }
  if (value.program !== undefined) {
    const program = requiredString(value.program, `${field}.program`);
    validateAbsoluteNormalizedPath(program, `${field}.program`);

    let args: string[] = [];
    if (value.args !== undefined) {
      if (!Array.isArray(value.args)) {
        throw new Error(`${field}.args must be an array`);
      }
      args = value.args.map((arg, index) =>
        requiredString(arg, `${field}.args[${index}]`)
      );
    }

    const init: DemoInitConfig = {
      program,
      args,
      // Required, not defaulted: see DemoInitConfig. The image states the
      // privilege its pid 1 runs with, or it does not get to use this shape.
      uid: accountId(value.uid, `${field}.uid`),
      gid: accountId(value.gid, `${field}.gid`),
    };
    if (value.cwd !== undefined) {
      const cwd = requiredString(value.cwd, `${field}.cwd`);
      validateAbsoluteNormalizedPath(cwd, `${field}.cwd`);
      init.cwd = cwd;
    }
    return init;
  }

  const target = requiredString(value.target, `${field}.target`);
  if (!INIT_TARGET_RE.test(target)) {
    throw new Error(
      `${field}.target must be a bare service name matching /etc/dinit.d/<name>`,
    );
  }
  return { target };
}

/** A POSIX uid/gid: a non-negative integer. 0 is root and is allowed — it is
 *  what every dinit-based machine already runs as; what is not allowed is
 *  leaving it unsaid. */
function accountId(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

/** Matches MAX_IDENTITY_PACKAGES: an image declaring more than this is
 *  malformed, not ambitious. */
const MAX_REQUIRED_PORTS = 64;
/** Long enough for any real readiness endpoint, short enough that a hostile
 *  `?vfs=` image cannot bury a megabyte in a probe URL. */
const MAX_PROBE_PATH_CHARS = 512;

function normalizeWeb(value: unknown, field: string): DemoWebConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  if (!Array.isArray(value.requiredPorts) || value.requiredPorts.length === 0) {
    throw new Error(`${field}.requiredPorts must be a non-empty array`);
  }
  if (value.requiredPorts.length > MAX_REQUIRED_PORTS) {
    throw new Error(
      `${field}.requiredPorts must list at most ${MAX_REQUIRED_PORTS} ports`,
    );
  }
  const requiredPorts = value.requiredPorts.map((port, index) => {
    if (
      typeof port !== "number"
      || !Number.isInteger(port)
      || port < 1
      || port > 65535
    ) {
      throw new Error(`${field}.requiredPorts[${index}] must be a TCP port`);
    }
    return port;
  });
  if (new Set(requiredPorts).size !== requiredPorts.length) {
    throw new Error(`${field}.requiredPorts must not contain duplicate ports`);
  }

  let probeHttp = true;
  if (value.probeHttp !== undefined) {
    if (typeof value.probeHttp !== "boolean") {
      throw new Error(`${field}.probeHttp must be a boolean`);
    }
    probeHttp = value.probeHttp;
  }

  const web: DemoWebConfig = { requiredPorts, probeHttp };
  if (value.probePath !== undefined) {
    web.probePath = probePath(value.probePath, `${field}.probePath`);
  }
  return web;
}

/**
 * A readiness path, not a URL. `previewUrlForPath` resolves this against the
 * page origin, so a leading `/` alone is not enough: `//evil.example` is a
 * protocol-relative URL that resolves to a DIFFERENT ORIGIN, which would let
 * a hostile `?vfs=` image aim the host's readiness probe off-site. Query and
 * fragment are rejected because this names a path; backslash and NUL because
 * URL parsers and the VFS disagree about what they mean.
 */
function probePath(value: unknown, field: string): string {
  const path = requiredString(value, field);
  if (path.length > MAX_PROBE_PATH_CHARS) {
    throw new Error(
      `${field} must be at most ${MAX_PROBE_PATH_CHARS} characters`,
    );
  }
  if (!path.startsWith("/")) {
    throw new Error(`${field} must be absolute`);
  }
  if (path.startsWith("//")) {
    throw new Error(
      `${field} must not start with "//" — that is a protocol-relative URL, `
        + "not a path on this machine",
    );
  }
  for (const forbidden of ["\0", "?", "#", "\\"]) {
    if (path.includes(forbidden)) {
      throw new Error(
        `${field} must be a plain path: no ${JSON.stringify(forbidden)}`,
      );
    }
  }
  return path;
}

export function resolveDemoWeb(
  config: KandeloDemoConfig,
  profileId: string,
): DemoWebConfig | null {
  const profile = profileConfig(config, profileId);
  return profile?.web === undefined
    ? null
    : normalizeWeb(profile.web, `profiles.${profileId}.web`);
}

const ACCENT_RE = /^#[0-9a-f]{6}$/i;
/** 8K, well past any real browser viewport, so a bad value fails loudly. */
const MAX_DISPLAY_PIXELS = 7680;
const MAX_IDENTITY_TITLE_CHARS = 64;
const MAX_IDENTITY_SUMMARY_CHARS = 512;
const MAX_IDENTITY_PACKAGES = 64;
/** A package entry is a `name@version` spec: a short identifier, capped the
 *  way `title` and `summary` are rather than left unbounded in a block the
 *  gallery renders as a list. */
const MAX_IDENTITY_PACKAGE_CHARS = 128;

function normalizeIdentity(value: unknown, field: string): DemoIdentityConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const title = requiredString(value.title, `${field}.title`);
  if (title.length > MAX_IDENTITY_TITLE_CHARS) {
    throw new Error(
      `${field}.title must be at most ${MAX_IDENTITY_TITLE_CHARS} characters`,
    );
  }
  const summary = requiredString(value.summary, `${field}.summary`);
  if (summary.length > MAX_IDENTITY_SUMMARY_CHARS) {
    throw new Error(
      `${field}.summary must be at most ${MAX_IDENTITY_SUMMARY_CHARS} characters`,
    );
  }
  const accent = requiredString(value.accent, `${field}.accent`);
  if (!ACCENT_RE.test(accent)) {
    throw new Error(`${field}.accent must be a #rrggbb colour`);
  }
  const glyph = requiredString(value.glyph, `${field}.glyph`);
  if (glyph.length > 4) {
    throw new Error(`${field}.glyph must be 1 to 4 characters`);
  }

  const identity: DemoIdentityConfig = { title, summary, accent, glyph };
  if (value.packages !== undefined) {
    if (!Array.isArray(value.packages)) {
      throw new Error(`${field}.packages must be an array`);
    }
    if (value.packages.length > MAX_IDENTITY_PACKAGES) {
      throw new Error(
        `${field}.packages must list at most ${MAX_IDENTITY_PACKAGES} entries`,
      );
    }
    identity.packages = value.packages.map((entry, index) =>
      cappedString(
        entry,
        `${field}.packages[${index}]`,
        MAX_IDENTITY_PACKAGE_CHARS,
      ));
  }
  return identity;
}

function cappedString(value: unknown, field: string, max: number): string {
  const text = requiredString(value, field);
  if (text.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return text;
}

function normalizeDisplay(value: unknown, field: string): DemoDisplayConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return {
    minWidth: boundedCount(
      value.minWidth,
      `${field}.minWidth`,
      MAX_DISPLAY_PIXELS,
      "pixel",
    ),
    minHeight: boundedCount(
      value.minHeight,
      `${field}.minHeight`,
      MAX_DISPLAY_PIXELS,
      "pixel",
    ),
  };
}

export function resolveDemoIdentity(
  config: KandeloDemoConfig,
  profileId: string,
): DemoIdentityConfig | null {
  const profile = profileConfig(config, profileId);
  return profile?.identity === undefined
    ? null
    : normalizeIdentity(profile.identity, `profiles.${profileId}.identity`);
}

/**
 * The profile a bare `?vfs=` URL boots. An image with exactly one profile
 * needs no declaration; an image with several must say which, or the caller
 * has to choose explicitly rather than the app guessing.
 */
export function resolveDefaultProfileId(
  config: KandeloDemoConfig,
): string | null {
  if (typeof config.defaultProfile === "string") return config.defaultProfile;
  const ids = isRecord(config.profiles) ? Object.keys(config.profiles) : [];
  return ids.length === 1 ? ids[0] : null;
}

export function resolveDemoRuntime(
  config: KandeloDemoConfig,
  profileId: string,
): DemoRuntimeConfig {
  const profile = profileConfig(config, profileId);
  // A fresh object each call: `features` and `requests` are mutable and a
  // shared constant would let one caller's edit leak into every machine.
  return profile?.runtime === undefined
    ? { features: [], requests: {} }
    : normalizeRuntime(profile.runtime, `profiles.${profileId}.runtime`);
}

export function resolveDemoInit(
  config: KandeloDemoConfig,
  profileId: string,
): DemoInitConfig | null {
  const profile = profileConfig(config, profileId);
  return profile?.init === undefined
    ? null
    : normalizeInit(profile.init, `profiles.${profileId}.init`);
}

export function resolveDemoDisplay(
  config: KandeloDemoConfig,
  profileId: string,
): DemoDisplayConfig | null {
  const profile = profileConfig(config, profileId);
  return profile?.display === undefined
    ? null
    : normalizeDisplay(profile.display, `profiles.${profileId}.display`);
}

function normalizeIngest(value: unknown, field: string): DemoIngestConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }

  if (!Array.isArray(value.accept) || value.accept.length === 0) {
    throw new Error(`${field}.accept must be a non-empty array`);
  }
  const accept = value.accept.map((ext, index) => {
    const raw = requiredString(ext, `${field}.accept[${index}]`);
    if (
      !raw.startsWith(".")
      || raw.length < 2
      || raw.length > 32
      || raw.includes("/")
      || /\s/.test(raw)
    ) {
      throw new Error(`${field}.accept[${index}] must be an extension like ".nes"`);
    }
    return raw.toLowerCase();
  });
  if (new Set(accept).size !== accept.length) {
    throw new Error(`${field}.accept must not contain duplicate extensions`);
  }

  const targetPath = requiredString(value.targetPath, `${field}.targetPath`);
  // The write goes to this exact path, so a traversal here would escape the
  // author's intended destination even though no user input reaches it.
  validateAbsoluteNormalizedPath(targetPath, `${field}.targetPath`);

  const maxBytes = value.maxBytes;
  if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`${field}.maxBytes must be a positive integer`);
  }
  if (maxBytes > INGEST_MAX_BYTES_CEILING) {
    throw new Error(
      `${field}.maxBytes exceeds the ${INGEST_MAX_BYTES_CEILING}-byte ceiling`,
    );
  }

  const ingest: DemoIngestConfig = { accept, targetPath, maxBytes };
  if (typeof value.label === "string" && value.label.length > 0) {
    ingest.label = value.label;
  }
  if (value.onLoad !== undefined) {
    if (!isRecord(value.onLoad)) {
      throw new Error(`${field}.onLoad must be an object`);
    }
    ingest.onLoad = {
      restart: requiredString(value.onLoad.restart, `${field}.onLoad.restart`),
    };
  }
  return ingest;
}

/**
 * The one place a machine field is looked up. Anything that is not a record
 * — a missing profile id, or a profile declared as an array or a string —
 * resolves to "this profile declares nothing", the same answer the
 * resolvers give for an unknown id. `validateKandeloDemoConfig` rejects the
 * malformed shapes outright; this keeps a resolver from throwing a
 * TypeError if it is reached first.
 */
function profileConfig(
  config: KandeloDemoConfig,
  profileId: string,
): KandeloDemoProfileConfig | undefined {
  if (!isRecord(config.profiles)) return undefined;
  const profile = config.profiles[profileId];
  return isRecord(profile) ? (profile as KandeloDemoProfileConfig) : undefined;
}

function validateProfileFields(
  value: Record<string, unknown>,
  field: string,
): void {
  if (value.presentation !== undefined) {
    normalizePresentationConfig(value.presentation);
  }
  if (value.runtime !== undefined) {
    normalizeRuntime(value.runtime, `${field}.runtime`);
  }
  if (value.init !== undefined) {
    // No cross-block check here any more: `init` is the ONLY block that says
    // what a machine runs, and its three shapes exclude each other inside
    // normalizeInit.
    normalizeInit(value.init, `${field}.init`);
  }
  if (value.web !== undefined) {
    normalizeWeb(value.web, `${field}.web`);
  }
  if (value.identity !== undefined) {
    normalizeIdentity(value.identity, `${field}.identity`);
  }
  if (value.display !== undefined) {
    normalizeDisplay(value.display, `${field}.display`);
  }
  normalizeAssets(value.assets, `${field}.assets`);
  if (value.guide !== undefined) {
    normalizeGuide(value.guide, `${field}.guide`);
  }
  if (value.ingest !== undefined) {
    normalizeIngest(value.ingest, `${field}.ingest`);
  }
}

function normalizePresentationConfig(config: unknown): DemoPresentation {
  if (!isRecord(config)) {
    throw new Error("missing presentation");
  }

  const bootPrimary = parseSurface(config.bootPrimary, "bootPrimary");
  if (!Array.isArray(config.runningPrimary)) {
    throw new Error("presentation.runningPrimary must be an array");
  }
  const runningPrimary = uniqueSurfaces(config.runningPrimary);
  if (runningPrimary.length === 0) {
    throw new Error("presentation.runningPrimary must contain at least one valid surface");
  }

  return {
    bootPrimary,
    runningPrimary,
    terminalAccess: accessMode(config.terminalAccess, "terminalAccess"),
    internalsAccess: accessMode(config.internalsAccess, "internalsAccess"),
    ...(typeof config.touchControls === "boolean" ? { touchControls: config.touchControls } : {}),
  };
}

function normalizeAssets(value: unknown, field: string): DemoAssetConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((asset, index) => normalizeAsset(asset, `${field}[${index}]`));
}

function normalizeAsset(value: unknown, field: string): DemoAssetConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const path = requiredString(value.path, `${field}.path`);
  if (!path.startsWith("/")) {
    throw new Error(`${field}.path must be absolute`);
  }
  const url = requiredString(value.url, `${field}.url`);
  return {
    path,
    url,
    ...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
    ...(typeof value.mode === "number" ? { mode: value.mode } : {}),
  };
}

function normalizeGuide(value: unknown, field: string): DemoGuideConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const guide: DemoGuideConfig = {
    title: requiredString(value.title, `${field}.title`),
  };
  if (typeof value.summary === "string") {
    guide.summary = value.summary;
  }
  if (value.groups !== undefined) {
    guide.groups = normalizeActionGroups(value.groups, `${field}.groups`);
  }
  if (value.script !== undefined) {
    guide.script = normalizeScript(value.script, `${field}.script`);
  }
  if (value.companion !== undefined) {
    guide.companion = normalizeCompanion(value.companion, `${field}.companion`);
  }
  ensureUniqueActionIds(guide, field);
  return guide;
}

function normalizeActionGroups(value: unknown, field: string): DemoActionGroupConfig[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((group, index) => normalizeActionGroup(group, `${field}[${index}]`));
}

function normalizeActionGroup(value: unknown, field: string): DemoActionGroupConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  if (!Array.isArray(value.actions)) {
    throw new Error(`${field}.actions must be an array`);
  }
  return {
    title: requiredString(value.title, `${field}.title`),
    actions: value.actions.map((action, index) => normalizeAction(action, `${field}.actions[${index}]`)),
  };
}

function normalizeAction(value: unknown, field: string): DemoActionConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const kind = actionKind(value.kind, `${field}.kind`);
  return {
    id: requiredString(value.id, `${field}.id`),
    label: requiredString(value.label, `${field}.label`),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    kind,
    payload: requiredString(value.payload, `${field}.payload`),
  };
}

function normalizeScript(value: unknown, field: string): DemoScriptConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return {
    title: requiredString(value.title, `${field}.title`),
    language: requiredString(value.language, `${field}.language`),
    initialText: stringField(value.initialText, `${field}.initialText`),
  };
}

function normalizeCompanion(value: unknown, field: string): DemoCompanionConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return {
    title: requiredString(value.title, `${field}.title`),
    srcDoc: requiredString(value.srcDoc, `${field}.srcDoc`),
  };
}

function ensureUniqueActionIds(guide: DemoGuideConfig, field: string): void {
  const seen = new Set<string>();
  for (const group of guide.groups ?? []) {
    for (const action of group.actions) {
      if (seen.has(action.id)) {
        throw new Error(`${field} has duplicate action id: ${action.id}`);
      }
      seen.add(action.id);
    }
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${field} must be a non-empty string`);
}

function stringField(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`${field} must be a string`);
}

function parseSurface(value: unknown, field: string): PrimarySurface {
  if (typeof value === "string" && PRIMARY_SURFACES.has(value as PrimarySurface)) {
    return value as PrimarySurface;
  }
  throw new Error(`presentation.${field} must be one of: ${Array.from(PRIMARY_SURFACES).join(", ")}`);
}

function uniqueSurfaces(values: unknown[]): PrimarySurface[] {
  const out: PrimarySurface[] = [];
  for (let i = 0; i < values.length; i++) {
    const surface = parseSurface(values[i], `runningPrimary[${i}]`);
    if (!out.includes(surface)) {
      out.push(surface);
    }
  }
  return out;
}

function accessMode(
  value: unknown,
  field: "terminalAccess" | "internalsAccess",
): DemoPresentation["terminalAccess"] {
  if (typeof value === "string" && ACCESS_MODES.has(value)) {
    return value as DemoPresentation["terminalAccess"];
  }
  throw new Error(`presentation.${field} must be one of: ${Array.from(ACCESS_MODES).join(", ")}`);
}

function actionKind(value: unknown, field: string): DemoActionKind {
  if (typeof value === "string" && ACTION_KINDS.has(value as DemoActionKind)) {
    return value as DemoActionKind;
  }
  throw new Error(`${field} must be one of: ${Array.from(ACTION_KINDS).join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
