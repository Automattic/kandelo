/**
 * Exercise the installed Python and Erlang commands from a composed Homebrew
 * VFS image. The smoke intentionally supplies only ordinary shell environment
 * variables: language-specific prefix and boot overrides would hide broken
 * bottle layouts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { NodeKernelHost } from "../host/src/node-kernel-host";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import {
  LANGUAGE_RUNTIME_INVOCATIONS,
  LANGUAGE_RUNTIME_REQUESTED_PACKAGES,
  type LanguageRuntimeInvocation,
} from "./homebrew-language-runtime-contract";

const HOMEBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core";
const TAP_NAME = "kandelo-dev/tap-core";
const KANDELO_REPOSITORY = "Automattic/kandelo";
const RELEASE_TAG = "bottles-abi-v41";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const SHA256_RE = /^[0-9a-f]{64}$/;

const CLEAN_ENV = [
  "HOME=/tmp",
  `PATH=${HOMEBREW_PREFIX}/bin:/usr/bin:/bin`,
  "TMPDIR=/tmp",
  "USER=user",
];

export interface LanguageRuntimeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LanguageRuntimeExpectation {
  label: string;
  expectedStdout: string;
}

export function validateLanguageRuntimeResult(
  expectation: LanguageRuntimeExpectation,
  result: LanguageRuntimeResult,
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${expectation.label} exited ${result.exitCode}; stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  if (result.stderr !== "") {
    throw new Error(
      `${expectation.label} wrote unexpected stderr: ${JSON.stringify(result.stderr)}`,
    );
  }
  if (result.stdout !== expectation.expectedStdout) {
    throw new Error(
      `${expectation.label} stdout ${JSON.stringify(result.stdout)} did not equal ` +
        JSON.stringify(expectation.expectedStdout),
    );
  }
}

interface CliOptions {
  imagePath: string;
  kernelPath: string;
  metadataPath: string;
  reportPath: string;
  expectationPath: string;
  expectedImageSha256: string;
  expectedKernelSha256: string;
  expectedMetadataSha256: string;
  expectedReportSha256: string;
  expectedExpectationSha256: string;
  timeoutMs: number;
}

export interface CompositionPackageExpectation {
  name: string;
  version: string;
  formulaRevision: number;
  bottleRebuild: number;
  cacheKeySha: string;
  formulaSha256: string;
  builtFromTapCommit: string;
  builtFromKandeloCommit: string;
  builtBy: string;
  provenanceKind: "published" | "local-synthetic";
}

export interface CompositionExpectation {
  tapCommit: string;
  kandeloCommit: string;
  packages: CompositionPackageExpectation[];
}

interface OutputCapture {
  label: string;
  stdout: string;
  stderr: string;
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    fs.read(fd, bytes, null, bytes.byteLength);
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function expectValue(
  record: Record<string, unknown>,
  key: string,
  expected: string | number,
  label: string,
): void {
  if (record[key] !== expected) {
    throw new Error(
      `${label}.${key} ${JSON.stringify(record[key])} did not equal ${JSON.stringify(expected)}`,
    );
  }
}

function expectStringArray(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(
      `${label} ${JSON.stringify(value)} did not equal ${JSON.stringify(expected)}`,
    );
  }
}

function uniqueNamedRecord(
  values: unknown[],
  name: string,
  label: string,
): Record<string, unknown> {
  const matches = values
    .map((value, index) => asRecord(value, `${label}[${index}]`))
    .filter((value) => value.name === name);
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one ${name} record`);
  }
  return matches[0];
}

function uniquePathRecord(
  values: Array<Record<string, unknown>>,
  path: string,
  label: string,
): Record<string, unknown> {
  const matches = values.filter((value) => value.path === path);
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one ${path} record`);
  }
  return matches[0];
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a nonempty string`);
  }
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label}.${key} must be a nonnegative integer`);
  }
  return value as number;
}

export function parseCompositionExpectation(
  value: unknown,
): CompositionExpectation {
  const root = asRecord(value, "composition expectation");
  expectValue(root, "schema", 1, "composition expectation");
  const tapCommit = requiredString(
    root,
    "tap_commit",
    "composition expectation",
  );
  if (!/^[0-9a-f]{40}$/.test(tapCommit)) {
    throw new Error(
      "composition expectation.tap_commit must be a full Git SHA",
    );
  }
  const kandeloCommit = requiredString(
    root,
    "kandelo_commit",
    "composition expectation",
  );
  if (!/^[0-9a-f]{40}$/.test(kandeloCommit)) {
    throw new Error(
      "composition expectation.kandelo_commit must be a full Git SHA",
    );
  }
  const expectedVersions = new Map<string, readonly [string, number, number]>([
    ["dash", ["0.5.12", 0, 0]],
    ["zlib", ["1.3.1_4", 4, 1]],
    ["python", ["3.13.3_1", 1, 0]],
    ["erlang", ["28.2_1", 1, 0]],
  ] as const);
  const packages = asArray(
    root.packages,
    "composition expectation.packages",
  ).map((value, index): CompositionPackageExpectation => {
    const label = `composition expectation.packages[${index}]`;
    const pkg = asRecord(value, label);
    const name = requiredString(pkg, "name", label);
    const contract = expectedVersions.get(name);
    if (!contract)
      throw new Error(`${label}.name is not in the runtime closure: ${name}`);
    const version = requiredString(pkg, "version", label);
    const formulaRevision = requiredInteger(pkg, "formula_revision", label);
    const bottleRebuild = requiredInteger(pkg, "bottle_rebuild", label);
    if (
      version !== contract[0] ||
      formulaRevision !== contract[1] ||
      bottleRebuild !== contract[2]
    ) {
      throw new Error(
        `${label} version/revision/rebuild does not match ${name} runtime contract`,
      );
    }
    const cacheKeySha = requiredString(pkg, "cache_key_sha", label);
    const formulaSha256 = requiredString(pkg, "formula_sha256", label);
    if (!SHA256_RE.test(cacheKeySha) || !SHA256_RE.test(formulaSha256)) {
      throw new Error(
        `${label} bottle and formula hashes must be lowercase SHA-256 values`,
      );
    }
    const builtFromTapCommit = requiredString(
      pkg,
      "built_from_tap_commit",
      label,
    );
    if (!/^[0-9a-f]{40}$/.test(builtFromTapCommit)) {
      throw new Error(`${label}.built_from_tap_commit must be a full Git SHA`);
    }
    const builtFromKandeloCommit = requiredString(
      pkg,
      "built_from_kandelo_commit",
      label,
    );
    if (!/^[0-9a-f]{40}$/.test(builtFromKandeloCommit)) {
      throw new Error(
        `${label}.built_from_kandelo_commit must be a full Git SHA`,
      );
    }
    const builtBy = requiredString(pkg, "built_by", label);
    const provenanceKind = requiredString(pkg, "provenance_kind", label);
    if (
      provenanceKind !== "published" &&
      provenanceKind !== "local-synthetic"
    ) {
      throw new Error(`${label}.provenance_kind is invalid`);
    }
    const validLocalOrigin =
      /^https:\/\/localhost\.invalid\/kandelo\/[a-z0-9._/-]+$/.test(builtBy);
    const validPublishedOrigin =
      /^https:\/\/github\.com\/kandelo-dev\/homebrew-tap-core\/actions\/runs\/[1-9][0-9]*$/.test(
        builtBy,
      );
    if (
      (provenanceKind === "local-synthetic" && !validLocalOrigin) ||
      (provenanceKind === "published" && !validPublishedOrigin)
    ) {
      throw new Error(
        `${label}.built_by does not match its ${provenanceKind} provenance origin`,
      );
    }
    return {
      name,
      version,
      formulaRevision,
      bottleRebuild,
      cacheKeySha,
      formulaSha256,
      builtFromTapCommit,
      builtFromKandeloCommit,
      builtBy,
      provenanceKind,
    };
  });
  expectStringArray(
    packages.map(({ name }) => name),
    ["dash", "zlib", "python", "erlang"],
    "composition expectation package names",
  );
  for (const pkg of packages) {
    if (
      (pkg.name === "python" || pkg.name === "erlang") &&
      pkg.builtFromTapCommit !== tapCommit
    ) {
      throw new Error(
        `composition expectation package ${pkg.name}.built_from_tap_commit must equal tap_commit`,
      );
    }
    if (
      (pkg.name === "python" || pkg.name === "erlang") &&
      pkg.builtFromKandeloCommit !== kandeloCommit
    ) {
      throw new Error(
        `composition expectation package ${pkg.name}.built_from_kandelo_commit must equal kandelo_commit`,
      );
    }
  }
  return { tapCommit, kandeloCommit, packages };
}

export function validateComposition(
  metadataValue: unknown,
  reportValue: unknown,
  expectation: CompositionExpectation,
): void {
  const metadata = asRecord(metadataValue, "Homebrew metadata");
  expectValue(metadata, "schema", 1, "Homebrew metadata");
  expectValue(metadata, "tap_repository", TAP_REPOSITORY, "Homebrew metadata");
  expectValue(metadata, "tap_name", TAP_NAME, "Homebrew metadata");
  expectValue(
    metadata,
    "tap_commit",
    expectation.tapCommit,
    "Homebrew metadata",
  );
  expectValue(metadata, "kandelo_abi", 41, "Homebrew metadata");
  expectValue(
    metadata,
    "kandelo_repository",
    KANDELO_REPOSITORY,
    "Homebrew metadata",
  );
  expectValue(
    metadata,
    "kandelo_commit",
    expectation.kandeloCommit,
    "Homebrew metadata",
  );
  expectValue(metadata, "release_tag", RELEASE_TAG, "Homebrew metadata");
  const metadataPackages = asArray(
    metadata.packages,
    "Homebrew metadata.packages",
  );

  const report = asRecord(reportValue, "Homebrew VFS report");
  const reportMetadata = asRecord(
    report.metadata,
    "Homebrew VFS report.metadata",
  );
  expectValue(
    reportMetadata,
    "tap_repository",
    TAP_REPOSITORY,
    "Homebrew VFS report.metadata",
  );
  expectValue(
    reportMetadata,
    "tap_name",
    TAP_NAME,
    "Homebrew VFS report.metadata",
  );
  expectValue(
    reportMetadata,
    "tap_commit",
    expectation.tapCommit,
    "Homebrew VFS report.metadata",
  );
  expectValue(
    reportMetadata,
    "kandelo_abi",
    41,
    "Homebrew VFS report.metadata",
  );
  expectValue(
    reportMetadata,
    "kandelo_repository",
    KANDELO_REPOSITORY,
    "Homebrew VFS report.metadata",
  );
  expectValue(
    reportMetadata,
    "kandelo_commit",
    expectation.kandeloCommit,
    "Homebrew VFS report.metadata",
  );
  expectValue(
    reportMetadata,
    "release_tag",
    RELEASE_TAG,
    "Homebrew VFS report.metadata",
  );
  const selection = asRecord(report.selection, "Homebrew VFS report.selection");
  expectValue(selection, "kind", "packages", "Homebrew VFS report.selection");
  expectStringArray(
    selection.requested_packages,
    LANGUAGE_RUNTIME_REQUESTED_PACKAGES,
    "Homebrew VFS report.selection.requested_packages",
  );
  const reportPackages = asArray(
    report.packages,
    "Homebrew VFS report.packages",
  );
  if (reportPackages.length !== expectation.packages.length) {
    throw new Error(
      `Homebrew VFS report has ${reportPackages.length} packages, expected ${expectation.packages.length}`,
    );
  }
  expectStringArray(
    reportPackages.map(
      (value, index) =>
        asRecord(value, `Homebrew VFS report.packages[${index}]`).name,
    ),
    expectation.packages.map(({ name }) => name),
    "Homebrew VFS report package names",
  );

  for (const expected of expectation.packages) {
    const metadataPackage = uniqueNamedRecord(
      metadataPackages,
      expected.name,
      "Homebrew metadata.packages",
    );
    expectValue(
      metadataPackage,
      "full_name",
      `${TAP_NAME}/${expected.name}`,
      `Homebrew metadata package ${expected.name}`,
    );
    expectValue(
      metadataPackage,
      "version",
      expected.version,
      `Homebrew metadata package ${expected.name}`,
    );
    expectValue(
      metadataPackage,
      "formula_revision",
      expected.formulaRevision,
      `Homebrew metadata package ${expected.name}`,
    );
    expectValue(
      metadataPackage,
      "bottle_rebuild",
      expected.bottleRebuild,
      `Homebrew metadata package ${expected.name}`,
    );
    const metadataBottle = asArray(
      metadataPackage.bottles,
      `Homebrew metadata package ${expected.name}.bottles`,
    )
      .map((value, index) =>
        asRecord(
          value,
          `Homebrew metadata package ${expected.name}.bottles[${index}]`,
        ),
      )
      .filter((value) => value.arch === "wasm32");
    if (metadataBottle.length !== 1) {
      throw new Error(
        `Homebrew metadata package ${expected.name} must have one wasm32 bottle`,
      );
    }
    expectValue(
      metadataBottle[0],
      "cache_key_sha",
      expected.cacheKeySha,
      `Homebrew metadata package ${expected.name} bottle`,
    );
    expectValue(
      metadataBottle[0],
      "sha256",
      expected.cacheKeySha,
      `Homebrew metadata package ${expected.name} bottle`,
    );
    expectValue(
      metadataBottle[0],
      "built_by",
      expected.builtBy,
      `Homebrew metadata package ${expected.name} bottle`,
    );
    expectValue(
      metadataBottle[0],
      "url",
      `https://ghcr.io/v2/${TAP_REPOSITORY}/${expected.name}/blobs/sha256:${expected.cacheKeySha}`,
      `Homebrew metadata package ${expected.name} bottle`,
    );
    const metadataBuiltFrom = asRecord(
      metadataBottle[0].built_from,
      `Homebrew metadata package ${expected.name} bottle.built_from`,
    );
    expectValue(
      metadataBuiltFrom,
      "tap_repository",
      TAP_REPOSITORY,
      `Homebrew metadata package ${expected.name} bottle.built_from`,
    );
    expectValue(
      metadataBuiltFrom,
      "tap_commit",
      expected.builtFromTapCommit,
      `Homebrew metadata package ${expected.name} bottle.built_from`,
    );
    expectValue(
      metadataBuiltFrom,
      "formula_sha256",
      expected.formulaSha256,
      `Homebrew metadata package ${expected.name} bottle.built_from`,
    );
    expectValue(
      metadataBuiltFrom,
      "kandelo_repository",
      KANDELO_REPOSITORY,
      `Homebrew metadata package ${expected.name} bottle.built_from`,
    );
    expectValue(
      metadataBuiltFrom,
      "kandelo_commit",
      expected.builtFromKandeloCommit,
      `Homebrew metadata package ${expected.name} bottle.built_from`,
    );

    const reportPackage = uniqueNamedRecord(
      reportPackages,
      expected.name,
      "Homebrew VFS report.packages",
    );
    expectValue(
      reportPackage,
      "full_name",
      `${TAP_NAME}/${expected.name}`,
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "tap_repository",
      TAP_REPOSITORY,
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "tap_name",
      TAP_NAME,
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "tap_commit",
      expected.builtFromTapCommit,
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "version",
      expected.version,
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "cache_key_sha",
      expected.cacheKeySha,
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "sha256",
      expected.cacheKeySha,
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "arch",
      "wasm32",
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "url",
      `https://ghcr.io/v2/${TAP_REPOSITORY}/${expected.name}/blobs/sha256:${expected.cacheKeySha}`,
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "prefix",
      HOMEBREW_PREFIX,
      `Homebrew VFS report package ${expected.name}`,
    );
    expectValue(
      reportPackage,
      "keg",
      `${HOMEBREW_PREFIX}/Cellar/${expected.name}/${expected.version}`,
      `Homebrew VFS report package ${expected.name}`,
    );
    const reportBuiltFrom = asRecord(
      reportPackage.built_from,
      `Homebrew VFS report package ${expected.name}.built_from`,
    );
    expectValue(
      reportBuiltFrom,
      "tap_repository",
      TAP_REPOSITORY,
      `Homebrew VFS report package ${expected.name}.built_from`,
    );
    expectValue(
      reportBuiltFrom,
      "tap_commit",
      expected.builtFromTapCommit,
      `Homebrew VFS report package ${expected.name}.built_from`,
    );
    expectValue(
      reportBuiltFrom,
      "formula_sha256",
      expected.formulaSha256,
      `Homebrew VFS report package ${expected.name}.built_from`,
    );
    expectValue(
      reportBuiltFrom,
      "kandelo_repository",
      KANDELO_REPOSITORY,
      `Homebrew VFS report package ${expected.name}.built_from`,
    );
    expectValue(
      reportBuiltFrom,
      "kandelo_commit",
      expected.builtFromKandeloCommit,
      `Homebrew VFS report package ${expected.name}.built_from`,
    );
  }

  const compatibilityLinks = asArray(
    report.compatibility_links,
    "Homebrew VFS report.compatibility_links",
  ).map((value, index) =>
    asRecord(value, `Homebrew VFS report.compatibility_links[${index}]`),
  );
  const expectedCompatibilityLinks = [
    ["/bin/dash", "dash", "dash"],
    ["/usr/bin/dash", "dash", "dash"],
    ["/bin/sh", "dash", "dash"],
    ["/usr/bin/sh", "dash", "dash"],
    ["/bin/python", "python", "python"],
    ["/usr/bin/python", "python", "python"],
    ["/bin/python3", "python", "python3"],
    ["/usr/bin/python3", "python", "python3"],
    ["/bin/python3.13", "python", "python3.13"],
    ["/usr/bin/python3.13", "python", "python3.13"],
    ["/bin/erl", "erlang", "erl"],
    ["/usr/bin/erl", "erlang", "erl"],
  ] as const;
  for (const [path, packageName, targetName] of expectedCompatibilityLinks) {
    const link = uniquePathRecord(
      compatibilityLinks,
      path,
      "Homebrew VFS report.compatibility_links",
    );
    expectValue(
      link,
      "package",
      `kandelo-dev/tap-core/${packageName}`,
      `Homebrew VFS report compatibility link ${path}`,
    );
    expectValue(
      link,
      "target",
      `${HOMEBREW_PREFIX}/bin/${targetName}`,
      `Homebrew VFS report compatibility link ${path}`,
    );
  }
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--image",
    "--kernel",
    "--metadata",
    "--report",
    "--expectation",
    "--expected-image-sha256",
    "--expected-kernel-sha256",
    "--expected-metadata-sha256",
    "--expected-report-sha256",
    "--expected-expectation-sha256",
    "--timeout-ms",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || value === undefined || values.has(flag)) {
      usage(`invalid or repeated option ${String(flag)}`);
    }
    values.set(flag, value);
  }
  const imagePath = values.get("--image");
  const kernelPath = values.get("--kernel");
  const metadataPath = values.get("--metadata");
  const reportPath = values.get("--report");
  const expectationPath = values.get("--expectation");
  if (!imagePath) usage("missing --image");
  if (!kernelPath) usage("missing --kernel");
  if (!metadataPath) usage("missing --metadata");
  if (!reportPath) usage("missing --report");
  if (!expectationPath) usage("missing --expectation");
  const requiredDigests = [
    ["--expected-image-sha256", "expectedImageSha256"],
    ["--expected-kernel-sha256", "expectedKernelSha256"],
    ["--expected-metadata-sha256", "expectedMetadataSha256"],
    ["--expected-report-sha256", "expectedReportSha256"],
    ["--expected-expectation-sha256", "expectedExpectationSha256"],
  ] as const;
  const digests: Record<(typeof requiredDigests)[number][1], string> = {
    expectedImageSha256: "",
    expectedKernelSha256: "",
    expectedMetadataSha256: "",
    expectedReportSha256: "",
    expectedExpectationSha256: "",
  };
  for (const [flag, key] of requiredDigests) {
    const value = values.get(flag);
    if (!value) usage(`missing ${flag}`);
    if (!SHA256_RE.test(value)) usage(`${flag} must be a lowercase SHA-256`);
    digests[key] = value;
  }
  const timeoutText = values.get("--timeout-ms") ?? String(DEFAULT_TIMEOUT_MS);
  if (!/^[1-9][0-9]*$/.test(timeoutText))
    usage("--timeout-ms must be a positive integer");
  const timeoutMs = Number(timeoutText);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 600_000) {
    usage("--timeout-ms must not exceed 600000");
  }
  return {
    imagePath,
    kernelPath,
    metadataPath,
    reportPath,
    expectationPath,
    ...digests,
    timeoutMs,
  };
}

function usage(message: string): never {
  throw new Error(
    `homebrew-language-runtime-smoke: ${message}; usage: npx tsx ` +
      "scripts/homebrew-language-runtime-smoke.ts --image <rootfs.vfs[.zst]> " +
      "--kernel <kernel.wasm> --metadata <Kandelo/metadata.json> " +
      "--report <image-report.json> --expectation <expectation.json> " +
      "--expected-image-sha256 <sha256> " +
      "--expected-kernel-sha256 <sha256> --expected-metadata-sha256 <sha256> " +
      "--expected-report-sha256 <sha256> --expected-expectation-sha256 <sha256> " +
      "[--timeout-ms <milliseconds>]",
  );
}

async function runInvocation(
  host: NodeKernelHost,
  imageFs: MemoryFileSystem,
  invocation: LanguageRuntimeInvocation,
  timeoutMs: number,
  capture: OutputCapture,
): Promise<LanguageRuntimeResult> {
  capture.label = invocation.label;
  capture.stdout = "";
  capture.stderr = "";

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      host.spawn(
        toArrayBuffer(readVfsFile(imageFs, invocation.executable)),
        invocation.argv,
        { cwd: "/", env: CLEAN_ENV, stdin: new Uint8Array() },
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${invocation.label} timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }),
    ]);
    return { exitCode, stdout: capture.stdout, stderr: capture.stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const imageBytes = new Uint8Array(readFileSync(resolve(options.imagePath)));
  const kernelBytes = new Uint8Array(readFileSync(resolve(options.kernelPath)));
  const metadataBytes = new Uint8Array(
    readFileSync(resolve(options.metadataPath)),
  );
  const reportBytes = new Uint8Array(readFileSync(resolve(options.reportPath)));
  const expectationBytes = new Uint8Array(
    readFileSync(resolve(options.expectationPath)),
  );
  const evidence = [
    ["image", imageBytes, options.expectedImageSha256],
    ["kernel", kernelBytes, options.expectedKernelSha256],
    ["metadata", metadataBytes, options.expectedMetadataSha256],
    ["report", reportBytes, options.expectedReportSha256],
    ["expectation", expectationBytes, options.expectedExpectationSha256],
  ] as const;
  for (const [label, bytes, expected] of evidence) {
    const actual = sha256(bytes);
    if (actual !== expected) {
      throw new Error(`${label} sha256 ${actual} did not equal ${expected}`);
    }
    console.log(`Homebrew runtime ${label} sha256: ${actual}`);
  }
  const expectation = parseCompositionExpectation(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(expectationBytes),
    ),
  );
  validateComposition(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes)),
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportBytes)),
    expectation,
  );
  console.log(`Homebrew runtime tap commit: ${expectation.tapCommit}`);
  console.log(
    `Homebrew runtime roots: ${LANGUAGE_RUNTIME_REQUESTED_PACKAGES.join(",")}`,
  );

  const imageFs = MemoryFileSystem.fromImagePreservingCapacity(imageBytes);
  const capture: OutputCapture = {
    label: "language runtime",
    stdout: "",
    stderr: "",
  };
  const append = (
    current: string,
    bytes: Uint8Array,
    stream: string,
  ): string => {
    const next = current + new TextDecoder().decode(bytes);
    if (new TextEncoder().encode(next).byteLength > MAX_OUTPUT_BYTES) {
      throw new Error(
        `${capture.label} ${stream} exceeded ${MAX_OUTPUT_BYTES} bytes`,
      );
    }
    return next;
  };
  const host = new NodeKernelHost({
    maxWorkers: 4,
    rootfsImage: imageBytes,
    onStdout: (_pid, bytes) => {
      capture.stdout = append(capture.stdout, bytes, "stdout");
    },
    onStderr: (_pid, bytes) => {
      capture.stderr = append(capture.stderr, bytes, "stderr");
    },
  });
  await host.init(toArrayBuffer(kernelBytes));
  try {
    for (const invocation of LANGUAGE_RUNTIME_INVOCATIONS) {
      const result = await runInvocation(
        host,
        imageFs,
        invocation,
        options.timeoutMs,
        capture,
      );
      validateLanguageRuntimeResult(invocation, result);
      console.log(`${invocation.label}: ok`);
    }
  } finally {
    await host.destroy().catch(() => {});
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
