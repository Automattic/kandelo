import { ABI_VERSION } from "./generated/abi";

export type HomebrewBottleArch = "wasm32" | "wasm64";
export type HomebrewRuntime = "node" | "browser";
export type HomebrewBottleStatus = "success" | "failed" | "pending" | "building";
export type HomebrewBottleSourceStatus = "success" | "fallback";

export interface HomebrewDependency {
  name: string;
  full_name?: string;
  version?: string;
}

export interface HomebrewMetadataBottle {
  arch: HomebrewBottleArch;
  bottle_tag: string;
  kandelo_abi: number;
  cellar: string;
  prefix: string;
  runtime_support: HomebrewRuntime[];
  browser_compatible: boolean;
  fork_instrumentation: string;
  status: HomebrewBottleStatus;
  built_by: string;
  built_at?: string;
  url?: string;
  sha256?: string;
  bytes?: number;
  cache_key_sha?: string;
  link_manifest?: string;
  error?: string;
  last_attempt?: string;
  last_attempt_by?: string;
  queued_at?: string;
  fallback_url?: string;
  fallback_sha256?: string;
  fallback_bytes?: number;
  fallback_cache_key_sha?: string;
  fallback_link_manifest?: string;
  fallback_built_at?: string;
  built_from?: unknown;
}

export interface HomebrewMetadataPackage {
  name: string;
  full_name: string;
  version: string;
  formula_revision: number;
  bottle_rebuild: number;
  formula_path: string;
  formula_metadata: string;
  dependencies: HomebrewDependency[];
  bottles: HomebrewMetadataBottle[];
}

export interface HomebrewTapMetadata {
  schema: 1;
  tap_repository: string;
  tap_name: string;
  tap_commit: string;
  kandelo_repository: string;
  kandelo_commit: string;
  kandelo_abi: number;
  release_tag: string;
  generated_at: string;
  generator: string;
  packages: HomebrewMetadataPackage[];
}

export interface HomebrewLinkEntry {
  type: "symlink" | "directory" | "file";
  source: string;
  target: string;
  mode?: string;
}

export interface HomebrewLinkManifest {
  schema: 1;
  package: string;
  version: string;
  arch: HomebrewBottleArch;
  kandelo_abi: number;
  prefix: string;
  cellar: string;
  keg: string;
  bottle: {
    url: string;
    sha256: string;
    bytes: number;
    cache_key_sha: string;
    payload_root: string;
  };
  links: HomebrewLinkEntry[];
  receipts: string[];
  env: {
    PATH_prepend?: string[];
  };
}

export interface HomebrewVfsPlanOptions {
  packages: string[];
  arch: HomebrewBottleArch;
  expectedAbi?: number;
  expectedTapName?: string;
  runtime?: HomebrewRuntime;
  expectedCacheKeys?: Record<string, string>;
  allowFallback?: boolean;
  loadLinkManifest: (tapRelativePath: string) => unknown | Promise<unknown>;
}

export interface HomebrewVfsTapIdentity {
  tapRepository: string;
  tapName: string;
  tapCommit: string;
  kandeloRepository: string;
  kandeloCommit: string;
  kandeloAbi: number;
  releaseTag: string;
}

export interface HomebrewFederatedVfsPlanOptions {
  packages: string[];
  rootTapName: string;
  arch: HomebrewBottleArch;
  expectedAbi?: number;
  runtime?: HomebrewRuntime;
  expectedCacheKeys?: Record<string, string>;
  allowFallback?: boolean;
  loadLinkManifest: (
    tap: HomebrewVfsTapIdentity,
    tapRelativePath: string,
  ) => unknown | Promise<unknown>;
}

export interface HomebrewVfsPackagePlan {
  name: string;
  fullName: string;
  tapRepository: string;
  tapName: string;
  tapCommit: string;
  kandeloRepository: string;
  kandeloCommit: string;
  version: string;
  formulaRevision: number;
  bottleRebuild: number;
  arch: HomebrewBottleArch;
  kandeloAbi: number;
  metadataStatus: HomebrewBottleStatus;
  sourceStatus: HomebrewBottleSourceStatus;
  url: string;
  sha256: string;
  bytes: number;
  cacheKeySha: string;
  builtAt?: string;
  prefix: string;
  cellar: string;
  keg: string;
  payloadRoot: string;
  linkManifestPath: string;
  linkManifest: HomebrewLinkManifest;
  dependencies: HomebrewDependency[];
  runtimeSupport: HomebrewRuntime[];
  browserCompatible: boolean;
}

export interface HomebrewVfsPlan {
  schema: 1;
  tapRepository: string;
  tapName: string;
  tapCommit: string;
  kandeloRepository: string;
  kandeloCommit: string;
  kandeloAbi: number;
  releaseTag: string;
  requestedPackages: string[];
  packages: HomebrewVfsPackagePlan[];
}

export interface HomebrewFederatedVfsPlan extends HomebrewVfsPlan {
  requestedFullNames: string[];
  taps: HomebrewVfsTapIdentity[];
}

export class HomebrewVfsPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewVfsPlanError";
  }
}

interface SelectedBottle {
  metadataStatus: HomebrewBottleStatus;
  sourceStatus: HomebrewBottleSourceStatus;
  url: string;
  sha256: string;
  bytes: number;
  cacheKeySha: string;
  linkManifestPath: string;
  builtAt?: string;
}

interface FederatedPackageSource {
  metadata: HomebrewTapMetadata;
  pkg: HomebrewMetadataPackage;
}

interface PlanPackageOptions {
  arch: HomebrewBottleArch;
  expectedAbi: number;
  runtime?: HomebrewRuntime;
  expectedCacheKeys?: Record<string, string>;
  allowFallback?: boolean;
  dependencies?: HomebrewDependency[];
  requireRepositoryRoot?: boolean;
  loadLinkManifest: (tapRelativePath: string) => unknown | Promise<unknown>;
}

interface HomebrewBottleBuildSource {
  tapRepository: string;
  tapCommit: string;
  kandeloRepository: string;
  kandeloCommit: string;
}

