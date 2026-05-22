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
}

export interface DemoAssetConfig {
  path: string;
  url: string;
  sha256?: string;
  mode?: number;
  devCorsProxy?: boolean;
}

export interface KandeloDemoProfileConfig {
  presentation?: DemoPresentationConfig;
  assets?: DemoAssetConfig[];
}

export interface KandeloDemoConfig {
  version: 1;
  presentation?: DemoPresentationConfig;
  assets?: DemoAssetConfig[];
  profiles?: Record<string, KandeloDemoProfileConfig>;
}

const PRIMARY_SURFACES = new Set<PrimarySurface>([
  "syslog",
  "terminal",
  "framebuffer",
  "web",
]);
const ACCESS_MODES = new Set(["primary", "drawer", "side"]);

export function parseKandeloDemoConfig(text: string): KandeloDemoConfig | null {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1) return null;
  return value as unknown as KandeloDemoConfig;
}

export function resolveDemoPresentation(
  config: KandeloDemoConfig,
  profileId: string,
): DemoPresentation | null {
  const profile = isRecord(config.profiles) ? config.profiles[profileId] : undefined;
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
  const profile = isRecord(config.profiles) ? config.profiles[profileId] : undefined;
  return [
    ...normalizeAssets(config.assets, "assets"),
    ...normalizeAssets(
      isRecord(profile) ? profile.assets : undefined,
      `profiles.${profileId}.assets`,
    ),
  ];
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

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${field} must be a non-empty string`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
