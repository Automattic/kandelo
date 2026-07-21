import { createHash } from "node:crypto";
import {
  KANDELO_DEMO_CONFIG_PATH,
  parseKandeloDemoConfig,
  resolveDemoAssets,
  resolveDemoGuide,
  resolveDemoPresentation,
  validateKandeloDemoConfig,
} from "../web-libs/kandelo-session/src/demo-config";
import {
  DOOM_COMMAND,
  DOOM_WAD_SHA256,
  DOOM_WAD_URL,
} from "../web-libs/kandelo-session/src/demo-guides";

const EXPECTED_ROOT_COUNT = 32;
const EXPECTED_CLOSURE_COUNT = 38;
const EXPECTED_ARCH = "wasm32";
const EXPECTED_SHELL_PATH = "/home/linuxbrew/.linuxbrew/bin/bash";
const EXPECTED_SHELL_ARGV = ["bash", "-l", "-i"];

export interface MainShellImageContractInput {
  migrationLock: unknown;
  migrationLockSha256: string;
  migrationLockBytes: number;
  guestManifest: unknown;
  imageMetadata: unknown;
  imageCapacity: unknown;
  shellConfig: unknown;
  demoConfigSource: Uint8Array;
  expectedDemoConfigSource: Uint8Array;
  runtimeState: MainShellRuntimeStateEntry[];
}

export interface MainShellRuntimeStateEntry {
  path: string;
  kind: "directory" | "empty_file" | "text_file";
  mode: number;
  uid: number;
  gid: number;
  contents?: Uint8Array;
}

/**
 * Prove that the bytes accepted by the main-shell smoke contain the complete,
 * reviewed Homebrew migration closure. This intentionally validates the VFS
 * payload after package-archive extraction: a cache hit cannot substitute an
 * older shell image while a pre-archive composition report remains green.
 */