const PACKAGE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const TAP_NAME_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_TAP_REL_SEGMENT_RE = /^[A-Za-z0-9._@%+=:-]+$/;
const SAFE_GUEST_REL_SEGMENT_RE = /^[A-Za-z0-9._@%+=,:\[\]-]+$/;
const MAX_PACKAGE_NAME_BYTES = 255;
const MAX_REQUESTED_PACKAGES = 128;
const MAX_RESOLVED_PACKAGES = 128;
const MAX_METADATA_PACKAGES = 4096;
const MAX_PACKAGE_DEPENDENCIES = 128;
const MAX_FEDERATED_TAPS = 16;

export async function planHomebrewVfs(
  metadataValue: unknown,
  options: HomebrewVfsPlanOptions,
): Promise<HomebrewVfsPlan> {
  const metadata = parseTapMetadata(metadataValue);
  const expectedAbi = options.expectedAbi ?? ABI_VERSION;
  validateExpectedAbi(metadata, expectedAbi);
  validateExpectedTapName(metadata, options.expectedTapName);
  const arch = validateRequestedArch(options.arch);
  const requestedPackages = validateRequestedPackages(options.packages);
  const packages = resolvePackageClosure(metadata, requestedPackages);

  const planned: HomebrewVfsPackagePlan[] = [];
  for (const pkg of packages) {
    planned.push(await planPackage(metadata, pkg, {
      ...options,
      arch,
      expectedAbi,
    }));
  }

  return {
    schema: 1,
    tapRepository: metadata.tap_repository,
    tapName: metadata.tap_name,
    tapCommit: metadata.tap_commit,
    kandeloRepository: metadata.kandelo_repository,
    kandeloCommit: metadata.kandelo_commit,
    kandeloAbi: metadata.kandelo_abi,
    releaseTag: metadata.release_tag,
    requestedPackages,
    packages: planned,
  };
}

/**
 * Plan a root Formula and its closure across an explicit set of immutable tap
 * metadata documents. Each document remains authoritative only for packages
 * whose full_name belongs to that document's canonical tap identity.
 */
export async function planFederatedHomebrewVfs(
  metadataValues: readonly unknown[],
  options: HomebrewFederatedVfsPlanOptions,
): Promise<HomebrewFederatedVfsPlan> {
  if (!Array.isArray(metadataValues) || metadataValues.length === 0) {
    fail("federated Homebrew VFS plan requires at least one tap metadata document");
  }
  if (metadataValues.length > MAX_FEDERATED_TAPS) {
    fail(`federated Homebrew VFS plan accepts at most ${MAX_FEDERATED_TAPS} tap metadata documents`);
  }
  validateCanonicalTapName(options.rootTapName, "root tap name");

  const expectedAbi = options.expectedAbi ?? ABI_VERSION;
  const metadataDocuments = metadataValues.map((value) => parseTapMetadata(value));
  const tapsByName = new Map<string, HomebrewTapMetadata>();
  const tapNamesByRepository = new Map<string, string>();
  for (const metadata of metadataDocuments) {
    validateExpectedAbi(metadata, expectedAbi);
    if (tapsByName.has(metadata.tap_name)) {
      fail(`federated metadata has duplicate tap ${quote(metadata.tap_name)}`);
    }
    const normalizedRepository = metadata.tap_repository.toLowerCase();
    const priorTapName = tapNamesByRepository.get(normalizedRepository);
    if (priorTapName !== undefined) {
      fail(
        `federated metadata repository ${quote(normalizedRepository)} is duplicated by taps ` +
        `${quote(priorTapName)} and ${quote(metadata.tap_name)}`,
      );
    }
    tapsByName.set(metadata.tap_name, metadata);
    tapNamesByRepository.set(normalizedRepository, metadata.tap_name);
  }

  const rootMetadata = tapsByName.get(options.rootTapName);
  if (rootMetadata === undefined) {
    fail(`federated metadata does not contain root tap ${quote(options.rootTapName)}`);
  }
  const arch = validateRequestedArch(options.arch);
  const requestedPackages = validateRequestedPackages(options.packages);
  const packageIndex = indexFederatedPackages(metadataDocuments);
  const requestedFullNames = requestedPackages.map(
    (name) => `${rootMetadata.tap_name}/${name}`,
  );
  const packages = resolveFederatedPackageClosure(packageIndex, requestedFullNames);
  validateUniqueCellarPackageNames(packages);

  const planned: HomebrewVfsPackagePlan[] = [];
  for (const source of packages) {
    const dependencies = source.pkg.dependencies.map((dependency) => ({
      ...dependency,
      full_name: federatedDependencyFullName(source.metadata, dependency),
    }));
    const tap = tapIdentity(source.metadata);
    planned.push(await planPackage(source.metadata, source.pkg, {
      arch,
      expectedAbi,
      runtime: options.runtime,
      expectedCacheKeys: options.expectedCacheKeys,
      allowFallback: options.allowFallback,
      dependencies,
      requireRepositoryRoot: true,
      loadLinkManifest: (path) => options.loadLinkManifest(tap, path),
    }));
  }

  return {
    schema: 1,
    tapRepository: rootMetadata.tap_repository,
    tapName: rootMetadata.tap_name,
    tapCommit: rootMetadata.tap_commit,
    kandeloRepository: rootMetadata.kandelo_repository,
    kandeloCommit: rootMetadata.kandelo_commit,
    kandeloAbi: rootMetadata.kandelo_abi,
    releaseTag: rootMetadata.release_tag,
    requestedPackages,
    requestedFullNames,
    taps: metadataDocuments.map(tapIdentity).sort((left, right) =>
      left.tapName.localeCompare(right.tapName)
    ),
    packages: planned,
  };
}

