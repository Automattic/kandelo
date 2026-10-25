import { validateDependencies, validateOfferedDependencies, resolveDependencies, type SessionDependency, type OfferedDependency } from "./session-dependencies";
import { validLevel, levelArguments, type LevelFormat } from "./game-levels";
/** Package-owned session procedures. URL offers carry values, never commands. */
export const PACKAGE_SESSIONS_DIR = "/usr/share/kandelo/sessions";
export const PACKAGE_SESSION_CLIENTS_DIR = "/usr/share/kandelo/session-clients";
export const MAX_SESSION_MANIFEST_BYTES = 65_536;

export type SessionValues = Record<string, string | number>;
export type SessionField = {
  id: string;
  label: string;
} & (
  | { type: "text"; default: string; maxLength: number }
  | { type: "integer"; default: number; min: number; max: number }
  | { type: "choice"; default: string; options: { value: string; label: string; args: string[]; warning?: string }[] }
  | { type: "level"; default: string; dependency: string; format: LevelFormat; sources: Record<string, string[]>; levelWarnings?: Record<string, Record<string, string>> }
);
export type SessionArgument = string | { field: string } | { options: string };
export type SessionLaunch = SessionProgramLaunch | SessionWebLaunch;
export interface SessionWebLaunch {
  surface: "web";
  host: "network.host" | "localhost";
  port: number;
  path: string;
}
export interface SessionProgramLaunch {
  executable: string;
  args: SessionArgument[];
  cwd: string;
  requires: string[];
  surface: "terminal" | "display";
  /** Mount and measure this display before dispatching the command. */
  display?: "framebuffer" | "kms";
  /** CSS pixels per guest pixel, for KMS bitmap applications. */
  displayScale?: number;
}
export interface SessionOfferType {
  id: string;
  title: string;
  description: string;
  join: string;
  /** Sharing an existing instance is explicit; no state is inferred. */
  attachExisting: boolean;
  requiresHost?: boolean;
  warning?: string;
  existingWarning?: string;
  fields: SessionField[];
  /** Omitted for services already started by their image. */
  launch?: SessionLaunch;
  hostRequires?: string[];
}
export interface SessionJoinType {
  computer?: "default";
  id: string;
  title: string;
  description: string;
  fields: SessionField[];
  launch: SessionLaunch;
}
export interface PackageSessions {
  kind: "kandelo-package-sessions";
  version: 1;
  package: string;
  packageVersion: string;
  dependencies?: SessionDependency[];
  offers: SessionOfferType[];
  joins: SessionJoinType[];
}
export interface SessionOffer {
  version: 1;
  package: string;
  packageVersion: string;
  /** Raw manifest identity; legacy invitations require an exact match. */
  manifestSha256: string;
  /** Selected join contract; host-only edits do not change client behavior. */
  procedureSha256?: string;
  offer: string;
  values: SessionValues;
  dependencies?: OfferedDependency[];
  /** Display-only snapshot; verified against installed metadata before joining. */
  presentation?: SessionPresentation;
}
export interface InstalledPackageSessions {
  manifest: PackageSessions;
  sha256: string;
  procedureSha256?: Record<string, string>;
  unavailableOffers?: string[];
  clientOnly?: boolean;
}

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
function fail(message: string): never { throw new Error(`Package sessions: ${message}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("unknown field");
}
function text(value: unknown, max = 256): asserts value is string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail("invalid text");
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) fail("invalid identifier");
}
function path(value: unknown): asserts value is string {
  text(value, 1024);
  if (!value.startsWith("/") || value.includes("\\") || (value !== "/" && value.slice(1).split("/").some(p => !p || p === "." || p === ".."))) fail("invalid absolute path");
}
function list(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) fail("invalid list");
}
function fields(value: unknown): asserts value is SessionField[] {
  list(value, 16);
  const ids = new Set<string>();
  for (const raw of value) {
    const f = record(raw);
    id(f.id); text(f.label);
    if (ids.has(f.id)) fail("duplicate field");
    ids.add(f.id);
    if (f.type === "text") {
      keys(f, ["id", "label", "type", "default", "maxLength"]);
      if (!Number.isInteger(f.maxLength) || (f.maxLength as number) < 1 || (f.maxLength as number) > 128) fail("invalid text limit");
      text(f.default, f.maxLength as number);
    } else if (f.type === "integer") {
      keys(f, ["id", "label", "type", "default", "min", "max"]);
      if (![f.min, f.max, f.default].every(Number.isSafeInteger) || (f.min as number) > (f.default as number) || (f.default as number) > (f.max as number)) fail("invalid integer bounds");
    } else if (f.type === "choice") {
      keys(f, ["id", "label", "type", "default", "options"]);
      list(f.options, 32);
      const choices = new Set<string>();
      for (const rawOption of f.options) {
        const option = record(rawOption);
        keys(option, ["value", "label", "args", "warning"]);
        if (option.warning !== undefined) text(option.warning);
        id(option.value); text(option.label); list(option.args, 16);
        for (const arg of option.args) text(arg, 1024);
        if (choices.has(option.value)) fail("duplicate choice");
        choices.add(option.value);
      }
      if (!choices.has(f.default as string)) fail("invalid default choice");
    } else if (f.type === "level") {
      keys(f, ["id", "label", "type", "default", "dependency", "format", "sources", "levelWarnings"]);
      id(f.dependency);
      if (f.format !== "doom-wad" && f.format !== "quake-pak") fail("unsupported level format");
      if (!validLevel(f.format, f.default)) fail("invalid default level");
      const sources = record(f.sources);
      if (Object.keys(sources).length > 8) fail("too many level catalogs");
      for (const [source, levels] of Object.entries(sources)) {
        id(source); list(levels, 256);
        if (!levels.length || new Set(levels).size !== levels.length || !levels.every(level => validLevel(f.format as LevelFormat, level))) fail("invalid level catalog");
      }
      if (f.levelWarnings !== undefined) {
        const warnings = record(f.levelWarnings);
        keys(warnings, Object.keys(sources));
        for (const [source, rawWarnings] of Object.entries(warnings)) {
          const byLevel = record(rawWarnings);
          keys(byLevel, sources[source] as string[]);
          for (const warning of Object.values(byLevel)) text(warning);
        }
      }
    } else fail("unsupported field type");
  }
}
function launch(value: unknown, available: Map<string, SessionField>, dependencies: SessionDependency[]): void {
  const command = record(value);
  if (command.surface === "web") {
    keys(command, ["surface", "host", "port", "path"]);
    if (command.host !== "network.host" && command.host !== "localhost") fail("invalid web destination");
    if (!Number.isInteger(command.port) || (command.port as number) < 1 || (command.port as number) > 65535) fail("invalid web port");
    path(command.path);
    return;
  }
  keys(command, ["executable", "args", "cwd", "requires", "surface", "display", "displayScale"]);
  if (command.displayScale !== undefined && (command.display !== "kms" || typeof command.displayScale !== "number" || !Number.isFinite(command.displayScale) || command.displayScale < 0.5 || command.displayScale > 4)) fail("invalid display scale");
  if (command.surface !== "terminal" && command.surface !== "display") fail("invalid launch surface");
  if (command.display !== undefined && (command.surface !== "display" || !["framebuffer", "kms"].includes(command.display as string))) fail("invalid display requirement");
  path(command.executable); path(command.cwd); list(command.args, 64);
  list(command.requires, 8);
  for (const required of command.requires) path(required);
  for (const raw of command.args) {
    if (typeof raw === "string") { text(raw, 1024); continue; }
    const arg = record(raw);
    const option = Object.hasOwn(arg, "options");
    keys(arg, [option ? "options" : "field"]);
    const ref = arg[option ? "options" : "field"];
    if (ref === "network.host" && !option) continue;
    if (!option && dependencies.some(d => ref === `dependency.${d.id}.source`)) continue;
    if (typeof ref !== "string" || !available.has(ref)) fail("unknown argument field");
    if (option && !["choice", "level"].includes(available.get(ref)!.type)) fail("argument options require a choice or level");
  }
}
export function parsePackageSessions(source: string): PackageSessions {
  if (new TextEncoder().encode(source).length > MAX_SESSION_MANIFEST_BYTES) fail("manifest too large");
  const m = record(JSON.parse(source));
  keys(m, ["kind", "version", "package", "packageVersion", "offers", "joins", "dependencies"]);
  if (m.kind !== "kandelo-package-sessions" || m.version !== 1) fail("unsupported manifest version");
  id(m.package); text(m.packageVersion, 64); list(m.offers, 16); list(m.joins, 16);
  if (m.dependencies !== undefined) validateDependencies(m.dependencies);
  const joins = new Map<string, SessionJoinType>();
  for (const raw of m.joins) {
    const join = record(raw);
    keys(join, ["id", "title", "description", "fields", "launch", "computer"]);
    if (join.computer !== undefined && join.computer !== "default") fail("unknown client computer");
    id(join.id); text(join.title); text(join.description, 1024); fields(join.fields);
    if (join.fields.some(field => field.type === "level")) fail("level selection belongs to the host setup");
    if (joins.has(join.id)) fail("duplicate join type");
    joins.set(join.id, raw as SessionJoinType);
  }
  const offers = new Set<string>();
  for (const raw of m.offers) {
    const offer = record(raw);
    keys(offer, ["id", "title", "description", "join", "attachExisting", "requiresHost", "fields", "launch", "hostRequires", "warning", "existingWarning"]);
    if (offer.warning !== undefined) text(offer.warning);
    if (offer.existingWarning !== undefined) text(offer.existingWarning);
    id(offer.id); text(offer.title); text(offer.description, 1024); fields(offer.fields);
    if (offer.requiresHost !== undefined && typeof offer.requiresHost !== "boolean") fail("invalid hosting requirement");
    if (offers.has(offer.id)) fail("duplicate offer type");
    offers.add(offer.id);
    const join = joins.get(offer.join as string);
    if (!join || typeof offer.attachExisting !== "boolean") fail("invalid offer join type");
    for (const field of [...offer.fields, ...join.fields]) if (field.type === "level") {
      const dependency = (m.dependencies as SessionDependency[] | undefined)?.find(d => d.id === field.dependency);
      if (!dependency || Object.keys(field.sources).some(source => !dependency.sources.some(s => s.id === source)) || dependency.sources.some(source => !field.sources[source.id])) fail("level catalogs must match the declared dependency sources");
    }
    for (const dependency of (m.dependencies as SessionDependency[] | undefined) ?? []) for (const source of dependency.sources) {
      if (source.offerDefaults) validateSessionValues(offer.fields, { ...sessionDefaults(offer.fields), ...source.offerDefaults });
    }
    const available = new Map<string, SessionField>(offer.fields.map(f => [`offer.${f.id}`, f]));
    if (offer.hostRequires !== undefined) { list(offer.hostRequires, 8); for (const file of offer.hostRequires) path(file); }
    if (offer.launch !== undefined) launch(offer.launch, available, m.dependencies as SessionDependency[] ?? []);
    else if (!offer.attachExisting) fail("a share-only activity must allow an existing instance");
    for (const f of join.fields) available.set(`join.${f.id}`, f);
    launch(join.launch, available, m.dependencies as SessionDependency[] ?? []);
  }
  // Unreferenced join types cannot be validated against an offer structure.
  if ([...joins.keys()].some(join => !(m.offers as SessionOfferType[]).some(offer => offer.join === join))) fail("unreferenced join type");
  return m as unknown as PackageSessions;
}
export function sessionDefaults(fields: { id: string; default: string | number }[]): SessionValues {
  return Object.fromEntries(fields.map(f => [f.id, f.default]));
}
export function validateSessionValues(fields: SessionField[], value: unknown): SessionValues {
  const values = record(value);
  keys(values, fields.map(f => f.id));
  for (const f of fields) {
    const v = values[f.id];
    if (f.type === "text") text(v, f.maxLength);
    else if (f.type === "integer") {
      if (!Number.isSafeInteger(v) || (v as number) < f.min || (v as number) > f.max) fail(`invalid ${f.label}`);
    } else if (f.type === "level") { if (!validLevel(f.format, v)) fail(`invalid ${f.label}`); }
    else if (!f.options.some(option => option.value === v)) fail(`invalid ${f.label}`);
  }
  return { ...values } as SessionValues;
}
export function validateSessionOffer(value: unknown): asserts value is SessionOffer {
  const offer = record(value);
  keys(offer, ["version", "package", "packageVersion", "manifestSha256", "procedureSha256", "offer", "values", "dependencies", "presentation"]);
  if (offer.version !== 1) fail("unsupported offer version");
  id(offer.package); id(offer.offer); text(offer.packageVersion, 64);
  if (typeof offer.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(offer.manifestSha256)) fail("invalid manifest digest");
  if (offer.procedureSha256 !== undefined && (typeof offer.procedureSha256 !== "string" || !/^[0-9a-f]{64}$/.test(offer.procedureSha256))) fail("invalid procedure digest");
  if (offer.dependencies !== undefined) validateOfferedDependencies(offer.dependencies);
  if (offer.presentation !== undefined) validateSessionPresentation(offer.presentation);
  const values = record(offer.values);
  if (Object.keys(values).length > 16) fail("too many offer values");
  for (const [key, v] of Object.entries(values)) {
    id(key);
    if (typeof v === "string") text(v, 128);
    else if (!Number.isSafeInteger(v)) fail("invalid offer value");
  }
}
export function resolveSessionOffer(installed: InstalledPackageSessions[], offer: SessionOffer) {
  validateSessionOffer(offer);
  const entry = installed.find(entry => entry.manifest.package === offer.package);
  if (!entry || entry.manifest.packageVersion !== offer.packageVersion || (offer.procedureSha256
    ? entry.procedureSha256?.[offer.offer] !== offer.procedureSha256
    : entry.sha256 !== offer.manifestSha256)) fail("The host and this computer have different activity procedures. Ask the host to create a fresh invitation; a matching client image may be required.");
  const type = entry.manifest.offers.find(type => type.id === offer.offer);
  if (!type) fail("unknown offer type");
  validateSessionValues(type.fields, offer.values);
  resolveDependencies(entry.manifest.dependencies ?? [], offer.dependencies ?? []);
  validateSessionLevels(type.fields, offer.values, offer.dependencies ?? []);
  // A compatible join can survive host-only edits. In that case callers render
  // the installed presentation, including its warnings, rather than the URL's
  // older display snapshot. Exact-manifest links still detect altered display.
  if (offer.presentation && entry.sha256 === offer.manifestSha256 && !sameSessionPresentation(offer.presentation, sessionPresentation(entry.manifest, type, offer))) fail("invitation display details do not match the installed activity");
  return { manifest: entry.manifest, type, join: entry.manifest.joins.find(join => join.id === type.join)! };
}
export function sessionCommand(
  type: SessionOfferType, join: SessionJoinType | null,
  values: SessionValues, joinValues: SessionValues = {}, dependencies: OfferedDependency[] = [],
): string {
  validateSessionValues(type.fields, values);
  validateSessionLevels(type.fields, values, dependencies);
  if (join) validateSessionValues(join.fields, joinValues);
  const command = join?.launch ?? type.launch;
  if (!command) fail("this activity only shares an existing service");
  if (command.surface === "web") fail("a web activity opens a preview, not a shell command");
  const lookup = (ref: string): string => {
    if (ref === "network.host") return "host";
    if (ref.startsWith("dependency.")) {
      const dependency = dependencies.find(d => ref === `dependency.${d.id}.source`);
      if (!dependency) fail("missing launch dependency");
      return dependency.source ?? "file";
    }
    return String(ref.startsWith("offer.") ? values[ref.slice(6)] : joinValues[ref.slice(5)]);
  };
  const fields = new Map<string, SessionField>([...type.fields.map(f => [`offer.${f.id}`, f] as const), ...(join?.fields ?? []).map(f => [`join.${f.id}`, f] as const)]);
  const args = command.args.flatMap(arg => {
    if (typeof arg === "string") return [arg];
    if ("field" in arg) return [lookup(arg.field)];
    const f = fields.get(arg.options);
    if (f?.type === "level") return levelArguments(f.format, lookup(arg.options));
    if (!f || f.type !== "choice") fail("invalid argument choice");
    return f.options.find(option => option.value === lookup(arg.options))!.args;
  });
  // This is a shell boundary, not a template evaluator: every value remains
  // one literal argument, including quotes, dollar signs and substitutions.
  const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
  return `cd ${quote(command.cwd)} && ${[command.executable, ...args].map(quote).join(" ")}`;
}
export function validateSessionLevels(fields: SessionField[], values: SessionValues, dependencies: OfferedDependency[]): void {
  for (const field of fields) if (field.type === "level") {
    const source = dependencies.find(d => d.id === field.dependency)?.source;
    if (source && !field.sources[source]?.includes(String(values[field.id]))) fail(`the selected ${field.label} is unavailable in this game data`);
  }
}
export async function sessionProcedureDigest(manifest: PackageSessions, type: SessionOfferType): Promise<string> {
  const join = manifest.joins.find(join => join.id === type.join);
  if (!join) fail("unknown join type");
  const contract = { version: 1, package: manifest.package, packageVersion: manifest.packageVersion,
    offer: type.id, fields: type.fields, dependencies: manifest.dependencies ?? [],
    join: { id: join.id, fields: join.fields, launch: join.launch, computer: join.computer } };
  const json = JSON.stringify(contract, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function loadPackageSessions(host: {
  readVfsDir(path: string): Promise<{ name: string; type?: number }[] | null>;
  readFile(path: string): Promise<Uint8Array>;
  stat?(path: string): Promise<unknown>;
}): Promise<InstalledPackageSessions[]> {
  const installed = new Map<string, InstalledPackageSessions>();
  for (const directory of [PACKAGE_SESSION_CLIENTS_DIR, PACKAGE_SESSIONS_DIR]) {
    const entries = await host.readVfsDir(directory);
    if (entries === null) continue;
    if (entries.length > 34) fail("too many installed manifests");
    for (const entry of entries.filter(entry => entry.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[a-z][a-z0-9-]{0,63}\.json$/.test(entry.name)) fail("invalid manifest filename");
      const bytes = await host.readFile(`${directory}/${entry.name}`);
      if (bytes.length > MAX_SESSION_MANIFEST_BYTES) fail("manifest too large");
      const manifest = parsePackageSessions(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (entry.name !== `${manifest.package}.json`) fail("manifest identity does not match filename");
      const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
      const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
      const previous = installed.get(manifest.package);
      if (previous && previous.sha256 !== sha256) fail("conflicting host and client procedures");
      const unavailableOffers: string[] = [];
      if (host.stat) for (const type of manifest.offers) {
        for (const file of type.hostRequires ?? []) if (!await host.stat(file)) { unavailableOffers.push(type.id); break; }
      }
      const procedureSha256 = Object.fromEntries(await Promise.all(manifest.offers.map(async type =>
        [type.id, await sessionProcedureDigest(manifest, type)])));
      installed.set(manifest.package, { manifest, sha256, procedureSha256, unavailableOffers, clientOnly: directory === PACKAGE_SESSION_CLIENTS_DIR });
    }
  }
  if (installed.size > 32) fail("too many installed packages");
  return [...installed.values()].sort((a, b) => a.manifest.package.localeCompare(b.manifest.package));
}

/** Unverified display information, never a launch procedure or download authority. */
export type SessionDisplayField = Exclude<SessionField, { type: "choice" | "level" }> |
  { id: string; label: string; type: "choice"; default: string; options: { value: string; label: string; warning?: string }[] };
export interface SessionPresentation {
  title: string;
  description: string;
  warnings?: string[];
  settings: { id: string; label: string; value: string | number }[];
  join: { title: string; description: string; fields: SessionDisplayField[] };
  dependencies: { id: string; title: string; hint: string; source?: { title: string; url: string } }[];
}

export function sessionPresentation(manifest: PackageSessions, type: SessionOfferType, offer: Pick<SessionOffer, "values" | "dependencies">): SessionPresentation {
  const join = manifest.joins.find(join => join.id === type.join)!;
  return {
    title: type.title, description: type.description,
    ...(() => {
      const warnings = [type.warning, ...type.fields.map(field => sessionFieldWarning(field, offer.values[field.id], offer.dependencies?.find(d => field.type === "level" && d.id === field.dependency)?.source)),
        ...(manifest.dependencies ?? []).map(dependency => {
          const content = offer.dependencies?.find(content => content.id === dependency.id);
          return content?.source ? dependency.sources.find(source => source.id === content.source)?.warning : dependency.fileWarning;
        })].filter((warning): warning is string => !!warning);
      return warnings.length ? { warnings: [...new Set(warnings)] } : {};
    })(),
    settings: type.fields.map(field => ({ id: field.id, label: field.label,
      value: field.type === "choice" ? field.options.find(option => option.value === offer.values[field.id])!.label : offer.values[field.id] })),
    join: { title: join.title, description: join.description, fields: join.fields.map(field => {
      if (field.type === "level") throw new Error("Participant level fields are unsupported");
      return field.type === "choice" ? { id: field.id, label: field.label, type: field.type, default: field.default,
        options: field.options.map(({ value, label, warning }) => ({ value, label, ...(warning ? { warning } : {}) })) } : { ...field };
    }) },
    dependencies: (manifest.dependencies ?? []).map(dependency => {
      const source = dependency.sources.find(source => source.id === offer.dependencies?.find(content => content.id === dependency.id)?.source);
      return { id: dependency.id, title: dependency.title, hint: dependency.hint,
        ...(source ? { source: { title: source.title, url: source.url } } : {}) };
    }),
  };
}

const object = (v: any, allowed: string[]) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const displayText = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const displayId = (v: unknown) => typeof v === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(v);
function entries(v: any, max: number, check: (item: any) => boolean): boolean {
  return Array.isArray(v) && v.length <= max && new Set(v.map(item => item?.id)).size === v.length && v.every(check);
}
export function validateSessionPresentation(value: unknown): asserts value is SessionPresentation {
  const p = value as any;
  const field = (f: any) => {
    if (!f || !displayId(f.id) || !displayText(f.label)) return false;
    if (f.type === "text") return object(f, ["id", "label", "type", "default", "maxLength"]) && Number.isInteger(f.maxLength) && f.maxLength >= 1 && f.maxLength <= 128 && displayText(f.default, f.maxLength);
    if (f.type === "integer") return object(f, ["id", "label", "type", "default", "min", "max"]) && [f.min, f.max, f.default].every(Number.isSafeInteger) && f.min <= f.default && f.default <= f.max;
    return f.type === "choice" && object(f, ["id", "label", "type", "default", "options"]) && Array.isArray(f.options) && f.options.length <= 32
      && new Set(f.options.map((o: any) => o?.value)).size === f.options.length
      && f.options.every((o: any) => object(o, ["value", "label", "warning"]) && displayId(o.value) && displayText(o.label) && (o.warning === undefined || displayText(o.warning))) && f.options.some((o: any) => o.value === f.default);
  };
  const source = (s: any) => {
    if (!object(s, ["title", "url"]) || !displayText(s.title) || !displayText(s.url, 2048)) return false;
    try { const url = new URL(s.url); return url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { return false; }
  };
  if (!object(p, ["title", "description", "settings", "join", "dependencies", "warnings"]) || !displayText(p.title) || !displayText(p.description, 2048)
    || (p.warnings !== undefined && (!Array.isArray(p.warnings) || p.warnings.length > 20 || !p.warnings.every((w: unknown) => displayText(w))))
    || !entries(p.settings, 16, s => object(s, ["id", "label", "value"]) && displayId(s.id) && displayText(s.label) && (typeof s.value === "string" ? displayText(s.value) : Number.isSafeInteger(s.value)))
    || !object(p.join, ["title", "description", "fields"]) || !displayText(p.join.title) || !displayText(p.join.description, 2048) || !entries(p.join.fields, 16, field)
    || !entries(p.dependencies, 2, d => object(d, ["id", "title", "hint", "source"]) && displayId(d.id) && displayText(d.title) && displayText(d.hint, 1024) && (d.source === undefined || source(d.source)))) {
    throw new Error("Invalid invitation display details");
  }
}

/** Ignore JSON object key order, but require the displayed procedure to match. */
export function sameSessionPresentation(a: SessionPresentation, b: SessionPresentation): boolean {
  const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

/** Return only the warning for the current choice or the current data source/map. */
export function sessionFieldWarning(field: SessionField | SessionDisplayField, value: string | number | undefined, source?: string): string | undefined {
  if (field.type === "choice") return field.options.find(option => option.value === value)?.warning;
  if (field.type === "level" && source) return field.levelWarnings?.[source]?.[String(value)];
  return undefined;
}