export function assertMainShellImageContract(input: MainShellImageContractInput): void {
  const lock = requiredRecord(input.migrationLock, "migration lock");
  const tapRepository = requiredString(lock, "tap_repository", "migration lock");
  const tapName = requiredString(lock, "tap_name", "migration lock");
  const catalog = requiredRecord(lock.catalog, "migration lock catalog");
  const tapCommit = requiredString(catalog, "tap_commit", "migration lock catalog");
  const consumer = requiredRecord(lock.consumer, "migration lock consumer");
  const maxVfsBytes = requiredPositiveInteger(
    consumer,
    "max_vfs_byte_length",
    "migration lock consumer",
  );

  const lockedPackages = requiredRecordArray(lock.packages, "migration lock packages");
  if (lockedPackages.length !== EXPECTED_ROOT_COUNT) {
    fail(`migration lock has ${lockedPackages.length} roots, expected ${EXPECTED_ROOT_COUNT}`);
  }
  const requestedPackages = lockedPackages.map((entry, index) => {
    const formula = requiredRecord(entry.formula, `migration lock package ${index} formula`);
    return requiredString(formula, "name", `migration lock package ${index} formula`);
  });
  assertUnique(requestedPackages, "migration lock roots");
  const requestedPackagesSha256 = createHash("sha256")
    .update(JSON.stringify(requestedPackages))
    .digest("hex");

  const formulaClosure = requiredStringArray(
    lock.formula_closure,
    "migration lock formula_closure",
  );
  if (formulaClosure.length !== EXPECTED_CLOSURE_COUNT) {
    fail(
      `migration lock has ${formulaClosure.length} closure Formulae, ` +
        `expected ${EXPECTED_CLOSURE_COUNT}`,
    );
  }
  assertUnique(formulaClosure, "migration lock formula_closure");

  const guest = requiredRecord(input.guestManifest, "guest Homebrew manifest");
  expectEqual(guest.schema, 1, "guest Homebrew manifest schema");
  const guestSelection = requiredRecord(guest.selection, "guest Homebrew selection");
  expectEqual(guestSelection.kind, "brewfile", "guest Homebrew selection kind");
  expectExactStrings(
    requiredStringArray(
      guestSelection.requested_packages,
      "guest Homebrew requested_packages",
    ),
    requestedPackages,
    "guest Homebrew requested_packages",
  );
  expectEqual(
    guestSelection.requested_packages_sha256,
    requestedPackagesSha256,
    "guest Homebrew requested_packages_sha256",
  );
  assertCatalog(requiredRecord(guest.catalog, "guest Homebrew catalog"), {
    tapRepository,
    tapName,
    tapCommit,
  }, "guest Homebrew catalog", "snake");
  assertLockBinding(
    requiredRecord(guest.migration_lock, "guest Homebrew migration_lock"),
    input,
    "guest Homebrew migration_lock",
  );
  const guestMetadata = requiredRecord(guest.metadata, "guest Homebrew metadata");
  expectEqual(guestMetadata.tap_repository, tapRepository, "guest metadata tap_repository");
  expectEqual(guestMetadata.tap_name, tapName, "guest metadata tap_name");
  const guestPackages = requiredRecordArray(guest.packages, "guest Homebrew packages");
  assertPackageClosure(
    guestPackages,
    formulaClosure,
    tapRepository,
    tapName,
    "snake",
  );

  const imageMetadata = requiredRecord(input.imageMetadata, "VFS image metadata");
  const imageCapacityMetadata = requiredRecord(imageMetadata.capacity, "VFS capacity metadata");
  expectEqual(
    imageCapacityMetadata.maxByteLength,
    maxVfsBytes,
    "VFS metadata capacity.maxByteLength",
  );
  const homebrew = requiredRecord(imageMetadata.homebrew, "VFS Homebrew metadata");
  expectEqual(homebrew.tapRepository, tapRepository, "VFS metadata tapRepository");
  expectEqual(homebrew.tapName, tapName, "VFS metadata tapName");
  expectEqual(homebrew.tapCommit, guestMetadata.tap_commit, "VFS metadata tapCommit");
  expectEqual(homebrew.releaseTag, guestMetadata.release_tag, "VFS metadata releaseTag");
  assertCatalog(requiredRecord(homebrew.catalog, "VFS metadata catalog"), {
    tapRepository,
    tapName,
    tapCommit,
  }, "VFS metadata catalog", "camel");
  assertLockBinding(
    requiredRecord(homebrew.migrationLock, "VFS metadata migrationLock"),
    input,
    "VFS metadata migrationLock",
  );
  const imageSelection = requiredRecord(homebrew.selection, "VFS metadata selection");
  expectEqual(imageSelection.kind, "brewfile", "VFS metadata selection kind");
  expectEqual(
    imageSelection.requestedPackageCount,
    requestedPackages.length,
    "VFS metadata requestedPackageCount",
  );
  expectEqual(
    imageSelection.requestedPackagesSha256,
    requestedPackagesSha256,
    "VFS metadata requestedPackagesSha256",
  );
  assertBrewfileBinding(guestSelection, imageSelection);
  const imagePackages = requiredRecordArray(homebrew.packages, "VFS metadata packages");
  assertPackageClosure(
    imagePackages,
    formulaClosure,
    tapRepository,
    tapName,
    "camel",
  );
  assertPackageCopiesAgree(guestPackages, imagePackages);
  assertLockedRootVersions(lockedPackages, guestPackages, tapName);

  const capacity = requiredRecord(input.imageCapacity, "decoded VFS capacity");
  expectEqual(capacity.maxByteLength, maxVfsBytes, "decoded VFS maxByteLength");
  const byteLength = requiredPositiveInteger(capacity, "byteLength", "decoded VFS capacity");
  if (byteLength > maxVfsBytes) {
    fail(`decoded VFS byteLength ${byteLength} exceeds locked capacity ${maxVfsBytes}`);
  }

  const shell = requiredRecord(input.shellConfig, "guest shell config");
  expectEqual(shell.version, 1, "guest shell config version");
  expectEqual(shell.path, EXPECTED_SHELL_PATH, "guest shell config path");
  expectExactStrings(
    requiredStringArray(shell.argv, "guest shell config argv"),
    EXPECTED_SHELL_ARGV,
    "guest shell config argv",
  );
  const metadataShell = requiredRecord(homebrew.defaultShell, "VFS metadata defaultShell");
  expectEqual(metadataShell.path, EXPECTED_SHELL_PATH, "VFS metadata defaultShell path");
  expectExactStrings(
    requiredStringArray(metadataShell.argv, "VFS metadata defaultShell argv"),
    EXPECTED_SHELL_ARGV,
    "VFS metadata defaultShell argv",
  );

  assertDemoConfig(input, homebrew);
  assertRuntimeState(input, lock, guest, homebrew, formulaClosure);
}