function parseTapMetadata(value: unknown): HomebrewTapMetadata {
  const metadata = requireRecord(value, "metadata");
  const schema = requiredInteger(metadata, "schema", "metadata");
  if (schema !== 1) fail(`metadata schema must be 1, got ${schema}`);

  const packageValues = requiredArray(metadata, "packages", "metadata");
  if (packageValues.length > MAX_METADATA_PACKAGES) {
    fail(`metadata packages must contain at most ${MAX_METADATA_PACKAGES} entries`);
  }
  const packages = packageValues.map((pkg, index) =>
    parseMetadataPackage(pkg, `metadata.packages[${index}]`)
  );

  const tapRepository = requiredString(metadata, "tap_repository", "metadata");
  const tapName = requiredString(metadata, "tap_name", "metadata");
  const tapCommit = requiredString(metadata, "tap_commit", "metadata");
  const kandeloRepository = requiredString(metadata, "kandelo_repository", "metadata");
  const kandeloCommit = requiredString(metadata, "kandelo_commit", "metadata");
  if (!REPOSITORY_RE.test(tapRepository)) {
    fail(`metadata.tap_repository ${quote(tapRepository)} is not a valid owner/repository`);
  }
  if (!TAP_NAME_RE.test(tapName)) {
    fail(`metadata.tap_name ${quote(tapName)} is not a canonical lowercase owner/tap name`);
  }
  validateTapIdentity(tapRepository, tapName);
  if (!GIT_SHA_RE.test(tapCommit)) fail("metadata.tap_commit must be a lowercase 40-char git sha");
  if (!REPOSITORY_RE.test(kandeloRepository)) {
    fail(`metadata.kandelo_repository ${quote(kandeloRepository)} is not a valid owner/repository`);
  }
  if (!GIT_SHA_RE.test(kandeloCommit)) {
    fail("metadata.kandelo_commit must be a lowercase 40-char git sha");
  }

  const seenPackages = new Set<string>();
  for (const pkg of packages) {
    if (seenPackages.has(pkg.name)) fail(`metadata has duplicate package ${quote(pkg.name)}`);
    seenPackages.add(pkg.name);
    const expectedFullName = `${tapName}/${pkg.name}`;
    if (pkg.full_name !== expectedFullName) {
      fail(
        `metadata package ${quote(pkg.name)} full_name ${quote(pkg.full_name)} ` +
        `does not match tap identity ${quote(expectedFullName)}`,
      );
    }
  }

  return {
    schema: 1,
    tap_repository: tapRepository,
    tap_name: tapName,
    tap_commit: tapCommit,
    kandelo_repository: kandeloRepository,
    kandelo_commit: kandeloCommit,
    kandelo_abi: requiredInteger(metadata, "kandelo_abi", "metadata"),
    release_tag: requiredString(metadata, "release_tag", "metadata"),
    generated_at: requiredString(metadata, "generated_at", "metadata"),
    generator: requiredString(metadata, "generator", "metadata"),
    packages,
  };
}

function parseMetadataPackage(value: unknown, label: string): HomebrewMetadataPackage {
  const pkg = requireRecord(value, label);
  const name = requiredString(pkg, "name", label);
  validatePackageName(name, `${label}.name`);
  const dependencyValues = requiredArray(pkg, "dependencies", label);
  if (dependencyValues.length > MAX_PACKAGE_DEPENDENCIES) {
    fail(`${label}.dependencies must contain at most ${MAX_PACKAGE_DEPENDENCIES} entries`);
  }
  const dependencies = dependencyValues.map((dep, index) =>
    parseDependency(dep, `${label}.dependencies[${index}]`)
  );
  const seenDependencies = new Set<string>();
  for (const dependency of dependencies) {
    const identity = dependency.full_name ?? dependency.name;
    if (seenDependencies.has(identity)) {
      fail(`${label}.dependencies has duplicate package ${quote(identity)}`);
    }
    seenDependencies.add(identity);
  }
  const bottles = requiredArray(pkg, "bottles", label).map((bottle, index) =>
    parseMetadataBottle(bottle, `${label}.bottles[${index}]`)
  );
  if (bottles.length === 0) fail(`${label}.bottles must contain at least one bottle`);

  return {
    name,
    full_name: requiredString(pkg, "full_name", label),
    version: requiredString(pkg, "version", label),
    formula_revision: requiredInteger(pkg, "formula_revision", label),
    bottle_rebuild: requiredInteger(pkg, "bottle_rebuild", label),
    formula_path: requiredString(pkg, "formula_path", label),
    formula_metadata: requiredString(pkg, "formula_metadata", label),
    dependencies,
    bottles,
  };
}

function parseDependency(value: unknown, label: string): HomebrewDependency {
  const dep = requireRecord(value, label);
  const name = requiredString(dep, "name", label);
  validatePackageName(name, `${label}.name`);
  const fullName = optionalString(dep, "full_name", label);
  if (fullName !== undefined) {
    const parsed = parseFullFormulaName(fullName, `${label}.full_name`);
    if (parsed.name !== name) {
      fail(
        `${label}.full_name ${quote(fullName)} does not match dependency name ${quote(name)}`,
      );
    }
  }
  const version = optionalString(dep, "version", label);
  return {
    name,
    ...(fullName === undefined ? {} : { full_name: fullName }),
    ...(version === undefined ? {} : { version }),
  };
}

