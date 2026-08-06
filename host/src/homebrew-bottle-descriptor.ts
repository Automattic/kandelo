import {
  assertHomebrewCanonicalText,
  compareHomebrewCanonicalText,
} from "./homebrew-lazy-layer-descriptor";
import { KANDELO_HOMEBREW_GUEST_LAYOUT } from "./homebrew-guest-layout";
import type { HomebrewBottleArch, HomebrewLinkEntry } from "./homebrew-bottle-types";

const SHA256_RE = /^[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-,:\[\]]*$/;
const RELATIVE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-,:\[\]]*(?:\/[A-Za-z0-9][A-Za-z0-9._+\-,:\[\]]*)*$/;
const FULL_NAME_RE = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/;
const LINK_DESTINATION_ROOTS = new Set([
  "bin", "sbin", "include", "lib", "libexec", "share", "etc", "var", "Frameworks",
]);
const BOOTSTRAP_FULL_NAME = "kandelo-dev/tap-core/homebrew-bootstrap";
const BOOTSTRAP_OUTPUTS = [
  ["homebrew-bootstrap", "libexec/homebrew-bootstrap.zip"],
  ["homebrew-brew", "libexec/homebrew-brew.env"],
] as const;

export interface HomebrewBottleDependencyIdentity {
  fullName: string;
  version: string;
  revision: number;
  bottleRebuild: number;
  bottleSha256: string;
}

export interface HomebrewBottleSupportOutput {
  name: string;
  kegRelativePath: string;
  sha256: string;
  bytes: number;
}

/**
 * Public materialization facts for exactly one Homebrew bottle.
 *
 * This deliberately has no publisher, campaign, source, workflow, or release
 * provenance: those records are not inputs to flat VFS materialization.
 */
export interface HomebrewBottleDescriptor {
  schema: 1;
  name: string;
  fullName: string;
  version: string;
  revision: number;
  bottleRebuild: number;
  arch: HomebrewBottleArch;
  kandeloAbi: number;
  bottleTag: string;
  layout: "kandelo-homebrew-v1";
  materialization: "keg" | "homebrew-runtime-support-v1";
  prefix: string;
  cellar: string;
  keg: string;
  payloadRoot: string;
  receipts: string[];
  links: HomebrewLinkEntry[];
  pathPrepend: string[];
  supportOutputs: HomebrewBottleSupportOutput[];
  dependencies: HomebrewBottleDependencyIdentity[];
  url: string;
  sha256: string;
  bytes: number;
  compression: "gzip";
}

export class HomebrewBottleDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewBottleDescriptorError";
  }
}

const DESCRIPTOR_KEYS = [
  "schema", "name", "fullName", "version", "revision", "bottleRebuild", "arch",
  "kandeloAbi", "bottleTag", "layout", "materialization", "prefix", "cellar", "keg",
  "payloadRoot", "receipts", "links", "pathPrepend", "supportOutputs", "dependencies",
  "url", "sha256", "bytes", "compression",
];
const DEPENDENCY_KEYS = ["fullName", "version", "revision", "bottleRebuild", "bottleSha256"];
const SUPPORT_OUTPUT_KEYS = ["name", "kegRelativePath", "sha256", "bytes"];