function assertDemoConfig(
  input: MainShellImageContractInput,
  homebrew: Record<string, unknown>,
): void {
  expectExactBytes(
    input.demoConfigSource,
    input.expectedDemoConfigSource,
    "guest demo config bytes",
  );
  const sha256 = createHash("sha256").update(input.demoConfigSource).digest("hex");
  const binding = requiredRecord(homebrew.demoConfig, "VFS metadata demoConfig");
  expectEqual(binding.path, KANDELO_DEMO_CONFIG_PATH, "VFS metadata demoConfig path");
  expectEqual(binding.sha256, sha256, "VFS metadata demoConfig sha256");
  expectEqual(
    binding.bytes,
    input.demoConfigSource.byteLength,
    "VFS metadata demoConfig bytes",
  );

  let config;
  try {
    config = parseKandeloDemoConfig(
      new TextDecoder("utf-8", { fatal: true }).decode(input.demoConfigSource),
    );
  } catch (error) {
    fail(`guest demo config is not valid UTF-8 JSON: ${String(error)}`);
  }
  if (config === null) fail("guest demo config does not use version 1");
  validateKandeloDemoConfig(config);

  const shellPresentation = resolveDemoPresentation(config, "shell");
  expectEqual(
    shellPresentation?.runningPrimary.join(","),
    "terminal,syslog",
    "shell demo presentation",
  );
  expectEqual(resolveDemoGuide(config, "shell")?.title, "Shell demo", "shell demo guide");
  const doomPresentation = resolveDemoPresentation(config, "doom");
  expectEqual(doomPresentation?.autoCommand, DOOM_COMMAND, "Doom demo autoCommand");
  const doomAssets = resolveDemoAssets(config, "doom");
  if (doomAssets.length !== 1) fail("Doom demo must declare exactly one asset");
  expectEqual(doomAssets[0].path, "/doom1.wad", "Doom demo asset path");
  expectEqual(doomAssets[0].url, DOOM_WAD_URL, "Doom demo asset URL");
  expectEqual(doomAssets[0].sha256, DOOM_WAD_SHA256, "Doom demo asset sha256");
  const modesetPresentation = resolveDemoPresentation(config, "modeset");
  expectEqual(
    modesetPresentation?.autoCommand,
    "/usr/local/bin/modeset",
    "modeset demo autoCommand",
  );
  expectEqual(
    modesetPresentation?.runningPrimary.join(","),
    "kms,terminal,syslog",
    "modeset demo presentation",
  );
}