function parseMetadataBottle(value: unknown, label: string): HomebrewMetadataBottle {
  const bottle = requireRecord(value, label);
  const arch = parseArch(requiredString(bottle, "arch", label), `${label}.arch`);
  const status = parseStatus(requiredString(bottle, "status", label), `${label}.status`);
  const runtimeSupport = requiredArray(bottle, "runtime_support", label).map((entry, index) =>
    parseRuntime(entry, `${label}.runtime_support[${index}]`)
  );
  const browserCompatible = requiredBoolean(bottle, "browser_compatible", label);

  return {
    arch,
    bottle_tag: requiredString(bottle, "bottle_tag", label),
    kandelo_abi: requiredInteger(bottle, "kandelo_abi", label),
    cellar: requiredString(bottle, "cellar", label),
    prefix: requiredString(bottle, "prefix", label),
    runtime_support: runtimeSupport,
    browser_compatible: browserCompatible,
    fork_instrumentation: requiredString(bottle, "fork_instrumentation", label),
    status,
    built_by: requiredString(bottle, "built_by", label),
    built_at: optionalString(bottle, "built_at", label),
    url: optionalString(bottle, "url", label),
    sha256: optionalString(bottle, "sha256", label),
    bytes: optionalInteger(bottle, "bytes", label),
    cache_key_sha: optionalString(bottle, "cache_key_sha", label),
    link_manifest: optionalString(bottle, "link_manifest", label),
    error: optionalString(bottle, "error", label),
    last_attempt: optionalString(bottle, "last_attempt", label),
    last_attempt_by: optionalString(bottle, "last_attempt_by", label),
    queued_at: optionalString(bottle, "queued_at", label),
    fallback_url: optionalString(bottle, "fallback_url", label),
    fallback_sha256: optionalString(bottle, "fallback_sha256", label),
    fallback_bytes: optionalInteger(bottle, "fallback_bytes", label),
    fallback_cache_key_sha: optionalString(bottle, "fallback_cache_key_sha", label),
    fallback_link_manifest: optionalString(bottle, "fallback_link_manifest", label),
    fallback_built_at: optionalString(bottle, "fallback_built_at", label),
    built_from: bottle.built_from,
  };
}

function parseLinkManifest(value: unknown, label: string): HomebrewLinkManifest {
  const link = requireRecord(value, label);
  const schema = requiredInteger(link, "schema", label);
  if (schema !== 1) fail(`${label}.schema must be 1, got ${schema}`);
  const bottle = requireRecord(link.bottle, `${label}.bottle`);
  const links = requiredArray(link, "links", label).map((entry, index) =>
    parseLinkEntry(entry, `${label}.links[${index}]`)
  );
  const receipts = requiredArray(link, "receipts", label).map((entry, index) =>
    requireStringValue(entry, `${label}.receipts[${index}]`)
  );
  const envRecord = requireRecord(link.env, `${label}.env`);
  const pathPrepend = optionalStringArray(envRecord, "PATH_prepend", `${label}.env`);

  return {
    schema: 1,
    package: requiredString(link, "package", label),
    version: requiredString(link, "version", label),
    arch: parseArch(requiredString(link, "arch", label), `${label}.arch`),
    kandelo_abi: requiredInteger(link, "kandelo_abi", label),
    prefix: requiredString(link, "prefix", label),
    cellar: requiredString(link, "cellar", label),
    keg: requiredString(link, "keg", label),
    bottle: {
      url: requiredString(bottle, "url", `${label}.bottle`),
      sha256: requiredString(bottle, "sha256", `${label}.bottle`),
      bytes: requiredInteger(bottle, "bytes", `${label}.bottle`),
      cache_key_sha: requiredString(bottle, "cache_key_sha", `${label}.bottle`),
      payload_root: requiredString(bottle, "payload_root", `${label}.bottle`),
    },
    links,
    receipts,
    env: pathPrepend === undefined ? {} : { PATH_prepend: pathPrepend },
  };
}

function parseLinkEntry(value: unknown, label: string): HomebrewLinkEntry {
  const entry = requireRecord(value, label);
  const type = requiredString(entry, "type", label);
  if (type !== "symlink" && type !== "directory" && type !== "file") {
    fail(`${label}.type must be symlink, directory, or file`);
  }
  const mode = optionalString(entry, "mode", label);
  return {
    type,
    source: requiredString(entry, "source", label),
    target: requiredString(entry, "target", label),
    ...(mode === undefined ? {} : { mode }),
  };
}

function validateExpectedAbi(metadata: HomebrewTapMetadata, expectedAbi: number): void {
  if (!Number.isInteger(expectedAbi) || expectedAbi < 1) {
    fail(`expected ABI must be a positive integer, got ${String(expectedAbi)}`);
  }
  const releaseAbi = parseReleaseAbi(metadata.release_tag);
  if (releaseAbi === null) {
    fail(`metadata release_tag must be bottles-abi-v<N>, got ${metadata.release_tag}`);
  }
  if (releaseAbi !== metadata.kandelo_abi) {
    fail(
      `metadata release ABI ${releaseAbi} does not match metadata kandelo_abi ${metadata.kandelo_abi}`,
    );
  }
  if (metadata.kandelo_abi !== expectedAbi) {
    fail(`metadata ABI ${metadata.kandelo_abi} does not match expected ABI ${expectedAbi}`);
  }
}

function validateExpectedTapName(
  metadata: HomebrewTapMetadata,
  expectedTapName: string | undefined,
): void {
  if (expectedTapName === undefined) return;
  if (!TAP_NAME_RE.test(expectedTapName)) {
    fail(`expected tap name ${quote(expectedTapName)} is not a canonical lowercase owner/tap name`);
  }
  if (metadata.tap_name !== expectedTapName) {
    fail(
      `metadata tap ${quote(metadata.tap_name)} does not match requested tap ${quote(expectedTapName)}`,
    );
  }
}

function validateCanonicalTapName(tapName: string, label: string): void {
  if (!TAP_NAME_RE.test(tapName)) {
    fail(`${label} ${quote(tapName)} is not a canonical lowercase owner/tap name`);
  }
}

function parseFullFormulaName(
  fullName: string,
  label: string,
): { tapName: string; name: string } {
  const parts = fullName.split("/");
  if (parts.length !== 3) {
    fail(`${label} ${quote(fullName)} must be a canonical owner/tap/formula name`);
  }
  const tapName = `${parts[0]}/${parts[1]}`;
  const name = parts[2];
  validateCanonicalTapName(tapName, `${label} tap`);
  validatePackageName(name, `${label} Formula`);
  if (fullName !== `${tapName}/${name}`) {
    fail(`${label} ${quote(fullName)} must be normalized lowercase`);
  }
  return { tapName, name };
}

