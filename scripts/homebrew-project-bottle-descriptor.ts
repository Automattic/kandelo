#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import {
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeHomebrewBottleDescriptor,
  projectHomebrewBottleDescriptor,
  type HomebrewBottleDescriptor,
  type HomebrewBottleDependencyIdentity,
} from "../host/src/homebrew-bottle-descriptor";
import { KANDELO_HOMEBREW_GUEST_LAYOUT } from "../host/src/homebrew-guest-layout";
import { compareHomebrewCanonicalText } from "../host/src/homebrew-lazy-layer-descriptor";
import type { HomebrewBottleArch, HomebrewLinkEntry } from "../host/src/homebrew-bottle-types";
import { parseTarGzip, type TarEntry } from "../host/src/vfs/tar";

const BOOTSTRAP_FULL_NAME = "kandelo-dev/tap-core/homebrew-bootstrap";
const BOOTSTRAP_OUTPUTS = [
  ["homebrew-bootstrap", "libexec/homebrew-bootstrap.zip"],
  ["homebrew-brew", "libexec/homebrew-brew.env"],
] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const FULL_NAME_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const SAFE_RELATIVE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-,:\[\]]*(?:\/[A-Za-z0-9][A-Za-z0-9._+\-,:\[\]]*)*$/;
const CELLAR_RELATIVE_PATH = canonicalCellarRelativePath();

export interface ProjectVerifiedHomebrewBottleOptions {
  sidecarsInput: unknown;
  packageEntry: unknown;
  arch: HomebrewBottleArch;
  bottle: Uint8Array;
  publicUrl: string;
  dependencyDescriptors: readonly unknown[];
}

/**
 * Projects one already-verified Homebrew publisher package and its bottle into
 * the provenance-free Task 1 descriptor. Archive bytes and receipt content are
 * independently rechecked here; publisher provenance is deliberately ignored.
 */
