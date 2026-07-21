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
}

export interface KandeloDemoConfig {
  version: 1;
  presentation?: DemoPresentationConfig;
  assets?: DemoAssetConfig[];
  guide?: DemoGuideConfig;
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
  if (config.profiles === undefined) return;
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
  normalizeAssets(value.assets, `${field}.assets`);
  if (value.guide !== undefined) {
    normalizeGuide(value.guide, `${field}.guide`);
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