function tapIdentity(metadata: HomebrewTapMetadata): HomebrewVfsTapIdentity {
  return {
    tapRepository: metadata.tap_repository,
    tapName: metadata.tap_name,
    tapCommit: metadata.tap_commit,
    kandeloRepository: metadata.kandelo_repository,
    kandeloCommit: metadata.kandelo_commit,
    kandeloAbi: metadata.kandelo_abi,
    releaseTag: metadata.release_tag,
  };
}

function validateTapIdentity(tapRepository: string, tapName: string): void {
  const normalizedRepository = tapRepository.toLowerCase();
  const [owner, repositoryName] = normalizedRepository.split("/", 2);
  const prefix = "homebrew-";
  if (!repositoryName.startsWith(prefix) || repositoryName.length === prefix.length) {
    fail(
      `metadata tap repository ${quote(tapRepository)} must use the conventional owner/homebrew-name form`,
    );
  }
  const expectedTapName = `${owner}/${repositoryName.slice(prefix.length)}`;
  if (tapName !== expectedTapName) {
    fail(
      `metadata tap ${quote(tapName)} does not match repository ${quote(tapRepository)}; ` +
      `expected ${quote(expectedTapName)}`,
    );
  }
}

function validateRequestedArch(arch: HomebrewBottleArch): HomebrewBottleArch {
  if (arch !== "wasm32" && arch !== "wasm64") {
    fail(`requested arch must be wasm32 or wasm64, got ${String(arch)}`);
  }
  return arch;
}

function validateRequestedPackages(packages: string[]): string[] {
  if (!Array.isArray(packages) || packages.length === 0) {
    fail("Homebrew VFS plan requires at least one requested package");
  }
  if (packages.length > MAX_REQUESTED_PACKAGES) {
    fail(`Homebrew VFS plan accepts at most ${MAX_REQUESTED_PACKAGES} requested packages`);
  }
  const seen = new Set<string>();
  for (const pkg of packages) {
    if (typeof pkg !== "string") fail("requested package names must be strings");
    validatePackageName(pkg, "requested package");
    if (seen.has(pkg)) fail(`requested package ${quote(pkg)} is duplicated`);
    seen.add(pkg);
  }
  return [...packages];
}