/** Validate and normalize untrusted descriptor JSON into its public contract. */
export function projectHomebrewBottleDescriptor(value: unknown): HomebrewBottleDescriptor {
  const root = exactRecord(value, DESCRIPTOR_KEYS, "Homebrew bottle descriptor");
  if (root.schema !== 1) fail("Homebrew bottle descriptor.schema must be 1");

  const name = packageName(root.name, "Homebrew bottle descriptor.name");
  const fullName = fullPackageName(root.fullName, name, "Homebrew bottle descriptor.fullName");
  const version = versionString(root.version, "Homebrew bottle descriptor.version");
  const revision = nonnegativeInteger(root.revision, "Homebrew bottle descriptor.revision");
  const bottleRebuild = nonnegativeInteger(
    root.bottleRebuild,
    "Homebrew bottle descriptor.bottleRebuild",
  );
  const arch = bottleArch(root.arch, "Homebrew bottle descriptor.arch");
  const kandeloAbi = positiveInteger(root.kandeloAbi, "Homebrew bottle descriptor.kandeloAbi");
  const bottleTag = stringValue(root.bottleTag, "Homebrew bottle descriptor.bottleTag");
  if (bottleTag !== `${arch}_kandelo`) {
    fail("Homebrew bottle descriptor.bottleTag must be derived from arch");
  }
  if (root.layout !== "kandelo-homebrew-v1") {
    fail("Homebrew bottle descriptor.layout must be kandelo-homebrew-v1");
  }
  const materialization = root.materialization;
  if (materialization !== "keg" && materialization !== "homebrew-runtime-support-v1") {
    fail("Homebrew bottle descriptor.materialization is invalid");
  }

  const payloadRoot = `${name}/${version}`;
  const keg = `${KANDELO_HOMEBREW_GUEST_LAYOUT.cellar}/${payloadRoot}`;
  const cellarRelativePath = canonicalCellarRelativePath();
  expectEqual(root.prefix, KANDELO_HOMEBREW_GUEST_LAYOUT.prefix, "prefix");
  expectEqual(root.cellar, KANDELO_HOMEBREW_GUEST_LAYOUT.cellar, "cellar");
  expectEqual(root.payloadRoot, payloadRoot, "payloadRoot");
  expectEqual(root.keg, keg, "keg");

  const receipts = receiptPaths(root.receipts, name, payloadRoot, cellarRelativePath);
  const links = linkEntries(root.links, payloadRoot, cellarRelativePath);
  const pathPrepend = pathEntries(root.pathPrepend);
  const supportOutputs = supportOutputEntries(root.supportOutputs);
  const dependencies = dependencyEntries(root.dependencies);
  const sha256 = digest(root.sha256, "Homebrew bottle descriptor.sha256");
  const bytes = positiveInteger(root.bytes, "Homebrew bottle descriptor.bytes");
  const url = publicBottleUrl(root.url, sha256);
  if (root.compression !== "gzip") {
    fail("Homebrew bottle descriptor.compression must be gzip");
  }

  validateMaterialization(fullName, materialization, supportOutputs);
  return {
    schema: 1,
    name,
    fullName,
    version,
    revision,
    bottleRebuild,
    arch,
    kandeloAbi,
    bottleTag,
    layout: "kandelo-homebrew-v1",
    materialization,
    prefix: KANDELO_HOMEBREW_GUEST_LAYOUT.prefix,
    cellar: KANDELO_HOMEBREW_GUEST_LAYOUT.cellar,
    keg,
    payloadRoot,
    receipts,
    links,
    pathPrepend,
    supportOutputs,
    dependencies,
    url,
    sha256,
    bytes,
    compression: "gzip",
  };
}

/** Normative compact canonical JSON, recursively key-sorted and LF-terminated. */
export function encodeHomebrewBottleDescriptor(
  descriptor: HomebrewBottleDescriptor,
): Uint8Array {
  const canonical = projectHomebrewBottleDescriptor(descriptor);
  return new TextEncoder().encode(`${JSON.stringify(sortJson(canonical))}\n`);
}

function receiptPaths(
  value: unknown,
  name: string,
  payloadRoot: string,
  cellarRelativePath: string,
): string[] {
  const receipts = stringArray(value, "Homebrew bottle descriptor.receipts");
  const expected = [
    `${cellarRelativePath}/${payloadRoot}/.brew/${name}.rb`,
    `${cellarRelativePath}/${payloadRoot}/INSTALL_RECEIPT.json`,
  ];
  if (receipts.length !== expected.length || !sameSet(receipts, expected)) {
    fail("Homebrew bottle descriptor.receipts must be the canonical keg receipts");
  }
  return receipts;
}