function assertRuntimeState(
  input: MainShellImageContractInput,
  lock: Record<string, unknown>,
  guest: Record<string, unknown>,
  homebrew: Record<string, unknown>,
  formulaClosure: string[],
): void {
  const compatibility = requiredRecord(lock.compatibility, "migration lock compatibility");
  const declarations = requiredRecordArray(
    compatibility.runtime_state,
    "migration lock runtime_state",
  );
  const guestState = requiredRecordArray(guest.runtime_state, "guest runtime_state");
  const metadataState = requiredRecordArray(
    homebrew.runtimeState,
    "VFS metadata runtimeState",
  );
  if (
    guestState.length !== declarations.length ||
    metadataState.length !== declarations.length ||
    input.runtimeState.length !== declarations.length
  ) {
    fail("runtime-state copies do not have the reviewed declaration count");
  }
  const actualByPath = new Map(input.runtimeState.map((entry) => [entry.path, entry]));
  if (actualByPath.size !== input.runtimeState.length) {
    fail("decoded runtime state contains a duplicate path");
  }

  declarations.forEach((declaration, index) => {
    const label = `migration lock runtime_state[${index}]`;
    const requiresPackage = requiredString(declaration, "requires_package", label);
    if (!formulaClosure.includes(requiresPackage)) {
      fail(`${label} requires_package is outside the reviewed Formula closure`);
    }
    const path = requiredString(declaration, "path", label);
    const kind = requiredString(declaration, "kind", label);
    if (kind !== "directory" && kind !== "empty_file" && kind !== "text_file") {
      fail(`${label} kind is invalid`);
    }
    const mode = requiredNonNegativeInteger(declaration, "mode", label);
    const uid = requiredNonNegativeInteger(declaration, "uid", label);
    const gid = requiredNonNegativeInteger(declaration, "gid", label);
    const reason = requiredString(declaration, "reason", label);
    const guestEntry = guestState[index];
    const metadataEntry = metadataState[index];
    const actual = actualByPath.get(path);
    if (actual === undefined) fail(`decoded runtime state omits ${path}`);
    for (const [key, expected] of Object.entries({
      requires_package: requiresPackage,
      path,
      kind,
      mode,
      uid,
      gid,
      reason,
    })) {
      expectEqual(guestEntry[key], expected, `guest runtime_state[${index}] ${key}`);
    }
    for (const [key, expected] of Object.entries({
      requiresPackage,
      path,
      kind,
      mode,
      uid,
      gid,
      reason,
    })) {
      expectEqual(metadataEntry[key], expected, `VFS metadata runtimeState[${index}] ${key}`);
    }
    expectEqual(actual.kind, kind, `${path} decoded kind`);
    expectEqual(actual.mode, mode, `${path} decoded mode`);
    expectEqual(actual.uid, uid, `${path} decoded uid`);
    expectEqual(actual.gid, gid, `${path} decoded gid`);

    if (kind === "directory") {
      if (actual.contents !== undefined) fail(`${path} directory unexpectedly has contents`);
      if (guestEntry.content_sha256 !== undefined || guestEntry.content_bytes !== undefined) {
        fail(`guest runtime state directory ${path} has file-content provenance`);
      }
      if (metadataEntry.contentSha256 !== undefined || metadataEntry.contentBytes !== undefined) {
        fail(`VFS runtime state directory ${path} has file-content provenance`);
      }
      return;
    }

    const expectedContents = kind === "text_file"
      ? new TextEncoder().encode(requiredString(declaration, "contents", label))
      : new Uint8Array();
    if (actual.contents === undefined) fail(`${path} decoded file contents are missing`);
    expectExactBytes(actual.contents, expectedContents, `${path} decoded contents`);
    const contentSha256 = createHash("sha256").update(expectedContents).digest("hex");
    expectEqual(
      guestEntry.content_sha256,
      contentSha256,
      `guest runtime state ${path} content_sha256`,
    );
    expectEqual(
      guestEntry.content_bytes,
      expectedContents.byteLength,
      `guest runtime state ${path} content_bytes`,
    );
    expectEqual(
      metadataEntry.contentSha256,
      contentSha256,
      `VFS runtime state ${path} contentSha256`,
    );
    expectEqual(
      metadataEntry.contentBytes,
      expectedContents.byteLength,
      `VFS runtime state ${path} contentBytes`,
    );
  });
}

function assertBrewfileBinding(
  guestSelection: Record<string, unknown>,
  imageSelection: Record<string, unknown>,
): void {
  const guest = requiredRecord(guestSelection.brewfile, "guest Homebrew Brewfile binding");
  const image = requiredRecord(imageSelection.brewfile, "VFS metadata Brewfile binding");
  expectEqual(guest.parser, "kandelo-static-brewfile-v1", "guest Brewfile parser");
  requireLowerHex(guest, "sha256", 64, "guest Brewfile binding");
  requiredPositiveInteger(guest, "bytes", "guest Brewfile binding");
  for (const key of ["parser", "sha256", "bytes"] as const) {
    expectEqual(image[key], guest[key], `VFS metadata Brewfile ${key}`);
  }
}

