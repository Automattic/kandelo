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
  autoCommand?: string;
  touchControls?: boolean;
}

export interface DemoAssetConfig {
  path: string;
  url: string;
  sha256?: string;
  mode?: number;
  devCorsProxy?: boolean;
}

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
 * `network` is DESCRIPTIVE ONLY. Nothing gates a socket syscall on it today:
 * across the repo `tcp-bridge` appears at its producer, a capability-badge
 * display list, and a type comment, and `caps.network` has no readers. It is
 * carried so the Config surface can show what a machine claims, and must not
 * be presented to users as a sandbox control until it actually gates the
 * guest socket path. See the spec's "Known-inert capability flag".
 */
export interface DemoRuntimeConfig {
  features: DemoRuntimeFeature[];
  network: boolean;
  requests: DemoResourceRequests;
}

export type DemoRuntimeFeature =
  | "framebuffer"
  | "kms"
  | "evdev-input"
  | "js-workers";

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
 * Which init target to bring up. A NAME, not a command vector: the machine's
 * real init configuration already lives in the image (dinit service files
 * under /etc/dinit.d, the login session), and this only selects among them.
 * A profile with no `init` block boots the image's default login session.
 */
export interface DemoInitConfig {
  target: string;
}

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

/** What the gallery and machine chrome show for this profile. */
export interface DemoIdentityConfig {
  title: string;
  summary: string;
  accent: string;
  glyph: string;
  base?: string;
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

export interface KandeloDemoProfileConfig {
  presentation?: DemoPresentationConfig;
  assets?: DemoAssetConfig[];
  guide?: DemoGuideConfig;
  ingest?: DemoIngestConfig;
  runtime?: DemoRuntimeConfig;
  init?: DemoInitConfig;
  web?: DemoWebConfig;
  identity?: DemoIdentityConfig;
  display?: DemoDisplayConfig;
}

export interface KandeloDemoConfig {
  version: 1;
  presentation?: DemoPresentationConfig;
  assets?: DemoAssetConfig[];
  guide?: DemoGuideConfig;
  ingest?: DemoIngestConfig;
  runtime?: DemoRuntimeConfig;
  init?: DemoInitConfig;
  web?: DemoWebConfig;
  identity?: DemoIdentityConfig;
  display?: DemoDisplayConfig;
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
 * Validate every image-owned demo profile eagerly. Runtime resolution stays
 * profile-specific, but an image builder must not publish malformed metadata
 * for a profile that its smoke test happened not to select.
 */
export function validateKandeloDemoConfig(config: KandeloDemoConfig): void {
  if (!isRecord(config) || config.version !== 1) {
    throw new Error("demo config must use version 1");
  }
  validateProfileFields(config, "demo config");
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
  if (isRecord(profile) && profile.presentation !== undefined) {
    return normalizePresentationConfig(profile.presentation);
  }
  return config.presentation === undefined
    ? null
    : normalizePresentationConfig(config.presentation);
}

export function resolveDemoAssets(
  config: KandeloDemoConfig,
  profileId: string,
): DemoAssetConfig[] {
  const profile = profileConfig(config, profileId);
  return [
    ...normalizeAssets(config.assets, "assets"),
    ...normalizeAssets(
      isRecord(profile) ? profile.assets : undefined,
      `profiles.${profileId}.assets`,
    ),
  ];
}

export function resolveDemoGuide(
  config: KandeloDemoConfig,
  profileId: string,
): DemoGuideConfig | null {
  const profile = profileConfig(config, profileId);
  if (isRecord(profile) && profile.guide !== undefined) {
    return normalizeGuide(profile.guide, `profiles.${profileId}.guide`);
  }
  return config.guide === undefined
    ? null
    : normalizeGuide(config.guide, "guide");
}

export function resolveDemoIngest(
  config: KandeloDemoConfig,
  profileId: string,
): DemoIngestConfig | null {
  const profile = profileConfig(config, profileId);
  if (isRecord(profile) && profile.ingest !== undefined) {
    return normalizeIngest(profile.ingest, `profiles.${profileId}.ingest`);
  }
  return config.ingest === undefined
    ? null
    : normalizeIngest(config.ingest, "ingest");
}

/** Upper bound on any image-declared cap, so a bad image can't ask the browser
 *  to buffer an unbounded upload into the VFS. */
const INGEST_MAX_BYTES_CEILING = 64 * 1024 * 1024;

const RUNTIME_FEATURES = new Set<DemoRuntimeFeature>([
  "framebuffer",
  "kms",
  "evdev-input",
  "js-workers",
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

  let network = false;
  if (value.network !== undefined) {
    if (typeof value.network !== "boolean") {
      throw new Error(`${field}.network must be a boolean`);
    }
    network = value.network;
  }

  return {
    features,
    network,
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

function normalizeInit(value: unknown, field: string): DemoInitConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const target = value.target;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`${field}.target must be a non-empty string`);
  }
  if (!INIT_TARGET_RE.test(target)) {
    throw new Error(
      `${field}.target must be a bare service name matching /etc/dinit.d/<name>`,
    );
  }
  return { target };
}

function normalizeWeb(value: unknown, field: string): DemoWebConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  if (!Array.isArray(value.requiredPorts) || value.requiredPorts.length === 0) {
    throw new Error(`${field}.requiredPorts must be a non-empty array`);
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
    const probePath = requiredString(value.probePath, `${field}.probePath`);
    if (!probePath.startsWith("/")) {
      throw new Error(`${field}.probePath must be absolute`);
    }
    web.probePath = probePath;
  }
  return web;
}

export function resolveDemoWeb(
  config: KandeloDemoConfig,
  profileId: string,
): DemoWebConfig | null {
  const profile = profileConfig(config, profileId);
  if (isRecord(profile) && profile.web !== undefined) {
    return normalizeWeb(profile.web, `profiles.${profileId}.web`);
  }
  return config.web === undefined ? null : normalizeWeb(config.web, "web");
}

const ACCENT_RE = /^#[0-9a-f]{6}$/i;
/** 8K, well past any real browser viewport, so a bad value fails loudly. */
const MAX_DISPLAY_PIXELS = 7680;
const MAX_IDENTITY_TITLE_CHARS = 64;
const MAX_IDENTITY_SUMMARY_CHARS = 512;
const MAX_IDENTITY_PACKAGES = 64;

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
  if (value.base !== undefined) {
    identity.base = requiredString(value.base, `${field}.base`);
  }
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
      requiredString(entry, `${field}.packages[${index}]`));
  }
  return identity;
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
  if (isRecord(profile) && profile.identity !== undefined) {
    return normalizeIdentity(profile.identity, `profiles.${profileId}.identity`);
  }
  return config.identity === undefined
    ? null
    : normalizeIdentity(config.identity, "identity");
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
  if (!targetPath.startsWith("/")) {
    throw new Error(`${field}.targetPath must be absolute`);
  }
  // The write goes to this exact path, so a traversal here would escape the
  // author's intended destination even though no user input reaches it.
  const pathSegments = targetPath.split("/").slice(1);
  if (
    pathSegments.length === 0
    || pathSegments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
    || targetPath.includes("\0")
  ) {
    throw new Error(`${field}.targetPath must be a normalized file path`);
  }

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

function profileConfig(
  config: KandeloDemoConfig,
  profileId: string,
): KandeloDemoProfileConfig | undefined {
  return isRecord(config.profiles) ? config.profiles[profileId] : undefined;
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
    normalizeInit(value.init, `${field}.init`);
    const presentation = value.presentation;
    if (isRecord(presentation) && presentation.autoCommand !== undefined) {
      throw new Error(
        `${field} cannot declare both init.target and presentation.autoCommand`
          + " — only one thing can be what the machine runs",
      );
    }
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
    ...(typeof config.autoCommand === "string" ? { autoCommand: config.autoCommand } : {}),
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
    ...(typeof value.devCorsProxy === "boolean" ? { devCorsProxy: value.devCorsProxy } : {}),
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