function linkEntries(
  value: unknown,
  payloadRoot: string,
  cellarRelativePath: string,
): HomebrewLinkEntry[] {
  if (!Array.isArray(value)) fail("Homebrew bottle descriptor.links must be an array");
  const sourcePrefix = `${cellarRelativePath}/${payloadRoot}/`;
  const sources = new Set<string>();
  const targets = new Set<string>();
  return value.map((item, index) => {
    const label = `Homebrew bottle descriptor.links[${index}]`;
    const entry = record(item, label);
    const keys = Object.keys(entry);
    if (!sameSet(keys, ["type", "source", "target"]) && !sameSet(keys, ["type", "source", "target", "mode"])) {
      fail(`${label} has unknown or missing fields`);
    }
    const type = entry.type;
    if (type !== "symlink" && type !== "directory" && type !== "file") {
      fail(`${label}.type is invalid`);
    }
    const source = relativePath(entry.source, `${label}.source`);
    const target = relativePath(entry.target, `${label}.target`);
    if (!source.startsWith(sourcePrefix)) {
      fail(`${label}.source must be under the descriptor keg`);
    }
    const targetRoot = target.split("/", 1)[0]!;
    if (!LINK_DESTINATION_ROOTS.has(targetRoot)) {
      fail(`${label}.target must be in a canonical Homebrew prefix directory`);
    }
    if (sources.has(source) || targets.has(target)) {
      fail(`${label} duplicates a link source or target`);
    }
    sources.add(source);
    targets.add(target);
    const mode = entry.mode === undefined ? undefined : stringValue(entry.mode, `${label}.mode`);
    if (mode !== undefined && !/^[0-7]{4}$/.test(mode)) fail(`${label}.mode is invalid`);
    return mode === undefined ? { type, source, target } : { type, source, target, mode };
  });
}

function pathEntries(value: unknown): string[] {
  const entries = stringArray(value, "Homebrew bottle descriptor.pathPrepend");
  for (const entry of entries) {
    if (entry !== "bin" && entry !== "sbin") {
      fail("Homebrew bottle descriptor.pathPrepend must use canonical Homebrew command paths");
    }
  }
  unique(entries, "Homebrew bottle descriptor.pathPrepend");
  return entries;
}

function supportOutputEntries(value: unknown): HomebrewBottleSupportOutput[] {
  if (!Array.isArray(value)) fail("Homebrew bottle descriptor.supportOutputs must be an array");
  const names = new Set<string>();
  const paths = new Set<string>();
  return value.map((item, index) => {
    const label = `Homebrew bottle descriptor.supportOutputs[${index}]`;
    const output = exactRecord(item, SUPPORT_OUTPUT_KEYS, label);
    const name = packageName(output.name, `${label}.name`);
    const kegRelativePath = relativePath(output.kegRelativePath, `${label}.kegRelativePath`);
    if (names.has(name) || paths.has(kegRelativePath)) fail(`${label} duplicates a support output`);
    names.add(name);
    paths.add(kegRelativePath);
    return {
      name,
      kegRelativePath,
      sha256: digest(output.sha256, `${label}.sha256`),
      bytes: positiveInteger(output.bytes, `${label}.bytes`),
    };
  });
}

function dependencyEntries(value: unknown): HomebrewBottleDependencyIdentity[] {
  if (!Array.isArray(value)) fail("Homebrew bottle descriptor.dependencies must be an array");
  const fullNames = new Set<string>();
  return value.map((item, index) => {
    const label = `Homebrew bottle descriptor.dependencies[${index}]`;
    const dependency = exactRecord(item, DEPENDENCY_KEYS, label);
    const fullName = fullPackageName(dependency.fullName, undefined, `${label}.fullName`);
    if (fullNames.has(fullName)) fail(`${label} duplicates dependency ${fullName}`);
    fullNames.add(fullName);
    return {
      fullName,
      version: versionString(dependency.version, `${label}.version`),
      revision: nonnegativeInteger(dependency.revision, `${label}.revision`),
      bottleRebuild: nonnegativeInteger(dependency.bottleRebuild, `${label}.bottleRebuild`),
      bottleSha256: digest(dependency.bottleSha256, `${label}.bottleSha256`),
    };
  });
}