function assertPackageCopiesAgree(
  guestPackages: Record<string, unknown>[],
  imagePackages: Record<string, unknown>[],
): void {
  const imageByFullName = new Map(
    imagePackages.map((entry, index) => [
      requiredString(entry, "fullName", `VFS metadata packages[${index}]`),
      entry,
    ]),
  );
  guestPackages.forEach((guest, index) => {
    const label = `guest Homebrew packages[${index}]`;
    const fullName = requiredString(guest, "full_name", label);
    const image = imageByFullName.get(fullName);
    if (image === undefined) fail(`VFS metadata omits package ${fullName}`);
    for (const [guestKey, imageKey] of [
      ["name", "name"],
      ["tap_repository", "tapRepository"],
      ["tap_name", "tapName"],
      ["tap_commit", "tapCommit"],
      ["version", "version"],
      ["arch", "arch"],
      ["source_status", "sourceStatus"],
      ["cache_key_sha", "cacheKeySha"],
    ] as const) {
      expectEqual(image[imageKey], guest[guestKey], `${fullName} ${imageKey}`);
    }

    const guestBuiltFrom = requiredRecord(guest.built_from, `${fullName} built_from`);
    const imageBuiltFrom = requiredRecord(image.builtFrom, `${fullName} builtFrom`);
    for (const [guestKey, imageKey] of [
      ["tap_repository", "tapRepository"],
      ["tap_commit", "tapCommit"],
      ["kandelo_repository", "kandeloRepository"],
      ["kandelo_commit", "kandeloCommit"],
      ["formula_sha256", "formulaSha256"],
    ] as const) {
      expectEqual(imageBuiltFrom[imageKey], guestBuiltFrom[guestKey], `${fullName} builtFrom.${imageKey}`);
    }
    requireLowerHex(guestBuiltFrom, "tap_commit", 40, `${fullName} built_from`);
    requireLowerHex(guestBuiltFrom, "kandelo_commit", 40, `${fullName} built_from`);
    requireLowerHex(guestBuiltFrom, "formula_sha256", 64, `${fullName} built_from`);
  });
}

function assertLockedRootVersions(
  lockedPackages: Record<string, unknown>[],
  guestPackages: Record<string, unknown>[],
  tapName: string,
): void {
  const guestByFullName = new Map(
    guestPackages.map((entry, index) => [
      requiredString(entry, "full_name", `guest Homebrew packages[${index}]`),
      entry,
    ]),
  );
  lockedPackages.forEach((entry, index) => {
    const formula = requiredRecord(entry.formula, `migration lock package ${index} formula`);
    const name = requiredString(formula, "name", `migration lock package ${index} formula`);
    const version = requiredString(formula, "version", `migration lock package ${index} formula`);
    const revision = requiredNonNegativeInteger(
      formula,
      "revision",
      `migration lock package ${index} formula`,
    );
    const rebuild = requiredNonNegativeInteger(
      formula,
      "bottle_rebuild",
      `migration lock package ${index} formula`,
    );
    const fullName = `${tapName}/${name}`;
    const guest = guestByFullName.get(fullName);
    if (guest === undefined) fail(`guest image omits locked root ${fullName}`);
    const kegVersion = revision === 0 ? version : `${version}_${revision}`;
    expectEqual(guest.version, kegVersion, `${fullName} locked version`);
    expectEqual(
      guest.link_manifest,
      `Kandelo/link/${name}-${kegVersion}-rebuild${rebuild}-${EXPECTED_ARCH}.json`,
      `${fullName} locked link_manifest`,
    );
  });
}

function assertCatalog(
  actual: Record<string, unknown>,
  expected: { tapRepository: string; tapName: string; tapCommit: string },
  label: string,
  style: "snake" | "camel",
): void {
  const repositoryKey = style === "snake" ? "tap_repository" : "tapRepository";
  const nameKey = style === "snake" ? "tap_name" : "tapName";
  const commitKey = style === "snake" ? "checkout_commit" : "checkoutCommit";
  expectEqual(actual[repositoryKey], expected.tapRepository, `${label} ${repositoryKey}`);
  expectEqual(actual[nameKey], expected.tapName, `${label} ${nameKey}`);
  expectEqual(actual[commitKey], expected.tapCommit, `${label} ${commitKey}`);
}

