import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fetchHomebrewBottleBytes } from "./homebrew-vfs-fetch";
import {
  planHomebrewVfs,
  type HomebrewBottleArch,
  type HomebrewVfsPlan,
  type HomebrewVfsPackagePlan,
} from "./homebrew-vfs-planner";
import {
  DEFAULT_TAR_GZIP_LIMITS,
  parseTarGzip,
  type TarEntry,
} from "./vfs/tar";

const PACKAGE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const TAP_NAME_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LOCK_KIND_RE = /^kandelo-[a-z0-9-]+-tap-recipe-lock$/;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._@%+=,:[\]-]+$/;
const MAX_RECIPE_LOCK_BYTES = 1024 * 1024;
const MAX_OUTPUTS = 64;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HomebrewSupportDataOutput {
  name: string;
  path: string;
  memberPath: string;
  sha256: string;
  bytes: number;
  data: Uint8Array;
}

export interface HomebrewSupportDataExtractionReport {
  schema: 1;
  kind: "kandelo-homebrew-support-data-bottle-extraction";
  catalog: {
    tap_repository: string;
    tap_name: string;
    checkout_commit: string;
    metadata_tap_commit: string;
    kandelo_repository: string;
    kandelo_commit: string;
    kandelo_abi: number;
    release_tag: string;
  };
  package: {
    name: string;
    full_name: string;
    version: string;
    formula_revision: number;
    bottle_rebuild: number;
    formula_path: string;
    current_tap_formula_sha256: string;
    formula_metadata_path: string;
    formula_metadata_sha256: string;
    formula_metadata_bytes: number;
    recipe_lock_path: string;
    recipe_lock_kind: string;
    recipe_lock_sha256: string;
    recipe_lock_bytes: number;
  };
  bottle: {
    arch: HomebrewBottleArch;
    kandelo_abi: number;
    url: string;
    sha256: string;
    bytes: number;
    cache_key_sha: string;
    built_at?: string;
    built_from: {
      tap_repository: string;
      tap_commit: string;
      kandelo_repository: string;
      kandelo_commit: string;
      formula_sha256: string;
    };
    prefix: string;
    cellar: string;
    keg: string;
    payload_root: string;
    link_manifest_path: string;
  };
  outputs: Array<{
    name: string;
    path: string;
    member_path: string;
    sha256: string;
    bytes: number;
  }>;
}

export interface HomebrewSupportDataBottleContractOptions {
  metadata: unknown;
  packageName: string;
  arch: HomebrewBottleArch;
  expectedAbi: number;
  expectedTapRepository: string;
  expectedTapName: string;
  expectedCheckoutCommit: string;
  loadTapFile: (tapRelativePath: string) => Uint8Array | Promise<Uint8Array>;
}

export interface ExtractHomebrewSupportDataBottleOptions extends HomebrewSupportDataBottleContractOptions {
  loadBottleBytes?: (
    pkg: HomebrewVfsPackagePlan,
  ) => Uint8Array | Promise<Uint8Array>;
  fetchImpl?: FetchLike;
}

export interface VerifyHomebrewSupportDataExtractionOptions extends HomebrewSupportDataBottleContractOptions {
  report: unknown;
  loadOutput: (output: {
    name: string;
    path: string;
    expectedBytes: number;
  }) => Uint8Array | Promise<Uint8Array>;
}

export interface HomebrewSupportDataExtraction {
  report: HomebrewSupportDataExtractionReport;
  outputs: HomebrewSupportDataOutput[];
}

interface RecipeOutput {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
}

interface RecipeLock {
  kind: string;
  packageName: string;
  packageVersion: string;
  packageArch: HomebrewBottleArch;
  outputs: RecipeOutput[];
}

interface ResolvedSupportDataBottleContract {
  plan: HomebrewVfsPlan;
  pkg: HomebrewVfsPackagePlan;
  recipeLock: RecipeLock;
  formulaPath: string;
  formulaBytes: Uint8Array;
  formulaMetadataPath: string;
  formulaMetadataBytes: Uint8Array;
  recipeLockPath: string;
  recipeLockBytes: Uint8Array;
  expectedCheckoutCommit: string;
}

export class HomebrewSupportDataBottleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewSupportDataBottleError";
  }
}

/**
 * Fetch and extract the complete declared output set from one support-data
 * Formula bottle.
 *
 * The exact tap checkout remains the authority for Formula, recipe-lock, and
 * link-manifest bytes. The public bottle is accepted only when those files,
 * catalog metadata, immutable build provenance, and the archive agree.
 */
export async function extractHomebrewSupportDataBottle(
  options: ExtractHomebrewSupportDataBottleOptions,
): Promise<HomebrewSupportDataExtraction> {
  const contract = await resolveSupportDataBottleContract(options);
  const { pkg, recipeLock } = contract;

  const bottleBytes = await (options.loadBottleBytes
    ? options.loadBottleBytes(pkg)
    : fetchHomebrewBottleBytes(pkg.url, {
        expectedBytes: pkg.bytes,
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
      }));
  requireBoundedBytes(
    bottleBytes,
    DEFAULT_TAR_GZIP_LIMITS.maxCompressedBytes,
    "Homebrew bottle",
  );
  if (bottleBytes.byteLength !== pkg.bytes) {
    fail(`bottle has ${bottleBytes.byteLength} bytes, expected ${pkg.bytes}`);
  }
  const bottleSha256 = sha256(bottleBytes);
  if (bottleSha256 !== pkg.sha256) {
    fail(`bottle sha256 ${bottleSha256} does not match metadata ${pkg.sha256}`);
  }

  let entries: TarEntry[];
  try {
    entries = parseTarGzip(bottleBytes, {
      label: `${pkg.fullName}@${pkg.version} ${pkg.arch} bottle`,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const outputs = extractDeclaredOutputs(pkg, recipeLock.outputs, entries);
  const report = createExtractionReport(contract, outputs);
  return { report, outputs };
}

/**
 * Rebind detached support-data files to the exact tap contract and extraction
 * report without downloading or parsing the bottle again.
 */
export async function verifyHomebrewSupportDataExtraction(
  options: VerifyHomebrewSupportDataExtractionOptions,
): Promise<HomebrewSupportDataExtraction> {
  const contract = await resolveSupportDataBottleContract(options);
  const outputs: HomebrewSupportDataOutput[] = [];
  for (const declared of contract.recipeLock.outputs) {
    const loaded = await options.loadOutput({
      name: declared.name,
      path: declared.path,
      expectedBytes: declared.bytes,
    });
    requireBoundedBytes(
      loaded,
      MAX_OUTPUT_BYTES,
      `support-data output ${quote(declared.name)}`,
    );
    const actualSha256 = sha256(loaded);
    if (
      loaded.byteLength !== declared.bytes ||
      actualSha256 !== declared.sha256
    ) {
      fail(
        `support-data output ${quote(declared.name)} has sha256 ` +
          `${actualSha256} and ${loaded.byteLength} bytes; expected ` +
          `${declared.sha256} and ${declared.bytes} bytes`,
      );
    }
    outputs.push({
      ...declared,
      memberPath: `${contract.pkg.payloadRoot}/libexec/${declared.path}`,
      data: new Uint8Array(loaded),
    });
  }

  const report = createExtractionReport(contract, outputs);
  if (!isDeepStrictEqual(options.report, report)) {
    fail(
      "support-data extraction report differs from the exact tap and output " +
        "contract",
    );
  }
  return { report, outputs };
}

async function resolveSupportDataBottleContract(
  options: HomebrewSupportDataBottleContractOptions,
): Promise<ResolvedSupportDataBottleContract> {
  validateOptions(options);
  const metadataPackage = findMetadataPackage(
    options.metadata,
    options.packageName,
  );
  const formulaPath = requireSafeTapPath(
    metadataPackage.formula_path,
    "metadata formula_path",
  );
  const formulaMetadataPath = requireSafeTapPath(
    metadataPackage.formula_metadata,
    "metadata formula_metadata",
  );
  const recipeLockPath = `Kandelo/recipes/${options.packageName}/source-lock.json`;
  const [formulaBytes, formulaMetadataBytes, recipeLockBytes] =
    await Promise.all([
      options.loadTapFile(formulaPath),
      options.loadTapFile(formulaMetadataPath),
      options.loadTapFile(recipeLockPath),
    ]);
  requireBoundedBytes(formulaBytes, 1024 * 1024, "Formula");
  requireBoundedBytes(
    formulaMetadataBytes,
    4 * 1024 * 1024,
    "Formula metadata",
  );
  requireBoundedBytes(
    recipeLockBytes,
    MAX_RECIPE_LOCK_BYTES,
    "tap recipe lock",
  );

  const recipeLock = parseRecipeLock(recipeLockBytes);
  const formulaMetadata = parseJson(
    formulaMetadataBytes,
    `Formula metadata ${quote(formulaMetadataPath)}`,
    4 * 1024 * 1024,
  );
  if (recipeLock.packageName !== options.packageName) {
    fail(
      `tap recipe lock package ${quote(recipeLock.packageName)} does not ` +
        `match requested package ${quote(options.packageName)}`,
    );
  }
  if (recipeLock.packageArch !== options.arch) {
    fail(
      `tap recipe lock arch ${quote(recipeLock.packageArch)} does not match ` +
        `requested arch ${quote(options.arch)}`,
    );
  }

  const plan = await planHomebrewVfs(options.metadata, {
    packages: [options.packageName],
    arch: options.arch,
    expectedAbi: options.expectedAbi,
    expectedTapName: options.expectedTapName,
    allowFallback: false,
    loadLinkManifest: async (path) =>
      parseJson(
        await options.loadTapFile(path),
        `link manifest ${quote(path)}`,
        4 * 1024 * 1024,
      ),
  });
  if (
    plan.tapRepository.toLowerCase() !==
    options.expectedTapRepository.toLowerCase()
  ) {
    fail(
      `catalog repository ${quote(plan.tapRepository)} does not match ` +
        `${quote(options.expectedTapRepository)}`,
    );
  }
  assertFormulaMetadata(metadataPackage, formulaMetadata, plan);
  if (plan.packages.length !== 1) {
    fail(
      `support-data package ${quote(options.packageName)} must have no ` +
        `runtime dependency closure; planned ${plan.packages.length} packages`,
    );
  }

  const pkg = plan.packages[0];
  if (
    pkg.name !== options.packageName ||
    pkg.fullName !== `${options.expectedTapName}/${options.packageName}`
  ) {
    fail("planned support-data Formula identity is not exact");
  }
  if (pkg.version !== recipeLock.packageVersion) {
    fail(
      `bottle version ${quote(pkg.version)} does not match tap recipe lock ` +
        `${quote(recipeLock.packageVersion)}`,
    );
  }
  const expectedPayloadRoot = `${pkg.name}/${pkg.version}`;
  const expectedKeg = `${pkg.cellar}/${expectedPayloadRoot}`;
  if (pkg.payloadRoot !== expectedPayloadRoot || pkg.keg !== expectedKeg) {
    fail(
      `bottle keg identity must be exactly ${quote(expectedKeg)} with ` +
        `payload root ${quote(expectedPayloadRoot)}`,
    );
  }
  if (pkg.builtFrom === undefined) {
    fail(
      "successful support-data bottle is missing immutable build provenance",
    );
  }
  if (pkg.bytes > DEFAULT_TAR_GZIP_LIMITS.maxCompressedBytes) {
    fail(
      `bottle declares ${pkg.bytes} compressed bytes, exceeding the ` +
        `${DEFAULT_TAR_GZIP_LIMITS.maxCompressedBytes}-byte parser limit`,
    );
  }

  return {
    plan,
    pkg,
    recipeLock,
    formulaPath,
    formulaBytes,
    formulaMetadataPath,
    formulaMetadataBytes,
    recipeLockPath,
    recipeLockBytes,
    expectedCheckoutCommit: options.expectedCheckoutCommit,
  };
}

function createExtractionReport(
  contract: ResolvedSupportDataBottleContract,
  outputs: readonly HomebrewSupportDataOutput[],
): HomebrewSupportDataExtractionReport {
  const {
    plan,
    pkg,
    recipeLock,
    formulaPath,
    formulaBytes,
    formulaMetadataPath,
    formulaMetadataBytes,
    recipeLockPath,
    recipeLockBytes,
    expectedCheckoutCommit,
  } = contract;
  const builtFrom = pkg.builtFrom;
  if (builtFrom === undefined) {
    fail(
      "successful support-data bottle is missing immutable build provenance",
    );
  }
  // WHY: Homebrew's bottle receipt hashes its canonical `.brew` Formula,
  // which omits the finalized bottle block. The exact checkout hashes the
  // current tap Formula including that block. Preserve both coordinates; an
  // equality check would reject every correctly finalized bottle.
  return {
    schema: 1,
    kind: "kandelo-homebrew-support-data-bottle-extraction",
    catalog: {
      tap_repository: plan.tapRepository,
      tap_name: plan.tapName,
      checkout_commit: expectedCheckoutCommit,
      metadata_tap_commit: plan.tapCommit,
      kandelo_repository: plan.kandeloRepository,
      kandelo_commit: plan.kandeloCommit,
      kandelo_abi: plan.kandeloAbi,
      release_tag: plan.releaseTag,
    },
    package: {
      name: pkg.name,
      full_name: pkg.fullName,
      version: pkg.version,
      formula_revision: pkg.formulaRevision,
      bottle_rebuild: pkg.bottleRebuild,
      formula_path: formulaPath,
      current_tap_formula_sha256: sha256(formulaBytes),
      formula_metadata_path: formulaMetadataPath,
      formula_metadata_sha256: sha256(formulaMetadataBytes),
      formula_metadata_bytes: formulaMetadataBytes.byteLength,
      recipe_lock_path: recipeLockPath,
      recipe_lock_kind: recipeLock.kind,
      recipe_lock_sha256: sha256(recipeLockBytes),
      recipe_lock_bytes: recipeLockBytes.byteLength,
    },
    bottle: {
      arch: pkg.arch,
      kandelo_abi: pkg.kandeloAbi,
      url: pkg.url,
      sha256: pkg.sha256,
      bytes: pkg.bytes,
      cache_key_sha: pkg.cacheKeySha,
      ...(pkg.builtAt === undefined ? {} : { built_at: pkg.builtAt }),
      built_from: {
        tap_repository: builtFrom.tapRepository,
        tap_commit: builtFrom.tapCommit,
        kandelo_repository: builtFrom.kandeloRepository,
        kandelo_commit: builtFrom.kandeloCommit,
        formula_sha256: builtFrom.formulaSha256,
      },
      prefix: pkg.prefix,
      cellar: pkg.cellar,
      keg: pkg.keg,
      payload_root: pkg.payloadRoot,
      link_manifest_path: pkg.linkManifestPath,
    },
    outputs: outputs.map((output) => ({
      name: output.name,
      path: output.path,
      member_path: output.memberPath,
      sha256: output.sha256,
      bytes: output.bytes,
    })),
  };
}

function extractDeclaredOutputs(
  pkg: HomebrewVfsPackagePlan,
  declared: readonly RecipeOutput[],
  entries: readonly TarEntry[],
): HomebrewSupportDataOutput[] {
  const libexecRoot = `${pkg.payloadRoot}/libexec`;
  const declaredByMember = new Map(
    declared.map((output) => [`${libexecRoot}/${output.path}`, output]),
  );
  const found = new Map<string, HomebrewSupportDataOutput>();

  for (const entry of entries) {
    if (
      entry.path !== libexecRoot &&
      !entry.path.startsWith(`${libexecRoot}/`)
    ) {
      continue;
    }
    if (entry.type === "directory") continue;
    const output = declaredByMember.get(entry.path);
    if (output === undefined) {
      fail(
        `bottle contains undeclared support-data member ${quote(entry.path)}`,
      );
    }
    if (entry.type !== "file") {
      fail(
        `support-data member ${quote(entry.path)} must be a regular file, ` +
          `got ${entry.type}`,
      );
    }
    if (found.has(entry.path)) {
      fail(`bottle duplicates support-data member ${quote(entry.path)}`);
    }
    const actualSha256 = sha256(entry.data);
    if (
      entry.data.byteLength !== output.bytes ||
      actualSha256 !== output.sha256
    ) {
      fail(
        `support-data member ${quote(entry.path)} has sha256 ` +
          `${actualSha256} and ${entry.data.byteLength} bytes; expected ` +
          `${output.sha256} and ${output.bytes} bytes`,
      );
    }
    found.set(entry.path, {
      ...output,
      memberPath: entry.path,
      // Do not retain the complete decompressed TAR backing through a view.
      data: new Uint8Array(entry.data),
    });
  }

  const result: HomebrewSupportDataOutput[] = [];
  for (const [memberPath, output] of declaredByMember) {
    const extracted = found.get(memberPath);
    if (extracted === undefined) {
      fail(`bottle omits declared support-data member ${quote(memberPath)}`);
    }
    result.push(extracted);
  }
  return result;
}

function parseRecipeLock(bytes: Uint8Array): RecipeLock {
  const value = requireRecord(
    parseJson(bytes, "tap recipe lock", MAX_RECIPE_LOCK_BYTES),
    "tap recipe lock",
  );
  if (value.schema !== 1) fail("tap recipe lock schema must be 1");
  const kind = requireString(value.kind, "tap recipe lock kind");
  if (!LOCK_KIND_RE.test(kind)) {
    fail(`tap recipe lock kind ${quote(kind)} is not canonical`);
  }
  const packageValue = requireRecord(value.package, "tap recipe lock package");
  const packageName = requireString(
    packageValue.name,
    "tap recipe lock package.name",
  );
  if (!PACKAGE_RE.test(packageName)) {
    fail("tap recipe lock package.name is invalid");
  }
  const packageVersion = requireString(
    packageValue.version,
    "tap recipe lock package.version",
  );
  const packageArch = packageValue.arch;
  if (packageArch !== "wasm32" && packageArch !== "wasm64") {
    fail("tap recipe lock package.arch must be wasm32 or wasm64");
  }

  const outputValues = requireRecord(value.outputs, "tap recipe lock outputs");
  const names = Object.keys(outputValues).sort();
  if (names.length === 0 || names.length > MAX_OUTPUTS) {
    fail(`tap recipe lock must declare 1..${MAX_OUTPUTS} outputs`);
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  const outputs = names.map((name): RecipeOutput => {
    if (!PACKAGE_RE.test(name)) {
      fail(`tap recipe lock output name ${quote(name)} is invalid`);
    }
    const output = requireRecord(
      outputValues[name],
      `tap recipe lock outputs.${name}`,
    );
    const keys = Object.keys(output).sort();
    if (keys.join(",") !== "bytes,path,sha256") {
      fail(
        `tap recipe lock outputs.${name} fields must be exactly ` +
          "bytes, path, sha256",
      );
    }
    const path = requireSafeRelativePath(
      output.path,
      `tap recipe lock outputs.${name}.path`,
    );
    if (paths.has(path)) {
      fail(`tap recipe lock duplicates output path ${quote(path)}`);
    }
    paths.add(path);
    const outputSha256 = requireString(
      output.sha256,
      `tap recipe lock outputs.${name}.sha256`,
    );
    if (!SHA256_RE.test(outputSha256)) {
      fail(`tap recipe lock outputs.${name}.sha256 is invalid`);
    }
    const outputBytes = output.bytes;
    if (
      typeof outputBytes !== "number" ||
      !Number.isSafeInteger(outputBytes) ||
      outputBytes <= 0 ||
      outputBytes > MAX_OUTPUT_BYTES
    ) {
      fail(
        `tap recipe lock outputs.${name}.bytes must be in ` +
          `1..${MAX_OUTPUT_BYTES}`,
      );
    }
    totalBytes += outputBytes;
    if (totalBytes > MAX_OUTPUT_BYTES) {
      fail(
        `tap recipe lock output bytes exceed aggregate ` +
          `${MAX_OUTPUT_BYTES}-byte limit`,
      );
    }
    return {
      name,
      path,
      sha256: outputSha256,
      bytes: outputBytes,
    };
  });
  return {
    kind,
    packageName,
    packageVersion,
    packageArch,
    outputs,
  };
}

function findMetadataPackage(
  metadata: unknown,
  packageName: string,
): Record<string, unknown> {
  const value = requireRecord(metadata, "tap metadata");
  if (!Array.isArray(value.packages)) {
    fail("tap metadata packages must be an array");
  }
  const matches = value.packages.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).name === packageName,
  );
  if (matches.length !== 1) {
    fail(
      `tap metadata must contain exactly one package named ` +
        `${quote(packageName)}`,
    );
  }
  return matches[0] as Record<string, unknown>;
}

function assertFormulaMetadata(
  metadataPackage: Record<string, unknown>,
  formulaMetadataValue: unknown,
  plan: HomebrewVfsPlan,
): void {
  const formulaMetadata = requireRecord(
    formulaMetadataValue,
    "Formula metadata",
  );
  if (
    formulaMetadata.schema !== 1 ||
    formulaMetadata.tap_repository !== plan.tapRepository ||
    formulaMetadata.tap_name !== plan.tapName ||
    formulaMetadata.tap_commit !== plan.tapCommit ||
    formulaMetadata.kandelo_abi !== plan.kandeloAbi ||
    formulaMetadata.source_metadata !== "Kandelo/metadata.json"
  ) {
    fail("Formula metadata does not belong to the exact catalog checkout");
  }
  for (const field of [
    "name",
    "full_name",
    "version",
    "formula_revision",
    "bottle_rebuild",
    "formula_path",
    "dependencies",
    "bottles",
  ]) {
    if (!isDeepStrictEqual(formulaMetadata[field], metadataPackage[field])) {
      fail(`Formula metadata ${field} differs from the catalog package`);
    }
  }
}

function validateOptions(
  options: HomebrewSupportDataBottleContractOptions,
): void {
  if (!PACKAGE_RE.test(options.packageName)) {
    fail(`package name ${quote(options.packageName)} is invalid`);
  }
  if (!REPOSITORY_RE.test(options.expectedTapRepository)) {
    fail(`tap repository ${quote(options.expectedTapRepository)} is invalid`);
  }
  if (!TAP_NAME_RE.test(options.expectedTapName)) {
    fail(`tap name ${quote(options.expectedTapName)} is invalid`);
  }
  if (!GIT_SHA_RE.test(options.expectedCheckoutCommit)) {
    fail("expected checkout commit must be a lowercase 40-character git SHA");
  }
  if (!Number.isSafeInteger(options.expectedAbi) || options.expectedAbi <= 0) {
    fail("expected ABI must be a positive safe integer");
  }
}

function parseJson(
  bytes: Uint8Array,
  label: string,
  maxBytes: number,
): unknown {
  requireBoundedBytes(bytes, maxBytes, label);
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(
      `${label} is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireBoundedBytes(
  value: Uint8Array,
  maxBytes: number,
  label: string,
): void {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > maxBytes
  ) {
    fail(`${label} byte count must be in 1..${maxBytes}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    new TextEncoder().encode(value).byteLength > MAX_PATH_BYTES
  ) {
    fail(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function requireSafeTapPath(value: unknown, label: string): string {
  return requireSafeRelativePath(value, label);
}

function requireSafeRelativePath(value: unknown, label: string): string {
  const path = requireString(value, label);
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        !SAFE_PATH_SEGMENT_RE.test(part),
    )
  ) {
    fail(`${label} ${quote(path)} must be a safe relative POSIX path`);
  }
  return path;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function fail(message: string): never {
  throw new HomebrewSupportDataBottleError(message);
}
