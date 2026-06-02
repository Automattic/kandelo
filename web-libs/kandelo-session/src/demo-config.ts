import type {
  DemoPresentation,
  PrimarySurface,
} from "./kernel-host";

export const KANDELO_DEMO_CONFIG_PATH = "/etc/kandelo/demo.json";

export interface DemoPresentationConfig {
  bootPrimary: PrimarySurface;
  runningPrimary: PrimarySurface[];
  terminalAccess: DemoPresentation["terminalAccess"];
  internalsAccess: DemoPresentation["internalsAccess"];
  autoCommand?: string;
  framebufferInput?: DemoPresentation["framebufferInput"];
}

export interface DemoAssetConfig {
  path: string;
  url: string;
  sha256?: string;
  mode?: number;
  devCorsProxy?: boolean;
}

export interface DemoInitConfig {
  argv: string[];
  env?: string[];
  cwd?: string;
  maxWorkers?: number;
  maxMemoryPages?: number;
  web?: {
    label?: string;
    requiredPorts: number[];
  };
}

export type DemoActionKind = "terminal.run" | "terminal.write";

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
  init?: DemoInitConfig;
  assets?: DemoAssetConfig[];
  guide?: DemoGuideConfig;
}

export interface KandeloDemoConfig {
  version: 1;
  presentation?: DemoPresentationConfig;
  init?: DemoInitConfig;
  assets?: DemoAssetConfig[];
  guide?: DemoGuideConfig;
  profiles?: Record<string, KandeloDemoProfileConfig>;
}

export type GenericDemoPresentationKind = "terminal" | "web" | "framebuffer";

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
]);
const ACCESS_MODES = new Set(["primary", "drawer", "side"]);
const FRAMEBUFFER_INPUT_MODES = new Set<NonNullable<DemoPresentation["framebufferInput"]>>([
  "relative-scancode",
  "absolute-text",
]);
const ACTION_KINDS = new Set<DemoActionKind>(["terminal.run", "terminal.write"]);

export function parseKandeloDemoConfig(text: string): KandeloDemoConfig | null {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1) return null;
  return value as unknown as KandeloDemoConfig;
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

export function resolveDemoInit(
  config: KandeloDemoConfig,
  profileId: string,
): DemoInitConfig | null {
  const profile = profileConfig(config, profileId);
  if (isRecord(profile) && profile.init !== undefined) {
    return normalizeInit(profile.init, `profiles.${profileId}.init`);
  }
  return config.init === undefined
    ? null
    : normalizeInit(config.init, "init");
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
  if (!isRecord(config.profiles)) return undefined;
  if (isRecord(config.profiles[profileId])) {
    return config.profiles[profileId] as KandeloDemoProfileConfig;
  }
  for (const [id, profile] of Object.entries(config.profiles)) {
    if (profileId.endsWith(`-${id}`) && isRecord(profile)) {
      return profile as unknown as KandeloDemoProfileConfig;
    }
  }
  return undefined;
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
    ...(config.framebufferInput !== undefined
      ? { framebufferInput: framebufferInput(config.framebufferInput) }
      : {}),
  };
}

function normalizeInit(value: unknown, field: string): DemoInitConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0) {
    throw new Error(`${field}.argv must be a non-empty string array`);
  }
  const init: DemoInitConfig = {
    argv: value.argv.map((arg, index) => requiredString(arg, `${field}.argv[${index}]`)),
  };
  if (value.env !== undefined) {
    if (!Array.isArray(value.env)) throw new Error(`${field}.env must be a string array`);
    init.env = value.env.map((kv, index) => requiredString(kv, `${field}.env[${index}]`));
  }
  if (value.cwd !== undefined) {
    init.cwd = requiredString(value.cwd, `${field}.cwd`);
  }
  if (value.maxWorkers !== undefined) {
    init.maxWorkers = positiveInteger(value.maxWorkers, `${field}.maxWorkers`);
  }
  if (value.maxMemoryPages !== undefined) {
    init.maxMemoryPages = positiveInteger(value.maxMemoryPages, `${field}.maxMemoryPages`);
  }
  if (value.web !== undefined) {
    if (!isRecord(value.web)) throw new Error(`${field}.web must be an object`);
    if (!Array.isArray(value.web.requiredPorts) || value.web.requiredPorts.length === 0) {
      throw new Error(`${field}.web.requiredPorts must be a non-empty number array`);
    }
    init.web = {
      ...(typeof value.web.label === "string" ? { label: value.web.label } : {}),
      requiredPorts: value.web.requiredPorts.map((port, index) =>
        positiveInteger(port, `${field}.web.requiredPorts[${index}]`)
      ),
    };
  }
  return init;
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

function framebufferInput(value: unknown): NonNullable<DemoPresentation["framebufferInput"]> {
  if (
    typeof value === "string" &&
    FRAMEBUFFER_INPUT_MODES.has(value as NonNullable<DemoPresentation["framebufferInput"]>)
  ) {
    return value as NonNullable<DemoPresentation["framebufferInput"]>;
  }
  throw new Error(`presentation.framebufferInput must be one of: ${Array.from(FRAMEBUFFER_INPUT_MODES).join(", ")}`);
}

function actionKind(value: unknown, field: string): DemoActionKind {
  if (typeof value === "string" && ACTION_KINDS.has(value as DemoActionKind)) {
    return value as DemoActionKind;
  }
  throw new Error(`${field} must be one of: ${Array.from(ACTION_KINDS).join(", ")}`);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Error(`${field} must be a positive integer`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