function assertLockBinding(
  actual: Record<string, unknown>,
  input: MainShellImageContractInput,
  label: string,
): void {
  expectEqual(actual.sha256, input.migrationLockSha256, `${label} sha256`);
  expectEqual(actual.bytes, input.migrationLockBytes, `${label} bytes`);
}

function assertPackageClosure(
  packages: Record<string, unknown>[],
  formulaClosure: string[],
  tapRepository: string,
  tapName: string,
  style: "snake" | "camel",
): void {
  const label = style === "snake" ? "guest Homebrew packages" : "VFS metadata packages";
  const fullNameKey = style === "snake" ? "full_name" : "fullName";
  const tapRepositoryKey = style === "snake" ? "tap_repository" : "tapRepository";
  const tapNameKey = style === "snake" ? "tap_name" : "tapName";
  const sourceStatusKey = style === "snake" ? "source_status" : "sourceStatus";
  const fullNames = packages.map((entry, index) =>
    requiredString(entry, fullNameKey, `${label}[${index}]`)
  );
  assertUnique(fullNames, label);
  expectExactStrings(
    [...fullNames].sort(),
    [...formulaClosure].sort(),
    `${label} exact closure`,
  );
  packages.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    expectEqual(entry[tapRepositoryKey], tapRepository, `${entryLabel} ${tapRepositoryKey}`);
    expectEqual(entry[tapNameKey], tapName, `${entryLabel} ${tapNameKey}`);
    expectEqual(entry.arch, EXPECTED_ARCH, `${entryLabel} arch`);
    expectEqual(entry[sourceStatusKey], "success", `${entryLabel} ${sourceStatusKey}`);
    requireLowerHex(entry, style === "snake" ? "tap_commit" : "tapCommit", 40, entryLabel);
    requiredString(entry, "version", entryLabel);
    requireLowerHex(
      entry,
      style === "snake" ? "cache_key_sha" : "cacheKeySha",
      64,
      entryLabel,
    );
    if (style === "snake") {
      expectEqual(entry.metadata_status, "success", `${entryLabel} metadata_status`);
      const url = requiredString(entry, "url", entryLabel);
      const sha256 = requireLowerHex(entry, "sha256", 64, entryLabel);
      const packageName = requiredString(entry, "name", entryLabel);
      const expectedUrl = `https://ghcr.io/v2/${tapRepository}/${packageName}/blobs/sha256:${sha256}`;
      if (url !== expectedUrl) {
        fail(`${entryLabel} url is ${JSON.stringify(url)}, expected ${expectedUrl}`);
      }
      requiredPositiveInteger(entry, "bytes", entryLabel);
    }
  });
}

function requiredNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} ${key} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireLowerHex(
  record: Record<string, unknown>,
  key: string,
  length: number,
  label: string,
): string {
  const value = requiredString(record, key, label);
  if (value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    fail(`${label} ${key} must be ${length} lowercase hexadecimal characters`);
  }
  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((entry, index) => requiredRecord(entry, `${label}[${index}]`));
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} ${key} must be a non-empty string`);
  }
  return value;
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${label} must be an array of strings`);
  }
  return value as string[];
}

function requiredPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${label} ${key} must be a positive safe integer`);
  }
  return value as number;
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    fail(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function expectExactStrings(actual: string[], expected: string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(
      `${label} differs from the reviewed lock: ` +
        `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
    );
  }
}

function expectExactBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (
    actual.byteLength !== expected.byteLength ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(
      `${label} differ: actual_sha256=${createHash("sha256").update(actual).digest("hex")} ` +
        `expected_sha256=${createHash("sha256").update(expected).digest("hex")}`,
    );
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} contains a duplicate identity`);
}

function fail(message: string): never {
  throw new Error(`Homebrew main-shell image contract: ${message}`);
}