export function projectVerifiedHomebrewBottle(
  options: ProjectVerifiedHomebrewBottleOptions,
): HomebrewBottleDescriptor {
  const sidecarsInput = record(options.sidecarsInput, "sidecars input");
  const pkg = record(options.packageEntry, "sidecar package");
  const abi = positiveInteger(sidecarsInput.kandelo_abi, "sidecars input.kandelo_abi");
  const name = packageName(pkg.name, "sidecar package.name");
  const fullName = fullNameValue(pkg.full_name, name, "sidecar package.full_name");
  const version = nonemptyString(pkg.version, "sidecar package.version");
  const revision = nonnegativeInteger(pkg.formula_revision, "sidecar package.formula_revision");
  const bottleRebuild = nonnegativeInteger(pkg.bottle_rebuild, "sidecar package.bottle_rebuild");
  const selectedBottle = selectBottle(pkg.bottles, options.arch);
  const payloadRoot = `${name}/${version}`;

  requireEqual(selectedBottle.bottle_tag, `${options.arch}_kandelo`, "sidecar bottle.bottle_tag");
  requireEqual(selectedBottle.payload_root, payloadRoot, "sidecar bottle.payload_root");
  requireEqual(selectedBottle.prefix, KANDELO_HOMEBREW_GUEST_LAYOUT.prefix, "sidecar bottle.prefix");
  requireEqual(selectedBottle.cellar, KANDELO_HOMEBREW_GUEST_LAYOUT.cellar, "sidecar bottle.cellar");
  requireEqual(selectedBottle.keg, `${KANDELO_HOMEBREW_GUEST_LAYOUT.cellar}/${payloadRoot}`, "sidecar bottle.keg");

  const bottleSha256 = sha256(options.bottle);
  if (bottleSha256 !== digest(selectedBottle.cache_key_sha, "sidecar bottle.cache_key_sha")) {
    fail("bottle SHA-256 does not match sidecar cache_key_sha");
  }
  const entries = parseTarGzip(options.bottle, { label: `${fullName} bottle` });
  const memberMap = bottleMembers(entries, payloadRoot);
  const receipt = requiredFile(memberMap, `${payloadRoot}/INSTALL_RECEIPT.json`, "INSTALL_RECEIPT.json");
  requiredFile(memberMap, `${payloadRoot}/.brew/${name}.rb`, ".brew receipt");
  validateSidecarReceipts(selectedBottle.receipts, name);

  const sidecarDependencies = directSidecarDependencies(pkg.dependencies);
  const receiptDependencies = directReceiptDependencies(receipt);
  if (!sameIdentitySet(sidecarDependencies, receiptDependencies)) {
    fail("sidecar dependencies disagree with receipt direct runtime_dependencies");
  }
  const dependencies = dependencyIdentities(
    sidecarDependencies,
    receiptDependencies,
    options.dependencyDescriptors,
    options.arch,
    abi,
  );

  const bootstrap = fullName === BOOTSTRAP_FULL_NAME;
  const supportOutputs = bootstrap
    ? BOOTSTRAP_OUTPUTS.map(([outputName, kegRelativePath]) => {
      const data = requiredFile(memberMap, `${payloadRoot}/${kegRelativePath}`, `support output ${outputName}`);
      return {
        name: outputName,
        kegRelativePath,
        sha256: sha256(data),
        bytes: data.byteLength,
      };
    })
    : [];
  const descriptor = {
    schema: 1 as const,
    name,
    fullName,
    version,
    revision,
    bottleRebuild,
    arch: options.arch,
    kandeloAbi: abi,
    bottleTag: `${options.arch}_kandelo`,
    layout: "kandelo-homebrew-v1" as const,
    materialization: bootstrap
      ? "homebrew-runtime-support-v1" as const
      : "keg" as const,
    prefix: KANDELO_HOMEBREW_GUEST_LAYOUT.prefix,
    cellar: KANDELO_HOMEBREW_GUEST_LAYOUT.cellar,
    keg: `${KANDELO_HOMEBREW_GUEST_LAYOUT.cellar}/${payloadRoot}`,
    payloadRoot,
    receipts: [
      `${CELLAR_RELATIVE_PATH}/${payloadRoot}/.brew/${name}.rb`,
      `${CELLAR_RELATIVE_PATH}/${payloadRoot}/INSTALL_RECEIPT.json`,
    ],
    links: bootstrap ? [] : sidecarLinks(selectedBottle.links, payloadRoot),
    pathPrepend: bootstrap ? [] : pathPrepend(selectedBottle.env),
    supportOutputs,
    dependencies: bootstrap ? noDependencies(dependencies) : dependencies,
    url: options.publicUrl,
    sha256: bottleSha256,
    bytes: options.bottle.byteLength,
    compression: "gzip" as const,
  };
  return projectHomebrewBottleDescriptor(descriptor);
}

export async function runHomebrewBottleDescriptorProjector(args: string[]): Promise<void> {
  const options = parseArgs(args);
  requireAbsent(options.out, "descriptor output");
  const sidecarsInput = parseJson(readRegularFile(options.sidecarsInput, "sidecars input"), "sidecars input");
  const pkg = selectPackage(sidecarsInput, options.formula);
  const descriptors = options.dependencyDescriptors.map(readCanonicalDependencyDescriptor);
  const descriptor = projectVerifiedHomebrewBottle({
    sidecarsInput,
    packageEntry: pkg,
    arch: options.arch,
    bottle: readRegularFile(options.bottle, "bottle"),
    publicUrl: options.publicUrl,
    dependencyDescriptors: descriptors,
  });
  writeAtomically(options.out, encodeHomebrewBottleDescriptor(descriptor));
}