function validateMaterialization(
  fullName: string,
  materialization: HomebrewBottleDescriptor["materialization"],
  supportOutputs: HomebrewBottleSupportOutput[],
): void {
  if (fullName === BOOTSTRAP_FULL_NAME) {
    if (materialization !== "homebrew-runtime-support-v1") {
      fail("Homebrew bootstrap descriptors must use runtime support materialization");
    }
    if (
      supportOutputs.length !== BOOTSTRAP_OUTPUTS.length ||
      !supportOutputs.every((output, index) =>
        output.name === BOOTSTRAP_OUTPUTS[index]![0] &&
        output.kegRelativePath === BOOTSTRAP_OUTPUTS[index]![1]
      )
    ) {
      fail("Homebrew bootstrap descriptors must declare the exact support outputs");
    }
    return;
  }
  if (materialization === "keg") {
    if (supportOutputs.length !== 0) fail("ordinary keg descriptors cannot declare support outputs");
    return;
  }
  fail("Homebrew runtime support is reserved for the Homebrew bootstrap descriptor");
}

function publicBottleUrl(value: unknown, sha256: string): string {
  const text = stringValue(value, "Homebrew bottle descriptor.url");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail("Homebrew bottle descriptor.url is invalid");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.search || url.hash || url.toString() !== text
  ) fail("Homebrew bottle descriptor.url must be a closed public HTTPS URL");

  if (
    url.hostname === "ghcr.io" &&
    new RegExp(`^/v2/[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)+/blobs/sha256:${sha256}$`).test(url.pathname)
  ) return text;
  if (
    url.hostname === "github.com" &&
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9_.+\-]+$/.test(url.pathname)
  ) return text;
  fail("Homebrew bottle descriptor.url must be a public GHCR digest or GitHub release asset URL");
}

function bottleArch(value: unknown, label: string): HomebrewBottleArch {
  if (value === "wasm32" || value === "wasm64") return value;
  fail(`${label} must be wasm32 or wasm64`);
}

function fullPackageName(value: unknown, expectedName: string | undefined, label: string): string {
  const fullName = stringValue(value, label);
  const match = FULL_NAME_RE.exec(fullName);
  if (!match || (expectedName !== undefined && match[3] !== expectedName)) {
    fail(`${label} must be a canonical Homebrew full package name`);
  }
  return fullName;
}

function packageName(value: unknown, label: string): string {
  const name = stringValue(value, label);
  if (!NAME_RE.test(name)) fail(`${label} is invalid`);
  return name;
}

function versionString(value: unknown, label: string): string {
  const version = stringValue(value, label);
  if (!VERSION_RE.test(version)) fail(`${label} is invalid`);
  return version;
}

function relativePath(value: unknown, label: string): string {
  const path = stringValue(value, label);
  if (!RELATIVE_PATH_RE.test(path)) fail(`${label} must be a safe relative path`);
  return path;
}

function canonicalCellarRelativePath(): string {
  const { prefix, cellar } = KANDELO_HOMEBREW_GUEST_LAYOUT;
  const prefixWithSeparator = `${prefix}/`;
  if (!cellar.startsWith(prefixWithSeparator)) {
    fail("canonical Homebrew cellar must be under the canonical prefix");
  }
  return relativePath(
    cellar.slice(prefixWithSeparator.length),
    "canonical Homebrew cellar relative path",
  );
}

function digest(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!SHA256_RE.test(result)) fail(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const strings = value.map((item, index) => stringValue(item, `${label}[${index}]`));
  unique(strings, label);
  return strings;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const output = record(value, label);
  if (!sameSet(Object.keys(output), keys)) fail(`${label} has unknown or missing fields`);
  return output;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`);
  try {
    assertHomebrewCanonicalText(value);
  } catch {
    fail(`${label} must contain Unicode scalar values`);
  }
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
}

function sameSet(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && values.every((value) => expected.includes(value));
}

function expectEqual(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail(`Homebrew bottle descriptor.${label} must be ${JSON.stringify(expected)}`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "string") {
    assertHomebrewCanonicalText(value);
    return value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareHomebrewCanonicalText(left, right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function fail(message: string): never {
  throw new HomebrewBottleDescriptorError(message);
}