function resolvePackageClosure(
  metadata: HomebrewTapMetadata,
  requestedPackages: string[],
): HomebrewMetadataPackage[] {
  const index = new Map<string, HomebrewMetadataPackage>();
  for (const pkg of metadata.packages) {
    if (index.has(pkg.name)) fail(`metadata has duplicate package ${quote(pkg.name)}`);
    index.set(pkg.name, pkg);
  }

  const ordered: HomebrewMetadataPackage[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(name: string, requiredBy?: string): void {
    const currentState = state.get(name);
    if (currentState === "done") return;
    if (currentState === "visiting") {
      const start = stack.indexOf(name);
      const cycle = [...stack.slice(start < 0 ? 0 : start), name];
      fail(`dependency cycle: ${cycle.join(" -> ")}`);
    }

    const pkg = index.get(name);
    if (!pkg) {
      if (requiredBy) {
        fail(`package ${quote(requiredBy)} dependency ${quote(name)} is not present`);
      }
      fail(`requested package ${quote(name)} is not present in metadata`);
    }

    if (state.size >= MAX_RESOLVED_PACKAGES) {
      fail(`Homebrew VFS dependency closure exceeds ${MAX_RESOLVED_PACKAGES} packages`);
    }

    state.set(name, "visiting");
    stack.push(name);
    for (const dep of pkg.dependencies) {
      const fullName = dep.full_name ?? `${metadata.tap_name}/${dep.name}`;
      if (fullName !== `${metadata.tap_name}/${dep.name}`) {
        fail(
          `package ${quote(pkg.name)} dependency ${quote(fullName)} belongs to another tap; ` +
          "use planFederatedHomebrewVfs",
        );
      }
      const depPkg = index.get(dep.name);
      if (!depPkg) {
        fail(`package ${quote(pkg.name)} dependency ${quote(dep.name)} is not present`);
      }
      if (dep.version !== undefined && depPkg.version !== dep.version) {
        fail(
          `package ${quote(pkg.name)} dependency ${quote(dep.name)} requires version ${quote(dep.version)}, metadata has ${quote(depPkg.version)}`,
        );
      }
      visit(dep.name, pkg.name);
    }
    stack.pop();
    state.set(name, "done");
    ordered.push(pkg);
  }

  for (const name of requestedPackages) visit(name);
  return ordered;
}

function indexFederatedPackages(
  metadataDocuments: HomebrewTapMetadata[],
): Map<string, FederatedPackageSource> {
  const index = new Map<string, FederatedPackageSource>();
  for (const metadata of metadataDocuments) {
    for (const pkg of metadata.packages) {
      const prior = index.get(pkg.full_name);
      if (prior !== undefined) {
        fail(`federated metadata has duplicate package ${quote(pkg.full_name)}`);
      }
      index.set(pkg.full_name, { metadata, pkg });
    }
  }
  return index;
}

function resolveFederatedPackageClosure(
  index: Map<string, FederatedPackageSource>,
  requestedFullNames: string[],
): FederatedPackageSource[] {
  const ordered: FederatedPackageSource[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(fullName: string, requiredBy?: string): void {
    const currentState = state.get(fullName);
    if (currentState === "done") return;
    if (currentState === "visiting") {
      const start = stack.indexOf(fullName);
      const cycle = [...stack.slice(start < 0 ? 0 : start), fullName];
      fail(`federated dependency cycle: ${cycle.join(" -> ")}`);
    }

    const source = index.get(fullName);
    if (source === undefined) {
      if (requiredBy !== undefined) {
        fail(
          `package ${quote(requiredBy)} dependency ${quote(fullName)} is absent from locked tap metadata`,
        );
      }
      fail(`requested package ${quote(fullName)} is absent from root tap metadata`);
    }
    if (state.size >= MAX_RESOLVED_PACKAGES) {
      fail(`federated Homebrew VFS dependency closure exceeds ${MAX_RESOLVED_PACKAGES} packages`);
    }

    state.set(fullName, "visiting");
    stack.push(fullName);
    for (const dependency of source.pkg.dependencies) {
      const dependencyFullName = federatedDependencyFullName(source.metadata, dependency);
      const dependencySource = index.get(dependencyFullName);
      if (dependencySource === undefined) {
        fail(
          `package ${quote(fullName)} dependency ${quote(dependencyFullName)} ` +
          "is absent from locked tap metadata",
        );
      }
      if (
        dependency.version !== undefined &&
        dependencySource.pkg.version !== dependency.version
      ) {
        fail(
          `package ${quote(fullName)} dependency ${quote(dependencyFullName)} requires version ` +
          `${quote(dependency.version)}, metadata has ${quote(dependencySource.pkg.version)}`,
        );
      }
      visit(dependencyFullName, fullName);
    }
    stack.pop();
    state.set(fullName, "done");
    ordered.push(source);
  }

  for (const fullName of requestedFullNames) visit(fullName);
  return ordered;
}

function federatedDependencyFullName(
  metadata: HomebrewTapMetadata,
  dependency: HomebrewDependency,
): string {
  return dependency.full_name ?? `${metadata.tap_name}/${dependency.name}`;
}

function validateUniqueCellarPackageNames(packages: FederatedPackageSource[]): void {
  const fullNameByPackageName = new Map<string, string>();
  for (const { pkg } of packages) {
    const priorFullName = fullNameByPackageName.get(pkg.name);
    if (priorFullName !== undefined && priorFullName !== pkg.full_name) {
      fail(
        `federated dependency closure has duplicate Cellar package name ${quote(pkg.name)}: ` +
        `${quote(priorFullName)} and ${quote(pkg.full_name)}`,
      );
    }
    fullNameByPackageName.set(pkg.name, pkg.full_name);
  }
}

async function planPackage(
  metadata: HomebrewTapMetadata,
  pkg: HomebrewMetadataPackage,
  options: PlanPackageOptions,
): Promise<HomebrewVfsPackagePlan> {
  const bottle = pkg.bottles.find((candidate) => candidate.arch === options.arch);
  if (!bottle) fail(`package ${quote(pkg.name)} has no ${options.arch} bottle`);
  validateBottleIdentity(pkg, bottle, metadata.kandelo_abi, options.runtime);

  const selected = selectBottle(pkg, bottle, options.allowFallback ?? true);
  const expectedCacheKey =
    options.expectedCacheKeys?.[pkg.full_name] ?? options.expectedCacheKeys?.[pkg.name];
  if (expectedCacheKey !== undefined && selected.cacheKeySha !== expectedCacheKey) {
    fail(
      `package ${quote(pkg.name)} cache_key_sha ${quote(selected.cacheKeySha)} does not match expected ${quote(expectedCacheKey)}`,
    );
  }
  const bottleBuildSource = options.requireRepositoryRoot
    ? validateFederatedBottleSource(metadata, pkg, bottle, selected)
    : undefined;
  // A failed current attempt carries its own built_from record while the
  // selected fallback bytes belong to an older publication. Until sidecars
  // carry fallback-specific build provenance, retain the metadata-document
  // identity for fallback plans rather than misattributing the older bottle.
  const selectedBuildSource = selected.sourceStatus === "success" ? bottleBuildSource : undefined;

  validateTapRelativePath(selected.linkManifestPath, `package ${quote(pkg.name)} link_manifest`);
  const linkManifest = parseLinkManifest(
    await options.loadLinkManifest(selected.linkManifestPath),
    `link manifest ${selected.linkManifestPath}`,
  );
  validateLinkManifest(pkg, bottle, selected, linkManifest);

  return {
    name: pkg.name,
    fullName: pkg.full_name,
    tapRepository: selectedBuildSource?.tapRepository ?? metadata.tap_repository,
    tapName: metadata.tap_name,
    tapCommit: selectedBuildSource?.tapCommit ?? metadata.tap_commit,
    kandeloRepository: selectedBuildSource?.kandeloRepository ?? metadata.kandelo_repository,
    kandeloCommit: selectedBuildSource?.kandeloCommit ?? metadata.kandelo_commit,
    version: pkg.version,
    formulaRevision: pkg.formula_revision,
    bottleRebuild: pkg.bottle_rebuild,
    arch: bottle.arch,
    kandeloAbi: bottle.kandelo_abi,
    metadataStatus: selected.metadataStatus,
    sourceStatus: selected.sourceStatus,
    url: selected.url,
    sha256: selected.sha256,
    bytes: selected.bytes,
    cacheKeySha: selected.cacheKeySha,
    builtAt: selected.builtAt,
    prefix: linkManifest.prefix,
    cellar: linkManifest.cellar,
    keg: linkManifest.keg,
    payloadRoot: linkManifest.bottle.payload_root,
    linkManifestPath: selected.linkManifestPath,
    linkManifest,
    dependencies: options.dependencies ?? pkg.dependencies,
    runtimeSupport: bottle.runtime_support,
    browserCompatible: bottle.browser_compatible,
  };
}

function validateFederatedBottleSource(
  metadata: HomebrewTapMetadata,
  pkg: HomebrewMetadataPackage,
  bottle: HomebrewMetadataBottle,
  selected: SelectedBottle,
): HomebrewBottleBuildSource {
  const repository = metadata.tap_repository.toLowerCase();
  const expectedUrl =
    `https://ghcr.io/v2/${repository}/${pkg.name}/blobs/sha256:${selected.sha256}`;
  if (selected.url !== expectedUrl) {
    fail(
      `package ${quote(pkg.full_name)} bottle URL ${quote(selected.url)} ` +
      `does not match repository-rooted GHCR URL ${quote(expectedUrl)}`,
    );
  }

  const builtFrom = requireRecord(
    bottle.built_from,
    `package ${quote(pkg.full_name)} bottle built_from`,
  );
  const tapRepository = requiredString(
    builtFrom,
    "tap_repository",
    `package ${quote(pkg.full_name)} bottle built_from`,
  );
  const kandeloRepository = requiredString(
    builtFrom,
    "kandelo_repository",
    `package ${quote(pkg.full_name)} bottle built_from`,
  );
  if (tapRepository.toLowerCase() !== repository) {
    fail(`package ${quote(pkg.full_name)} bottle built_from tap repository does not match metadata`);
  }
  const tapCommit = requiredString(
    builtFrom,
    "tap_commit",
    `package ${quote(pkg.full_name)} bottle built_from`,
  );
  if (!GIT_SHA_RE.test(tapCommit)) {
    fail(`package ${quote(pkg.full_name)} bottle built_from tap commit must be a lowercase 40-char git sha`);
  }
  if (kandeloRepository.toLowerCase() !== metadata.kandelo_repository.toLowerCase()) {
    fail(
      `package ${quote(pkg.full_name)} bottle built_from Kandelo repository does not match metadata`,
    );
  }
  const kandeloCommit = requiredString(
    builtFrom,
    "kandelo_commit",
    `package ${quote(pkg.full_name)} bottle built_from`,
  );
  if (!GIT_SHA_RE.test(kandeloCommit)) {
    fail(`package ${quote(pkg.full_name)} bottle built_from Kandelo commit must be a lowercase 40-char git sha`);
  }
  validateSha256(
    requiredString(
      builtFrom,
      "formula_sha256",
      `package ${quote(pkg.full_name)} bottle built_from`,
    ),
    `package ${quote(pkg.full_name)} bottle built_from formula_sha256`,
  );
  return {
    tapRepository: metadata.tap_repository,
    tapCommit,
    kandeloRepository: metadata.kandelo_repository,
    kandeloCommit,
  };
}

function validateBottleIdentity(
  pkg: HomebrewMetadataPackage,
  bottle: HomebrewMetadataBottle,
  abi: number,
  runtime?: HomebrewRuntime,
): void {
  if (bottle.kandelo_abi !== abi) {
    fail(
      `package ${quote(pkg.name)} bottle ${bottle.arch} ABI ${bottle.kandelo_abi} does not match metadata ABI ${abi}`,
    );
  }
  const expectedTag = bottle.arch === "wasm32" ? "wasm32_kandelo" : "wasm64_kandelo";
  if (bottle.bottle_tag !== expectedTag) {
    fail(
      `package ${quote(pkg.name)} bottle ${bottle.arch} has bottle_tag ${quote(bottle.bottle_tag)}, expected ${quote(expectedTag)}`,
    );
  }
  if (runtime !== undefined && !bottle.runtime_support.includes(runtime)) {
    fail(`package ${quote(pkg.name)} bottle ${bottle.arch} does not support ${runtime}`);
  }
  if (runtime === "browser" && !bottle.browser_compatible) {
    fail(`package ${quote(pkg.name)} bottle ${bottle.arch} is not browser compatible`);
  }
}

function selectBottle(
  pkg: HomebrewMetadataPackage,
  bottle: HomebrewMetadataBottle,
  allowFallback: boolean,
): SelectedBottle {
  if (bottle.status === "success") {
    return {
      metadataStatus: bottle.status,
      sourceStatus: "success",
      url: requireBottleString(pkg, bottle, "url", bottle.url),
      sha256: validateSha256(requireBottleString(pkg, bottle, "sha256", bottle.sha256), `${pkg.name}.sha256`),
      bytes: requireBottleInteger(pkg, bottle, "bytes", bottle.bytes),
      cacheKeySha: validateSha256(
        requireBottleString(pkg, bottle, "cache_key_sha", bottle.cache_key_sha),
        `${pkg.name}.cache_key_sha`,
      ),
      linkManifestPath: requireBottleString(pkg, bottle, "link_manifest", bottle.link_manifest),
      builtAt: bottle.built_at,
    };
  }

  if (!allowFallback) {
    fail(`package ${quote(pkg.name)} bottle ${bottle.arch} status ${bottle.status} is not success`);
  }

  const missing = [
    ["fallback_url", bottle.fallback_url],
    ["fallback_sha256", bottle.fallback_sha256],
    ["fallback_bytes", bottle.fallback_bytes],
    ["fallback_cache_key_sha", bottle.fallback_cache_key_sha],
    ["fallback_link_manifest", bottle.fallback_link_manifest],
    ["fallback_built_at", bottle.fallback_built_at],
  ].filter(([, value]) => value === undefined).map(([field]) => field);
  if (missing.length > 0) {
    fail(
      `package ${quote(pkg.name)} bottle ${bottle.arch} status ${bottle.status} has no complete last-green fallback; missing ${missing.join(", ")}`,
    );
  }

  return {
    metadataStatus: bottle.status,
    sourceStatus: "fallback",
    url: bottle.fallback_url!,
    sha256: validateSha256(bottle.fallback_sha256!, `${pkg.name}.fallback_sha256`),
    bytes: bottle.fallback_bytes!,
    cacheKeySha: validateSha256(
      bottle.fallback_cache_key_sha!,
      `${pkg.name}.fallback_cache_key_sha`,
    ),
    linkManifestPath: bottle.fallback_link_manifest!,
    builtAt: bottle.fallback_built_at,
  };
}

function validateLinkManifest(
  pkg: HomebrewMetadataPackage,
  bottle: HomebrewMetadataBottle,
  selected: SelectedBottle,
  link: HomebrewLinkManifest,
): void {
  expectEqual(link.package, pkg.name, "link manifest package", "metadata package");
  expectEqual(link.version, pkg.version, "link manifest version", "metadata version");
  expectEqual(link.arch, bottle.arch, "link manifest arch", "metadata arch");
  expectEqual(link.kandelo_abi, bottle.kandelo_abi, "link manifest kandelo_abi", "metadata ABI");
  expectEqual(link.prefix, bottle.prefix, "link manifest prefix", "metadata prefix");
  expectEqual(link.cellar, bottle.cellar, "link manifest cellar", "metadata cellar");
  expectEqual(link.bottle.url, selected.url, "link manifest bottle.url", "metadata");
  expectEqual(link.bottle.sha256, selected.sha256, "link manifest bottle.sha256", "metadata");
  expectEqual(link.bottle.bytes, selected.bytes, "link manifest bottle.bytes", "metadata");
  expectEqual(
    link.bottle.cache_key_sha,
    selected.cacheKeySha,
    "link manifest bottle.cache_key_sha",
    "metadata",
  );

  validateSha256(link.bottle.sha256, "link manifest bottle.sha256");
  validateSha256(link.bottle.cache_key_sha, "link manifest bottle.cache_key_sha");
  validateGuestAbsolutePath(link.prefix, "link manifest prefix");
  validateGuestAbsolutePath(link.cellar, "link manifest cellar");
  validateGuestAbsolutePath(link.keg, "link manifest keg");
  if (!guestPathIsUnder(link.cellar, link.prefix)) {
    fail(`link manifest cellar ${quote(link.cellar)} must be under prefix ${quote(link.prefix)}`);
  }
  if (!guestPathIsUnder(link.keg, link.cellar)) {
    fail(`link manifest keg ${quote(link.keg)} must be under cellar ${quote(link.cellar)}`);
  }

  validateGuestRelativePath(link.bottle.payload_root, "link manifest bottle.payload_root");
  if (link.receipts.length === 0) fail("link manifest receipts must not be empty");
  for (const receipt of link.receipts) {
    validateGuestRelativePath(receipt, "link manifest receipt");
  }
  const targets = new Set<string>();
  for (const entry of link.links) {
    validateGuestRelativePath(entry.source, "link manifest link source");
    validateGuestRelativePath(entry.target, "link manifest link target");
    if (targets.has(entry.target)) {
      fail(`link manifest duplicate target ${quote(entry.target)}`);
    }
    targets.add(entry.target);
    if (entry.mode !== undefined && !/^[0-7]{4}$/.test(entry.mode)) {
      fail(`link manifest link mode ${quote(entry.mode)} is not four octal digits`);
    }
  }
  for (const path of link.env.PATH_prepend ?? []) {
    validateGuestRelativePath(path, "link manifest env.PATH_prepend");
  }
}

function parseReleaseAbi(tag: string): number | null {
  const match = /^bottles-abi-v([1-9][0-9]*)$/.exec(tag);
  return match ? Number(match[1]) : null;
}

function parseArch(value: string, label: string): HomebrewBottleArch {
  if (value === "wasm32" || value === "wasm64") return value;
  fail(`${label} must be wasm32 or wasm64`);
}

function parseRuntime(value: unknown, label: string): HomebrewRuntime {
  if (value === "node" || value === "browser") return value;
  fail(`${label} must be node or browser`);
}

function parseStatus(value: string, label: string): HomebrewBottleStatus {
  if (value === "success" || value === "failed" || value === "pending" || value === "building") {
    return value;
  }
  fail(`${label} must be success, failed, pending, or building`);
}

function validatePackageName(value: string, label: string): void {
  if (!PACKAGE_RE.test(value) || value.length > MAX_PACKAGE_NAME_BYTES) {
    fail(`${label} ${quote(value)} is not a valid package name`);
  }
}

function validateSha256(value: string, label: string): string {
  if (!SHA256_RE.test(value)) fail(`${label} must be a lowercase 64-char sha256`);
  return value;
}

function validateTapRelativePath(path: string, label: string): void {
  validateRelativePath(path, label, SAFE_TAP_REL_SEGMENT_RE);
}

function validateGuestRelativePath(path: string, label: string): void {
  validateRelativePath(path, label, SAFE_GUEST_REL_SEGMENT_RE);
}

function validateRelativePath(path: string, label: string, segmentPattern: RegExp): void {
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part === "." || part === ".." || !segmentPattern.test(part))
  ) {
    fail(`${label} ${quote(path)} must be a safe relative path`);
  }
}

