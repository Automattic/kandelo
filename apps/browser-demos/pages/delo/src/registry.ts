// The delo registry: the published Kandelo images a `delo run` command can
// start, the apps `delo list` links to, the binaries and pipelines a computer
// can be built from, and the options a computer can enable.
//
// The registry is a SEPARATE, tracked list from any VFS image, for the same
// reason the gallery roster is (see gallery-roster.ts): an image describes
// itself through its own /etc/kandelo/demo.json, but a stranger's image must
// not be able to claim a name in the registry just by existing. Membership is
// this file's tracked `registry.json`; what the machine is stays 100% the
// image's.
//
// Five entry types share one list and one set of names:
//
// - `image`: a VFS image this deployment boots on its own runtime.
// - `app`: a standalone deployment that ships its own Kandelo runtime. Delo
//   only links to it from `delo list`, so its ABI never has to match this
//   one's.
// - `binary`: programs and their own files, which a computer can add.
// - `pipeline`: a recipe for a working computer: the binaries it uses, the
//   options it turns on, and its configuration, services and accounts.
// - `option`: a tool of the delo computer page.
//
// Binaries, pipelines and options share their keys, and each takes only the
// keys it needs. `use` names the binaries installed with the entry, `need`
// names contracts some installed entry must fill, `provide` names the
// contracts the entry fills, and `device` names the kernel devices it opens.
// `files` lists what the entry writes to the disk, in order: each file names
// its path, `to`, its `type`, and for a regular file one source, `content`
// or `from`. Only a pipeline takes `enable`, the options it turns on. What a
// computer starts is in its files: dinit at boot when the disk has
// /etc/dinit.d/boot, and the scripts in /etc/profile.d in the terminal's
// login shell.
//
// Array order in the registry is the order the dropdowns show.

import { parseVfsTool, type VfsTool } from "../../kandelo/webmcp/vfs-tools";

export interface DeloImage {
  name: string;
  type: "image";
  description: string;
  /** Absolute URL of the image. */
  vfs: string;
  /** Which machine definition inside the image's own demo.json to boot. */
  profile: string;
}

interface DeloApp {
  name: string;
  type: "app";
  description: string;
  /** Absolute URL of the deployment. */
  url: string;
}

/**
 * One file a binary or pipeline writes `to` a path in the computer. `type` is
 * `file` (the default, never stored), `directory` or `symlink`. A regular
 * file's `content` is its text; in a computer's pipeline, on a path a binary
 * or the pipeline already wrote, the text goes at the end of that file,
 * which keeps its mode. A regular file's `from` is a path under the binaries root,
 * or an https URL, copied to the path. A `from` of `<image>:<path>`, a
 * Kandelo VFS image under the binaries root and a path inside it, copies
 * that tree with the image's modes. A directory is empty, owned by `owner` ("uid:gid", default
 * root), or, with a `from`, a zip archive named as for a regular file,
 * unpacked under it. A symlink's `from` is the absolute path it points to.
 * `lazy` writes only the file's size, which the build asks the server for:
 * the machine downloads the bytes when a program first reads the file. A lazy archive writes its
 * member list, and the machine downloads the archive when a program first
 * reads a member. `mode` (default `644`, `755` for a directory) decides
 * what is executable.
 */
export type DeloFile =
  | { to: string; content: string; mode?: string }
  | { to: string; from: string; lazy?: true; mode?: string }
  | { to: string; type: "directory"; owner?: string; mode?: string }
  | { to: string; type: "directory"; from: string; lazy?: true }
  | { to: string; type: "symlink"; from: string };

export interface DeloPackage {
  name: string;
  type: "binary" | "pipeline";
  description: string;
  use: string[];
  enable: string[];
  provide: string[];
  need: string[];
  device: string[];
  files: DeloFile[];
}

/** The keys binaries and pipelines share: what an entry installs. */
export type DeloPipeline = Pick<DeloPackage, "use" | "enable" | "provide" | "need" | "device" | "files">;

/** A computer's own pipeline: a registry pipeline without its type. Its name
 *  follows the registry's rules, so it can become a registry pipeline. Delo
 *  writes it into /etc/delo/config.json in the computer. */
export type DeloOwnPipeline = Pick<DeloPackage, "name" | "description"> & DeloPipeline;

export interface DeloOption {
  name: string;
  type: "option";
  description: string;
  use: string[];
  need: string[];
}

export type DeloEntry = DeloImage | DeloApp | DeloPackage | DeloOption;