interface CliOptions {
  sidecarsInput: string;
  formula: string;
  arch: HomebrewBottleArch;
  bottle: string;
  publicUrl: string;
  dependencyDescriptors: string[];
  out: string;
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const dependencyDescriptors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--dependency-descriptor") {
      if (!value || value.startsWith("--")) usage();
      dependencyDescriptors.push(value);
      index += 1;
      continue;
    }
    if (
      (flag !== "--sidecars-input" && flag !== "--formula" && flag !== "--arch" &&
        flag !== "--bottle" && flag !== "--public-url" && flag !== "--out") ||
      !value || value.startsWith("--") || values.has(flag)
    ) usage();
    values.set(flag, value);
    index += 1;
  }
  const sidecarsInput = values.get("--sidecars-input");
  const formula = values.get("--formula");
  const arch = values.get("--arch");
  const bottle = values.get("--bottle");
  const publicUrl = values.get("--public-url");
  const out = values.get("--out");
  if (!sidecarsInput || !formula || !bottle || !publicUrl || !out || (arch !== "wasm32" && arch !== "wasm64")) usage();
  return { sidecarsInput, formula, arch, bottle, publicUrl, dependencyDescriptors, out };
}

function selectPackage(sidecarsInput: unknown, formula: string): Record<string, unknown> {
  const input = record(sidecarsInput, "sidecars input");
  const packages = array(input.packages, "sidecars input.packages").map((entry) => record(entry, "sidecars input package"));
  const matches = packages.filter((pkg) => pkg.name === formula);
  if (matches.length !== 1) fail(`sidecars input must contain exactly one package named ${formula}`);
  return matches[0]!;
}

function selectBottle(value: unknown, arch: HomebrewBottleArch): Record<string, unknown> {
  const bottles = array(value, "sidecar package.bottles").map((entry) => record(entry, "sidecar bottle"));
  const matches = bottles.filter((bottle) => bottle.arch === arch);
  if (matches.length !== 1) fail(`sidecar package must contain exactly one ${arch} bottle`);
  return matches[0]!;
}

function bottleMembers(entries: readonly TarEntry[], payloadRoot: string): Map<string, TarEntry> {
  const members = new Map<string, TarEntry>();
  const rootPrefix = `${payloadRoot}/`;
  for (const entry of entries) {
    if (entry.path !== payloadRoot && !entry.path.startsWith(rootPrefix)) {
      fail(`bottle contains member outside canonical payload root: ${entry.path}`);
    }
    if (members.has(entry.path)) fail(`bottle contains duplicate member: ${entry.path}`);
    members.set(entry.path, entry);
  }
  if (!members.has(payloadRoot) && !members.has(rootPrefix.slice(0, -1))) {
    // parseTarGzip normalizes a directory's trailing slash, while archives may
    // omit an explicit root directory. Requiring actual member paths below the
    // root is the meaningful canonical-root invariant.
    if (members.size === 0) fail("bottle has no canonical payload members");
  }
  return members;
}

function requiredFile(members: Map<string, TarEntry>, path: string, label: string): Uint8Array {
  const member = members.get(path);
  if (!member || member.type !== "file") fail(`bottle is missing regular ${label}: ${path}`);
  return member.data;
}

function validateSidecarReceipts(value: unknown, name: string): void {
  const receipts = array(value, "sidecar bottle.receipts");
  const expected = [`.brew/${name}.rb`, "INSTALL_RECEIPT.json"];
  if (!sameStringSet(receipts, expected)) fail("sidecar bottle receipts are not canonical");
}

interface DependencyMetadata {
  fullName: string;
  version: string;
  revision?: number;
}

function directSidecarDependencies(value: unknown): DependencyMetadata[] {
  const dependencies = array(value, "sidecar package.dependencies").map((entry) => record(entry, "sidecar dependency"));
  const out = dependencies.map((dependency) => ({
    fullName: fullNameValue(dependency.full_name, undefined, "sidecar dependency.full_name"),
    version: nonemptyString(dependency.version, "sidecar dependency.version"),
  }));
  ensureUniqueNames(out, "sidecar dependencies");
  return out;
}

function directReceiptDependencies(bytes: Uint8Array): DependencyMetadata[] {
  const receipt = parseJson(bytes, "INSTALL_RECEIPT.json");
  const dependencies = array(record(receipt, "INSTALL_RECEIPT.json").runtime_dependencies, "INSTALL_RECEIPT.json.runtime_dependencies")
    .map((entry) => record(entry, "INSTALL_RECEIPT runtime dependency"))
    .filter((dependency) => dependency.declared_directly === true)
    .map((dependency) => ({
      fullName: fullNameValue(dependency.full_name, undefined, "INSTALL_RECEIPT runtime dependency.full_name"),
      version: nonemptyString(dependency.pkg_version, "INSTALL_RECEIPT runtime dependency.pkg_version"),
      revision: nonnegativeInteger(dependency.revision, "INSTALL_RECEIPT runtime dependency.revision"),
    }));
  ensureUniqueNames(dependencies, "INSTALL_RECEIPT direct runtime_dependencies");
  return dependencies;
}