function validateGuestAbsolutePath(path: string, label: string): void {
  if (!path.startsWith("/") || /\s/.test(path)) {
    fail(`${label} ${quote(path)} must be a safe absolute guest path`);
  }
  const parts = path.split("/").slice(1);
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail(`${label} ${quote(path)} must be a safe absolute guest path`);
  }
}

function guestPathIsUnder(child: string, parent: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(normalizedParent);
}

function expectEqual<T>(actual: T, expected: T, actualLabel: string, expectedLabel: string): void {
  if (actual !== expected) {
    fail(`${actualLabel} does not match ${expectedLabel}`);
  }
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  return requireStringValue(record[key], `${label}.${key}`);
}

function requireStringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) fail(`${label}.${key} must be a non-empty string`);
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${label}.${key} must be an integer`);
  }
  return value;
}

function optionalInteger(record: Record<string, unknown>, key: string, label: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${label}.${key} must be an integer`);
  }
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") fail(`${label}.${key} must be a boolean`);
  return value;
}

function requiredArray(record: Record<string, unknown>, key: string, label: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) fail(`${label}.${key} must be an array`);
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string, label: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${label}.${key} must be an array`);
  return value.map((entry, index) => requireStringValue(entry, `${label}.${key}[${index}]`));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBottleString(
  pkg: HomebrewMetadataPackage,
  bottle: HomebrewMetadataBottle,
  field: string,
  value: string | undefined,
): string {
  if (value === undefined) {
    fail(`package ${quote(pkg.name)} ${bottle.arch} bottle status success requires ${field}`);
  }
  return value;
}

function requireBottleInteger(
  pkg: HomebrewMetadataPackage,
  bottle: HomebrewMetadataBottle,
  field: string,
  value: number | undefined,
): number {
  if (value === undefined) {
    fail(`package ${quote(pkg.name)} ${bottle.arch} bottle status success requires ${field}`);
  }
  return value;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function fail(message: string): never {
  throw new HomebrewVfsPlanError(message);
}