export interface DeloRegistry {
  schema: 1;
  entries: DeloEntry[];
}

const DELO_REGISTRY_SCHEMA = 1;

/** `@scope/name`: two short, lowercase, dash/dot/underscore identifiers. */
const SCOPED_NAME_RE =
  /^@[a-z0-9](?:[a-z0-9._-]{0,63})?\/[a-z0-9](?:[a-z0-9._-]{0,63})?$/;

/** Same id shape as a gallery roster profile (see gallery-roster.ts). Also
 *  the shape of a package name, a contract, and a device. */
const IDENTIFIER_RE = /^[a-z0-9](?:[a-z0-9._-]{0,127})?$/;

export const MAX_PIPELINE_DESCRIPTION_LENGTH = 500;

/** A permission mode such as `644` or `4755`. */
const MODE_RE = /^[0-7]{3,4}$/;

/** A numeric owner such as `1000:1000`. */
const OWNER_RE = /^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/;

/**
 * Parse and validate the tracked `registry.json`. Throws on anything that
 * does not match the exact `{ schema: 1, entries: [...] }` shape, including a
 * wrong schema version, an unknown entry type, a malformed entry, a duplicate
 * name, a `use` of anything but a registered binary, a pipeline that
 * turns on an unknown option, or a need no entry provides. This file is checked in, but it is still parsed the way
 * untrusted-ish input is treated elsewhere in this package: fail loudly and
 * name the problem.
 */
export function parseDeloRegistry(text: string): DeloRegistry {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("delo registry must be an object");
  }
  requireExactKeys(value, ["entries", "schema"], "delo registry");
  if (value.schema !== DELO_REGISTRY_SCHEMA) {
    throw new Error(
      `delo registry schema must be ${DELO_REGISTRY_SCHEMA}, got `
        + JSON.stringify(value.schema),
    );
  }
  if (!Array.isArray(value.entries)) {
    throw new Error("delo registry entries must be an array");
  }
  if (value.entries.length === 0) {
    throw new Error("delo registry entries must not be empty");
  }

  const seen = new Set<string>();
  const entries = value.entries.map((raw, index) => {
    const entry = parseDeloEntry(raw, index);
    if (seen.has(entry.name)) {
      throw new Error(
        `delo registry entries[${index}] duplicates an earlier entry: `
          + `name ${JSON.stringify(entry.name)}`,
      );
    }
    seen.add(entry.name);
    return entry;
  });

  requireResolvablePackages(entries);
  return { schema: DELO_REGISTRY_SCHEMA, entries };
}

/** Whether `entry` is something a computer installs: a binary or a pipeline. */
export function isDeloInstallable(entry: DeloEntry): entry is DeloPackage {
  return entry.type === "binary" || entry.type === "pipeline";
}

/** The image `name` refers to, or null when no image has it. */
export function findDeloImage(registry: DeloRegistry, name: string): DeloImage | null {
  return deloImages(registry).find((entry) => entry.name === name) ?? null;
}

/** Every image, in registry order: the `delo run` list. */
export function deloImages(registry: DeloRegistry): DeloImage[] {
  return registry.entries.filter((entry): entry is DeloImage => entry.type === "image");
}