function dependencyIdentities(
  sidecarDependencies: readonly DependencyMetadata[],
  receiptDependencies: readonly DependencyMetadata[],
  values: readonly unknown[],
  arch: HomebrewBottleArch,
  abi: number,
): HomebrewBottleDependencyIdentity[] {
  const descriptors = values.map((value) => projectHomebrewBottleDescriptor(value));
  const byName = new Map<string, HomebrewBottleDescriptor>();
  for (const descriptor of descriptors) {
    if (byName.has(descriptor.fullName)) fail(`duplicate dependency descriptor: ${descriptor.fullName}`);
    if (descriptor.arch !== arch || descriptor.kandeloAbi !== abi) {
      fail(`dependency descriptor has incompatible arch or ABI: ${descriptor.fullName}`);
    }
    byName.set(descriptor.fullName, descriptor);
  }
  const receiptByName = new Map(receiptDependencies.map((dependency) => [dependency.fullName, dependency]));
  for (const sidecar of sidecarDependencies) {
    const receipt = receiptByName.get(sidecar.fullName);
    if (!receipt || receipt.version !== sidecar.version) {
      fail("sidecar dependencies disagree with receipt direct runtime_dependencies");
    }
    const descriptor = byName.get(sidecar.fullName);
    if (!descriptor) fail(`missing dependency descriptor: ${sidecar.fullName}`);
    if (
      descriptor.version !== sidecar.version || descriptor.revision !== receipt.revision
    ) {
      fail(`dependency descriptor disagrees with sidecar or receipt: ${sidecar.fullName}`);
    }
  }
  for (const name of byName.keys()) {
    if (!receiptByName.has(name)) fail(`unused dependency descriptor: ${name}`);
  }
  return [...byName.values()]
    .sort((left, right) => compareHomebrewCanonicalText(left.fullName, right.fullName))
    .map(({ fullName, version, revision, bottleRebuild, sha256 }) => ({
      fullName, version, revision, bottleRebuild, bottleSha256: sha256,
    }));
}

function sameIdentitySet(left: readonly DependencyMetadata[], right: readonly DependencyMetadata[]): boolean {
  return left.length === right.length && left.every((entry) =>
    right.some((candidate) => candidate.fullName === entry.fullName && candidate.version === entry.version),
  );
}

function noDependencies(dependencies: readonly HomebrewBottleDependencyIdentity[]): HomebrewBottleDependencyIdentity[] {
  if (dependencies.length !== 0) fail("Homebrew bootstrap cannot have dependencies");
  return [];
}

function sidecarLinks(value: unknown, payloadRoot: string): HomebrewLinkEntry[] {
  return array(value, "sidecar bottle.links").map((item) => {
    const link = record(item, "sidecar bottle link");
    const type = link.type;
    if (type !== "symlink" && type !== "directory" && type !== "file") fail("sidecar bottle link.type is invalid");
    const source = safeRelativePath(link.source, "sidecar bottle link.source");
    const target = safeRelativePath(link.target, "sidecar bottle link.target");
    const mode = link.mode === undefined ? undefined : nonemptyString(link.mode, "sidecar bottle link.mode");
    return mode === undefined
      ? { type, source: `${CELLAR_RELATIVE_PATH}/${payloadRoot}/${source}`, target }
      : { type, source: `${CELLAR_RELATIVE_PATH}/${payloadRoot}/${source}`, target, mode };
  });
}

function pathPrepend(value: unknown): string[] {
  const env = record(value, "sidecar bottle.env");
  const paths = env.PATH_prepend === undefined ? [] : array(env.PATH_prepend, "sidecar bottle.env.PATH_prepend");
  return paths.map((path) => nonemptyString(path, "sidecar bottle.env.PATH_prepend entry"));
}

function readRegularFile(path: string, label: string): Uint8Array {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return new Uint8Array(readFileSync(absolute));
}

function requireAbsent(path: string, label: string): void {
  try {
    lstatSync(resolve(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fail(`${label} already exists: ${resolve(path)}`);
}

function writeAtomically(path: string, bytes: Uint8Array): void {
  const output = resolve(path);
  const parent = dirname(output);
  mkdirSync(parent, { recursive: true });
  const staging = `${output}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let staged = false;
  try {
    writeFileSync(staging, bytes, { flag: "wx", mode: 0o644 });
    staged = true;
    // link(2) adds an output name only if it does not exist, avoiding the
    // overwrite window between the earlier absent check and publication.
    linkSync(staging, output);
  } finally {
    if (staged) unlinkSync(staging);
  }
}

function readCanonicalDependencyDescriptor(path: string): HomebrewBottleDescriptor {
  const bytes = readRegularFile(path, "dependency descriptor");
  const descriptor = projectHomebrewBottleDescriptor(parseJson(bytes, "dependency descriptor"));
  const canonical = encodeHomebrewBottleDescriptor(descriptor);
  if (bytes.byteLength !== canonical.byteLength || !bytes.every((value, index) => value === canonical[index])) {
    fail("dependency descriptor is not canonical Task 1 JSON");
  }
  return descriptor;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}

function packageName(value: unknown, label: string): string {
  const name = nonemptyString(value, label);
  if (!PACKAGE_NAME_RE.test(name)) fail(`${label} is invalid`);
  return name;
}

function fullNameValue(value: unknown, expectedName: string | undefined, label: string): string {
  const fullName = nonemptyString(value, label);
  if (!FULL_NAME_RE.test(fullName) || (expectedName !== undefined && !fullName.endsWith(`/${expectedName}`))) {
    fail(`${label} is invalid`);
  }
  return fullName;
}

function safeRelativePath(value: unknown, label: string): string {
  const path = nonemptyString(value, label);
  if (!SAFE_RELATIVE_PATH_RE.test(path)) fail(`${label} must be a safe relative path`);
  return path;
}

function canonicalCellarRelativePath(): string {
  const prefix = `${KANDELO_HOMEBREW_GUEST_LAYOUT.prefix}/`;
  if (!KANDELO_HOMEBREW_GUEST_LAYOUT.cellar.startsWith(prefix)) {
    fail("canonical Homebrew cellar must be under the canonical prefix");
  }
  return safeRelativePath(
    KANDELO_HOMEBREW_GUEST_LAYOUT.cellar.slice(prefix.length),
    "canonical Homebrew cellar relative path",
  );
}

function digest(value: unknown, label: string): string {
  const result = nonemptyString(value, label);
  if (!SHA256_RE.test(result)) fail(`${label} must be a lower-case SHA-256 digest`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(`${label} must be a positive safe integer`);
  return value as number;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a nonnegative safe integer`);
  return value as number;
}

function ensureUniqueNames(values: readonly DependencyMetadata[], label: string): void {
  if (new Set(values.map((value) => value.fullName)).size !== values.length) fail(`${label} contain duplicates`);
}

function sameStringSet(value: unknown[], expected: readonly string[]): boolean {
  return value.length === expected.length && value.every((item) => typeof item === "string" && expected.includes(item));
}

function requireEqual(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail(`${label} must be ${JSON.stringify(expected)}`);
}

function usage(): never {
  throw new Error(
    "usage: scripts/homebrew-project-bottle-descriptor.ts " +
    "--sidecars-input <json> --formula <name> --arch <wasm32|wasm64> " +
    "--bottle <tar.gz> --public-url <https-url> " +
    "[--dependency-descriptor <descriptor.json> ...] --out <descriptor.json>",
  );
}

function fail(message: string): never {
  throw new Error(`homebrew-project-bottle-descriptor: ${message}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHomebrewBottleDescriptorProjector(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