function parseDeloEntry(value: unknown, index: number): DeloEntry {
  const field = `delo registry entries[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  if (value.type === "image") {
    requireExactKeys(value, ["description", "name", "profile", "type", "vfs"], field);
    return {
      name: scopedNameField(value.name, `${field}.name`),
      type: "image",
      description: descriptionField(value.description, `${field}.description`),
      vfs: urlField(value.vfs, `${field}.vfs`),
      profile: identifierField(value.profile, `${field}.profile`),
    };
  }
  if (value.type === "app") {
    requireExactKeys(value, ["description", "name", "type", "url"], field);
    return {
      name: scopedNameField(value.name, `${field}.name`),
      type: "app",
      description: descriptionField(value.description, `${field}.description`),
      url: urlField(value.url, `${field}.url`),
    };
  }
  if (value.type === "option") {
    requireKnownKeys(value, ["description", "name", "need", "type", "use"], field);
    return {
      name: identifierField(value.name, `${field}.name`),
      type: "option",
      description: descriptionField(value.description, `${field}.description`),
      use: identifierListField(value.use, `${field}.use`),
      need: identifierListField(value.need, `${field}.need`),
    };
  }
  if (value.type !== "binary" && value.type !== "pipeline") {
    throw new Error(`${field}.type must be "image", "app", "binary", "pipeline", or "option"`);
  }
  if (value.type === "binary" && value.enable !== undefined) {
    throw new Error(`${field} is a binary, which takes no enable: a pipeline does`);
  }
  requireKnownKeys(value, ["description", "name", "type", ...PIPELINE_KEYS], field);
  if ((value.type === "binary" || value.files !== undefined) && (!Array.isArray(value.files) || value.files.length === 0)) {
    throw new Error(`${field}.files must be a non-empty array`);
  }
  return {
    name: identifierField(value.name, `${field}.name`),
    type: value.type,
    description: descriptionField(value.description, `${field}.description`),
    ...pipelineFields(value, field, value.type),
  };
}

const PIPELINE_KEYS = ["device", "enable", "files", "need", "provide", "use"];

const PIPELINE_SUFFIX = "-pipeline";

/** The name `delo init <computer>` gives the computer's own pipeline:
 *  `<computer>-pipeline`, lowercased, with every character a registry name
 *  refuses turned into `-`, and shortened to fit a registry name. */
export function deloPipelineName(computer: string): string {
  const base = computer.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[._-]+/, "");
  if (base === "") return PIPELINE_SUFFIX.slice(1);
  return `${base.slice(0, 128 - PIPELINE_SUFFIX.length)}${PIPELINE_SUFFIX}`;
}

/** Why `name` cannot name a computer's own pipeline, or null when it can: it
 *  follows the rules of a registry entry name and names no registry entry. */
export function deloPipelineNameProblem(registry: DeloRegistry, name: string): string | null {
  if (!IDENTIFIER_RE.test(name)) return "a pipeline name holds lowercase letters, digits, \".\", \"_\" and \"-\", up to 128 characters, and starts with a letter or a digit";
  if (registry.entries.some((entry) => entry.name === name)) return `${name} is already the name of a registry entry`;
  return null;
}

/** Parse a computer's own pipeline, which may be empty. */
export function parseDeloOwnPipeline(value: unknown, field: string): DeloOwnPipeline {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const { name, description, ...pipeline } = value;
  if (typeof name !== "string" || !IDENTIFIER_RE.test(name)) throw new Error(`${field}.name is invalid`);
  if (typeof description !== "string" || description.length > MAX_PIPELINE_DESCRIPTION_LENGTH) throw new Error(`${field}.description is invalid`);
  return { name, description, ...parseDeloPipeline(pipeline, field) };
}

/** Parse the keys binaries and pipelines share, which may be empty. */
export function parseDeloPipeline(value: unknown, field: string): DeloPipeline {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  requireKnownKeys(value, PIPELINE_KEYS, field);
  return pipelineFields(value, field, "pipeline");
}

function pipelineFields(value: Record<string, unknown>, field: string, type: "binary" | "pipeline"): DeloPipeline {
  const files = value.files === undefined ? [] : filesField(value.files, `${field}.files`);
  requireToolFiles(files, type, field);
  return {
    use: identifierListField(value.use, `${field}.use`),
    enable: identifierListField(value.enable, `${field}.enable`),
    provide: identifierListField(value.provide, `${field}.provide`),
    need: identifierListField(value.need, `${field}.need`),
    device: identifierListField(value.device, `${field}.device`),
    files,
  };
}

const TOOLS_DIR = "/etc/mcp/";

export type DeloToolFile = VfsTool & { command: string[] };

/** A tool file parsed as Kandelo parses it, with a command list only: delo runs a tool with no shell. */
export function parseDeloToolFile(file: string, text: string): DeloToolFile {
  const tool = parseVfsTool(file, text);
  if (!Array.isArray(tool.command)) throw new Error(`${file} needs a "command" list: delo runs a tool with no shell`);
  return { ...tool, command: tool.command };
}

/** A tool file is named after the type that writes it: `binary_<name>.json`
 *  or `pipeline_<name>.json`, so the tool's name says where it comes from.
 *  A tool file the entry writes must parse. */
function requireToolFiles(files: readonly DeloFile[], type: "binary" | "pipeline", field: string): void {
  for (const path of pathsOf(files)) {
    if (!path.startsWith(TOOLS_DIR) || path.slice(TOOLS_DIR.length).startsWith(`${type}_`)) continue;
    throw new Error(`${field} writes ${path}, but a ${type} names its tool files ${TOOLS_DIR}${type}_<name>.json`);
  }
  for (const file of deloToolWritesOf(files)) parseDeloToolFile(file.to, file.content);
}

/** Whether a file at `path` declares a WebMCP tool. */
const isDeloToolPath = (path: string) => path.startsWith(TOOLS_DIR) && path.endsWith(".json");

/** The files of `files` that write a tool file with inline content. */
export const deloToolWritesOf = (files: readonly DeloFile[]) =>
  files.filter((file): file is Extract<DeloFile, { content: string }> => "content" in file && isDeloToolPath(file.to));

/** The tools `entry` writes to /etc/mcp, in file order. A tool file inside an
 *  extracted archive or a copied image tree is not known before the computer runs. */
export function deloToolFilesOf(entry: DeloPipeline): DeloToolFile[] {
  return deloToolWritesOf(entry.files).map((file) => parseDeloToolFile(file.to, file.content));
}

const DINIT_BOOT = "/etc/dinit.d/boot";

/** Whether `entry` writes dinit's boot service, so a computer with it starts dinit at boot. */
export function deloBootsDinit(entry: DeloPipeline): boolean {
  return pathsOf(entry.files).includes(DINIT_BOOT);
}

export function deloPathsOf(entry: DeloPipeline): string[] {
  return pathsOf(entry.files);
}

const pathsOf = (files: readonly DeloFile[]) => files.map((file) => file.to);

/** Every path under the binaries root that a lazy file or lazy archive of
 *  the registry names, once each: what a deployment must serve for the
 *  kernel to download. */
export function deloLazyStorePaths(registry: DeloRegistry): string[] {
  const files = registry.entries.filter(isDeloInstallable).flatMap((entry) => entry.files);
  const paths = files.flatMap((file) => "lazy" in file && file.lazy && !file.from.includes("://") ? [file.from] : []);
  return [...new Set(paths)];
}

function requireResolvablePackages(entries: readonly DeloEntry[]): void {
  const binaries = new Set(entries.filter((entry) => entry.type === "binary").map((entry) => entry.name));
  const options = new Set(entries.filter((entry) => entry.type === "option").map((entry) => entry.name));
  const contracts = new Set(entries.filter(isDeloInstallable).flatMap((entry) => entry.provide));
  const dependents = entries.filter((entry): entry is DeloPackage | DeloOption => isDeloInstallable(entry) || entry.type === "option");
  for (const entry of dependents) {
    for (const used of entry.use) {
      if (binaries.has(used)) continue;
      throw new Error(
        `delo registry ${entry.type} ${JSON.stringify(entry.name)} uses `
          + `${JSON.stringify(used)}, which is not a registered binary`,
      );
    }
    for (const option of entry.type === "option" ? [] : entry.enable) {
      if (options.has(option)) continue;
      throw new Error(`delo registry pipeline ${JSON.stringify(entry.name)} enables ${JSON.stringify(option)}, which is not a registered option`);
    }
    for (const need of entry.need) {
      if (contracts.has(need)) continue;
      throw new Error(
        `delo registry ${entry.type} ${JSON.stringify(entry.name)} needs `
          + `${JSON.stringify(need)}, which no registered binary or pipeline provides`,
      );
    }
  }
}

function filesField(value: unknown, field: string): DeloFile[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((raw, index) => parseDeloFile(raw, `${field}[${index}]`));
}

const FILE_TYPES = ["file", "directory", "symlink"];

/** The keys, besides `to` and `type`, each kind of file takes. */
export const FILE_KEYS = {
  content: ["content", "mode"],
  from: ["from", "lazy", "mode"],
  directory: ["mode", "owner"],
  archive: ["from", "lazy"],
  symlink: ["from"],
} as const;

type DeloFileKind = keyof typeof FILE_KEYS;

/** The kind of a file object: its type, and for a regular file its one
 *  source. Undefined for a regular file with no source or both. */
export function deloFileKind(value: Record<string, unknown>): DeloFileKind | undefined {
  if (value.type === "symlink") return "symlink";
  if (value.type === "directory") return value.from === undefined ? "directory" : "archive";
  const sources = (["content", "from"] as const).filter((key) => value[key] !== undefined);
  return sources.length === 1 ? sources[0] : undefined;
}

/** The image and the path inside it that a regular file's `from` names, or
 *  null for a path under the binaries root or a URL. */
export function deloImageSource(from: string): { image: string; path: string } | null {
  const colon = from.indexOf(":");
  if (colon === -1 || from.includes("://")) return null;
  return { image: from.slice(0, colon), path: from.slice(colon + 1) };
}

export function parseDeloFile(value: unknown, field: string): DeloFile {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  if (value.type !== undefined && !FILE_TYPES.includes(value.type as string)) {
    throw new Error(`${field}.type must be one of ${FILE_TYPES.join(", ")}`);
  }
  const kind = deloFileKind(value);
  if (kind === undefined) {
    throw new Error(`${field} must have exactly one of content, from`);
  }
  const { type: _, ...keys } = value;
  requireKnownKeys(keys, [...FILE_KEYS[kind], "to"], field);
  const to = absolutePathField(value.to, `${field}.to`);
  const mode = value.mode === undefined ? {} : { mode: modeField(value.mode, `${field}.mode`) };

  if (kind === "symlink") {
    return { to, type: "symlink", from: absolutePathField(value.from, `${field}.from`) };
  }
  if (kind === "directory") {
    if (value.owner !== undefined && (typeof value.owner !== "string" || !OWNER_RE.test(value.owner))) {
      throw new Error(`${field}.owner must be a "uid:gid" string such as "1000:1000"`);
    }
    const owner = value.owner === undefined ? {} : { owner: value.owner };
    return { to, type: "directory", ...owner, ...mode };
  }
  if (kind === "content") {
    return { to, content: contentField(value.content, `${field}.content`), ...mode };
  }
  const image = kind === "from" && typeof value.from === "string" ? deloImageSource(value.from) : null;
  if (image !== null) {
    requireKnownKeys(keys, ["from", "to"], field);
    binaryPathField(image.image, `${field}.from`);
    absolutePathField(image.path, `${field}.from`);
    return { to, from: value.from as string };
  }

  const source = value.from;
  const remote = typeof source === "string" && source.includes("://");
  const from = remote
    ? httpsUrlField(source, `${field}.from`)
    : binaryPathField(source, `${field}.from`);
  if (value.lazy !== undefined && value.lazy !== true) {
    throw new Error(`${field}.lazy must be true when present`);
  }
  const lazy = value.lazy === true ? { lazy: true as const } : {};
  if (kind === "archive") return { to, type: "directory", from, ...lazy };
  return { to, from, ...lazy, ...mode };
}

function contentField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function scopedNameField(value: unknown, field: string): string {
  if (typeof value !== "string" || !SCOPED_NAME_RE.test(value)) {
    throw new Error(
      `${field} must be a lowercase "@scope/name" (letters, digits, ".", `
        + `"_", "-", up to 64 characters on each side)`,
    );
  }
  return value;
}

function descriptionField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function urlField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  if (url.hash !== "") {
    throw new Error(`${field} must not carry a fragment`);
  }
  return url.href;
}

function identifierField(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    throw new Error(
      `${field} must be a lowercase identifier (letters, digits, ".", "_", `
        + `"-", up to 128 characters)`,
    );
  }
  return value;
}

function identifierListField(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => identifierField(item, `${field}[${index}]`));
}

/** An absolute path with no empty, `.`, or `..` segment. */
function absolutePathField(value: unknown, field: string): string {
  const segments = typeof value === "string" ? value.split("/") : [];
  const normalized = segments.length > 1
    && segments[0] === ""
    && segments.slice(1).every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!normalized) {
    throw new Error(`${field} must be an absolute, normalized path`);
  }
  return value as string;
}

function httpsUrlField(value: unknown, field: string): string {
  const url = urlField(value, field);
  if (!url.startsWith("https:")) {
    throw new Error(`${field} must be an https URL`);
  }
  return url;
}

/** A path under the binaries root, such as `programs/wasm32/bash.wasm`. */
function binaryPathField(value: unknown, field: string): string {
  const segments = typeof value === "string" ? value.split("/") : [];
  const normalized = segments.length > 0
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes(":"));
  if (!normalized) {
    throw new Error(`${field} must be a relative, normalized path under the binaries root`);
  }
  return value as string;
}

function modeField(value: unknown, field: string): string {
  if (typeof value !== "string" || !MODE_RE.test(value)) {
    throw new Error(`${field} must be an octal mode string such as "644"`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  const matches = actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
  if (!matches) {
    throw new Error(
      `${field} must have exactly these keys: ${expected.join(", ")}`,
    );
  }
}

function requireKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `${field} has unknown keys: ${unknown.sort().join(", ")}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
