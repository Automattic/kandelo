import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  homebrewBottleSelectionSha256,
  parseCanonicalHomebrewBottleSelection,
  type HomebrewBottleSelection,
} from "../../host/src/homebrew-bottle-selection";
import { resolveHomebrewVfsResourcePolicy } from
  "../../host/src/homebrew-vfs-resource-policy";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import {
  validateHomebrewFlatVfsEmbeddedRuntime,
  type HomebrewFlatVfsEmbeddedRuntimeInput,
  type HomebrewFlatVfsShippingProofResult,
} from "./homebrew_flat_vfs_shipping_proof";
import {
  buildHomebrewFlatVfsProofEvidence,
  encodeHomebrewFlatVfsProofEvidence,
  type HomebrewFlatVfsProofEvidence,
  type HomebrewFlatVfsProofFileIdentity,
} from "./homebrew_flat_vfs_proof_evidence";

const TAP_REVISION_RE = /^[0-9a-f]{40}$/;
const MAX_SELECTION_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_KERNEL_BYTES = 64 * 1024 * 1024;
const COMPOSITION_REPORT_PATH = "/etc/kandelo/homebrew-vfs.json";
const SHELL_CONFIG_PATH = "/etc/kandelo/shell.json";
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;

export interface HomebrewFlatVfsProofInputPaths {
  imagePath: string;
  selectionPath: string;
  reportPath: string;
  kernelPath: string;
  tapRoot: string;
  tapRevision: string;
  selectionSourcePath?: string;
}

export interface LoadedHomebrewFlatVfsProofInputIdentity {
  tapRevision: string;
  selectionSha256: string;
  image: HomebrewFlatVfsProofFileIdentity;
  report: HomebrewFlatVfsProofFileIdentity;
  kernel: HomebrewFlatVfsProofFileIdentity;
  imagePath: string;
  selectionPath: string;
  reportPath: string;
  kernelPath: string;
  requestedVfsFilename: string;
  shellPath: string;
  shellArgv0: string;
}

export interface LoadedHomebrewFlatVfsProofRuntimeInput
  extends LoadedHomebrewFlatVfsProofInputIdentity {
  runtime: HomebrewFlatVfsEmbeddedRuntimeInput;
  kernelWasmBytes: ArrayBuffer;
}

interface FlatHomebrewVfsArtifactReport {
  schema: 1;
  selection: FileBinding & { name: string };
  base_image: FileBinding & { kernel_abi: number };
  shell_config: FileBinding & { path: string; argv: string[] };
  bottle_cache: {
    entries: Array<FileBinding & { full_name: string }>;
  };
  image: FileBinding & {
    filename: string;
    capacity: { byte_length: number; max_byte_length: number };
  };
  build_report: Record<string, unknown>;
}

interface FileBinding {
  sha256: string;
  bytes: number;
}

export function readHomebrewFlatVfsRequestedImageFilename(
  selectionPath: string,
): string {
  const bytes = readBoundedRegularFile(
    resolve(selectionPath),
    "flat Homebrew VFS selection",
    MAX_SELECTION_BYTES,
  );
  return parseCanonicalHomebrewBottleSelection(bytes, {
    expectedAbi: 42,
  }).requestedVfsFilename;
}

export function loadHomebrewFlatVfsProofInputs(
  paths: HomebrewFlatVfsProofInputPaths,
  options: { includeRuntimeBytes: true },
): LoadedHomebrewFlatVfsProofRuntimeInput;
export function loadHomebrewFlatVfsProofInputs(
  paths: HomebrewFlatVfsProofInputPaths,
  options?: { includeRuntimeBytes?: false },
): LoadedHomebrewFlatVfsProofInputIdentity;
export function loadHomebrewFlatVfsProofInputs(
  paths: HomebrewFlatVfsProofInputPaths,
  options: { includeRuntimeBytes?: boolean } = {},
): LoadedHomebrewFlatVfsProofInputIdentity |
  LoadedHomebrewFlatVfsProofRuntimeInput {
  assertExactTapCheckout(paths.tapRoot, paths.tapRevision);
  const selectionPath = resolve(paths.selectionPath);
  const reportPath = resolve(paths.reportPath);
  const kernelPath = resolve(paths.kernelPath);
  const imagePath = resolve(paths.imagePath);
  const selectionBytes = readBoundedRegularFile(
    selectionPath,
    "flat Homebrew VFS selection",
    MAX_SELECTION_BYTES,
  );
  if (paths.selectionSourcePath !== undefined) {
    const selectionSourceBytes = readBoundedRegularFile(
      resolve(paths.selectionSourcePath),
      "flat Homebrew VFS tap selection",
      MAX_SELECTION_BYTES,
    );
    if (!bytesEqual(selectionBytes, selectionSourceBytes)) {
      throw new Error(
        "flat Homebrew VFS selection bytes do not match the exact tap input",
      );
    }
  }
  const selection = parseCanonicalHomebrewBottleSelection(selectionBytes, {
    expectedAbi: 42,
  });
  if (selection.arch !== "wasm32") {
    throw new Error("flat Homebrew VFS selection must target wasm32");
  }
  if (basename(imagePath) !== selection.requestedVfsFilename) {
    throw new Error(
      "flat Homebrew VFS image filename does not match the selection",
    );
  }
  const selectionSha256 = homebrewBottleSelectionSha256(selectionBytes);
  const reportBytes = readBoundedRegularFile(
    reportPath,
    "flat Homebrew VFS build report",
    MAX_REPORT_BYTES,
  );
  const kernelRegularPath = resolvePackageOwnedKernelMirror(kernelPath);
  const kernelBytes = readBoundedRegularFile(
    kernelRegularPath,
    "flat Homebrew VFS kernel",
    MAX_KERNEL_BYTES,
  );
  const imageBytes = readBoundedRegularFile(
    imagePath,
    "flat Homebrew VFS image",
    resolveHomebrewVfsResourcePolicy(selection.resourcePolicy).vfs.maxByteLength,
  );
  const report = parseFlatHomebrewVfsArtifactReport(reportBytes);
  const imageIdentity = fileIdentity(imageBytes);
  assertEqual(
    report.selection.sha256,
    selectionSha256,
    "artifact report selection SHA-256",
  );
  assertEqual(
    report.selection.bytes,
    selectionBytes.byteLength,
    "artifact report selection bytes",
  );
  assertEqual(
    report.selection.name,
    selection.name,
    "artifact report selection name",
  );
  assertEqual(
    report.image.filename,
    selection.requestedVfsFilename,
    "artifact report image filename",
  );
  assertEqual(
    report.image.sha256,
    imageIdentity.sha256,
    "artifact report image SHA-256",
  );
  assertEqual(
    report.image.bytes,
    imageIdentity.bytes,
    "artifact report image bytes",
  );
  assertBottleCacheBindings(report.bottle_cache.entries, selection.bottles);

  const fs = MemoryFileSystem.fromImage(imageBytes);
  assertArtifactReportImageBindings(fs, imageBytes, report, selection);
  const embeddedReportBytes = readBoundedVfsRegularFile(
    fs,
    COMPOSITION_REPORT_PATH,
    MAX_REPORT_BYTES,
  );
  if (!bytesEqual(prettyJsonBytes(report.build_report), embeddedReportBytes)) {
    throw new Error(
      "flat Homebrew VFS build report does not match the image-owned report",
    );
  }
  assertBuildReportBindings(report.build_report, selection, selectionSha256);
  const runtime: HomebrewFlatVfsEmbeddedRuntimeInput = {
    imageBytes,
    shellPath: report.shell_config.path,
    shellArgv0: report.shell_config.argv[0]!,
  };
  const validatedRuntime = validateHomebrewFlatVfsEmbeddedRuntime(runtime);
  if (validatedRuntime.kandeloAbi !== 42) {
    throw new Error("flat Homebrew VFS image must use Kandelo ABI 42");
  }
  if (validatedRuntime.selectionSha256 !== selectionSha256) {
    throw new Error(
      "flat Homebrew VFS selection SHA-256 does not match the image report",
    );
  }
  const identity: LoadedHomebrewFlatVfsProofInputIdentity = {
    tapRevision: paths.tapRevision,
    selectionSha256,
    image: imageIdentity,
    report: fileIdentity(reportBytes),
    kernel: fileIdentity(kernelBytes),
    imagePath,
    selectionPath,
    reportPath,
    kernelPath,
    requestedVfsFilename: selection.requestedVfsFilename,
    shellPath: runtime.shellPath,
    shellArgv0: runtime.shellArgv0,
  };
  if (options.includeRuntimeBytes !== true) return identity;
  return {
    ...identity,
    runtime,
    kernelWasmBytes: wholeArrayBuffer(kernelBytes),
  };
}

function parseFlatHomebrewVfsArtifactReport(
  bytes: Uint8Array,
): FlatHomebrewVfsArtifactReport {
  const root = exactRecord(
    parseJsonObject(bytes, "flat Homebrew VFS artifact report"),
    [
      "schema",
      "selection",
      "base_image",
      "shell_config",
      "bottle_cache",
      "image",
      "build_report",
    ],
    "flat Homebrew VFS artifact report",
  );
  if (root.schema !== 1) {
    throw new Error("flat Homebrew VFS artifact report schema must be 1");
  }
  const selection = fileBindingWithString(
    root.selection,
    ["sha256", "bytes", "name"],
    "name",
    "artifact report selection",
  );
  const baseImage = exactRecord(
    root.base_image,
    ["sha256", "bytes", "kernel_abi"],
    "artifact report base image",
  );
  const base_image = {
    ...fileBinding(baseImage, "artifact report base image"),
    kernel_abi: positiveInteger(
      baseImage.kernel_abi,
      "artifact report base image kernel ABI",
    ),
  };
  const shell = exactRecord(
    root.shell_config,
    ["path", "argv", "sha256", "bytes"],
    "artifact report shell config",
  );
  const shell_config = {
    ...fileBinding(shell, "artifact report shell config"),
    path: nonemptyString(shell.path, "artifact report shell config path"),
    argv: stringArray(shell.argv, "artifact report shell config argv"),
  };
  if (shell_config.argv.length === 0) {
    throw new Error("artifact report shell config argv must not be empty");
  }
  const cache = exactRecord(
    root.bottle_cache,
    ["entries"],
    "artifact report bottle cache",
  );
  if (!Array.isArray(cache.entries) || cache.entries.length === 0) {
    throw new Error("artifact report bottle cache entries are invalid");
  }
  const bottle_cache = {
    entries: cache.entries.map((value, index) =>
      fileBindingWithString(
        value,
        ["full_name", "sha256", "bytes"],
        "full_name",
        `artifact report bottle cache entry ${index}`,
      )
    ),
  };
  const image = exactRecord(
    root.image,
    ["filename", "sha256", "bytes", "capacity"],
    "artifact report image",
  );
  const capacity = exactRecord(
    image.capacity,
    ["byte_length", "max_byte_length"],
    "artifact report image capacity",
  );
  const parsedImage = {
    ...fileBinding(image, "artifact report image"),
    filename: nonemptyString(image.filename, "artifact report image filename"),
    capacity: {
      byte_length: positiveInteger(
        capacity.byte_length,
        "artifact report image capacity byte length",
      ),
      max_byte_length: positiveInteger(
        capacity.max_byte_length,
        "artifact report image capacity maximum byte length",
      ),
    },
  };
  const build_report = exactRecord(
    root.build_report,
    [
      "schema",
      "name",
      "arch",
      "kandelo_abi",
      "selection_sha256",
      "requested_vfs_filename",
      "resource_policy",
      "link_policy",
      "runtime_support",
      "environment",
      "link_owners",
      "totals",
      "packages",
    ],
    "artifact report build report",
  );
  const parsed: FlatHomebrewVfsArtifactReport = {
    schema: 1,
    selection,
    base_image,
    shell_config,
    bottle_cache,
    image: parsedImage,
    build_report,
  };
  if (!bytesEqual(bytes, prettyJsonBytes(root))) {
    throw new Error(
      "flat Homebrew VFS artifact report bytes are not canonical pretty JSON",
    );
  }
  return parsed;
}

function assertBottleCacheBindings(
  entries: FlatHomebrewVfsArtifactReport["bottle_cache"]["entries"],
  bottles: HomebrewBottleSelection["bottles"],
): void {
  if (entries.length !== bottles.length) {
    throw new Error("artifact report bottle cache length does not match selection");
  }
  entries.forEach((entry, index) => {
    const bottle = bottles[index]!;
    assertEqual(
      entry.full_name,
      bottle.fullName,
      `artifact report bottle cache entry ${index} full name`,
    );
    assertEqual(
      entry.sha256,
      bottle.sha256,
      `artifact report bottle cache entry ${index} SHA-256`,
    );
    assertEqual(
      entry.bytes,
      bottle.bytes,
      `artifact report bottle cache entry ${index} bytes`,
    );
  });
}

function assertArtifactReportImageBindings(
  fs: MemoryFileSystem,
  imageBytes: Uint8Array,
  report: FlatHomebrewVfsArtifactReport,
  selection: HomebrewBottleSelection,
): void {
  const metadata = exactRecord(
    fs.getImageMetadata(),
    undefined,
    "flat Homebrew VFS image metadata",
  );
  assertEqual(metadata.kernelAbi, 42, "flat Homebrew VFS image metadata ABI");
  const base = exactRecord(
    metadata.baseImage,
    ["sha256", "bytes", "kernelAbi"],
    "flat Homebrew VFS image base binding",
  );
  assertEqual(
    report.base_image.sha256,
    sha256String(base.sha256, "flat Homebrew VFS image base SHA-256"),
    "artifact report base image SHA-256",
  );
  assertEqual(
    report.base_image.bytes,
    positiveInteger(base.bytes, "flat Homebrew VFS image base bytes"),
    "artifact report base image bytes",
  );
  assertEqual(
    report.base_image.kernel_abi,
    positiveInteger(base.kernelAbi, "flat Homebrew VFS image base ABI"),
    "artifact report base image ABI",
  );
  assertEqual(report.base_image.kernel_abi, 42, "artifact report base image ABI");

  const shell = exactRecord(
    metadata.shellConfig,
    ["path", "argv", "sha256", "bytes"],
    "flat Homebrew VFS image shell binding",
  );
  const shellBytes = readBoundedVfsRegularFile(fs, SHELL_CONFIG_PATH, 64 * 1024);
  const shellIdentity = fileIdentity(shellBytes);
  assertEqual(report.shell_config.path, shell.path, "artifact report shell config path");
  if (!sameStrings(report.shell_config.argv, shell.argv)) {
    throw new Error("artifact report shell config argv does not match image metadata");
  }
  assertEqual(
    report.shell_config.sha256,
    shellIdentity.sha256,
    "artifact report shell config SHA-256",
  );
  assertEqual(
    report.shell_config.bytes,
    shellIdentity.bytes,
    "artifact report shell config bytes",
  );
  assertEqual(shell.sha256, shellIdentity.sha256, "flat Homebrew VFS image shell SHA-256");
  assertEqual(shell.bytes, shellIdentity.bytes, "flat Homebrew VFS image shell bytes");

  const flat = exactRecord(
    metadata.homebrewFlat,
    ["selectionSha256", "requestedVfsFilename", "resourcePolicy"],
    "flat Homebrew VFS image selection binding",
  );
  assertEqual(
    flat.selectionSha256,
    report.selection.sha256,
    "flat Homebrew VFS image selection SHA-256",
  );
  assertEqual(
    flat.requestedVfsFilename,
    selection.requestedVfsFilename,
    "flat Homebrew VFS image requested filename",
  );
  assertEqual(
    flat.resourcePolicy,
    selection.resourcePolicy,
    "flat Homebrew VFS image resource policy",
  );
  const capacity = MemoryFileSystem.readImageCapacity(imageBytes);
  assertEqual(
    report.image.capacity.byte_length,
    capacity.byteLength,
    "artifact report image capacity byte length",
  );
  assertEqual(
    report.image.capacity.max_byte_length,
    capacity.maxByteLength,
    "artifact report image capacity maximum byte length",
  );
}

function assertBuildReportBindings(
  build: Record<string, unknown>,
  selection: HomebrewBottleSelection,
  selectionSha256: string,
): void {
  const expected: Array<[string, unknown]> = [
    ["schema", 1],
    ["name", selection.name],
    ["arch", "wasm32"],
    ["kandelo_abi", 42],
    ["selection_sha256", selectionSha256],
    ["requested_vfs_filename", selection.requestedVfsFilename],
    ["resource_policy", selection.resourcePolicy],
    ["link_policy", selection.linkPolicy],
    ["runtime_support", selection.runtimeSupport],
  ];
  for (const [key, value] of expected) {
    assertEqual(build[key], value, `artifact report build report ${key}`);
  }
  const environment = exactRecord(
    build.environment,
    ["PATH"],
    "artifact report build report environment",
  );
  assertEqual(
    environment.PATH,
    "/opt/kandelo/homebrew/bin",
    "artifact report build report PATH",
  );
  if (!Array.isArray(build.link_owners)) {
    throw new Error("artifact report build report link owners are invalid");
  }
  exactRecord(
    build.totals,
    ["compressed_bytes", "expanded_bytes", "entries", "path_bytes", "link_bytes"],
    "artifact report build report totals",
  );
  if (!Array.isArray(build.packages) || build.packages.length !== selection.bottles.length) {
    throw new Error("artifact report build report packages do not match selection");
  }
  build.packages.forEach((value, index) => {
    const pkg = exactRecord(value, undefined, `artifact report build package ${index}`);
    const bottle = selection.bottles[index]!;
    assertEqual(pkg.full_name, bottle.fullName, `artifact report build package ${index} full name`);
    assertEqual(pkg.sha256, bottle.sha256, `artifact report build package ${index} SHA-256`);
    assertEqual(pkg.bytes, bottle.bytes, `artifact report build package ${index} bytes`);
    assertEqual(pkg.arch, "wasm32", `artifact report build package ${index} arch`);
    assertEqual(pkg.kandelo_abi, 42, `artifact report build package ${index} ABI`);
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[] | undefined,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    keys !== undefined &&
    (Object.keys(record).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(record, key)))
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

function fileBinding(value: Record<string, unknown>, label: string): FileBinding {
  return {
    sha256: sha256String(value.sha256, `${label} SHA-256`),
    bytes: positiveInteger(value.bytes, `${label} bytes`),
  };
}

function fileBindingWithString<K extends string>(
  value: unknown,
  keys: readonly string[],
  stringKey: K,
  label: string,
): FileBinding & Record<K, string> {
  const record = exactRecord(value, keys, label);
  return {
    ...fileBinding(record, label),
    [stringKey]: nonemptyString(record[stringKey], `${label} ${stringKey}`),
  } as FileBinding & Record<K, string>;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function sha256String(value: unknown, label: string): string {
  const digest = nonemptyString(value, label);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${label} is invalid`);
  }
  return digest;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value] as string[];
}

function sameStrings(left: readonly string[], right: unknown): boolean {
  return Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} does not match the exact input`);
  }
}

function prettyJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function resolvePackageOwnedKernelMirror(kernelPath: string): string {
  let input;
  try {
    input = lstatSync(kernelPath);
  } catch (error) {
    throw new Error(
      `flat Homebrew VFS kernel is not accessible: ${String(error)}`,
    );
  }
  if (input.isFile() && !input.isSymbolicLink()) return kernelPath;
  if (!input.isSymbolicLink()) {
    throw new Error("flat Homebrew VFS kernel is not a regular file");
  }
  try {
    if (
      basename(kernelPath) !== "kernel.wasm" ||
      basename(dirname(kernelPath)) !== "local-binaries"
    ) {
      throw new Error("mirror path is not local-binaries/kernel.wasm");
    }
    const localBinaries = realpathSync(dirname(kernelPath));
    const namespace = join(
      localBinaries,
      ".kandelo-local-generations",
      "wasm32",
      "kernel",
    );
    assertRealDirectory(join(localBinaries, ".kandelo-local-generations"));
    assertRealDirectory(join(
      localBinaries,
      ".kandelo-local-generations",
      "wasm32",
    ));
    assertRealDirectory(namespace);
    if (realpathSync(namespace) !== namespace) {
      throw new Error("kernel generation namespace is redirected");
    }
    const member = realpathSync(kernelPath);
    const memberRelative = relative(namespace, member);
    const parts = memberRelative.split(sep);
    if (
      memberRelative.startsWith(`..${sep}`) ||
      parts.length !== 3 ||
      !/^[0-9a-f]{64}$/.test(parts[0]!) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[1]!) ||
      parts[2] !== "kandelo-kernel.wasm"
    ) {
      throw new Error("kernel member is outside the generation namespace");
    }
    const identityRoot = join(namespace, parts[0]!);
    const generation = join(identityRoot, parts[1]!);
    assertRealDirectory(identityRoot);
    assertRealDirectory(generation);
    const memberStat = lstatSync(member);
    if (!memberStat.isFile() || memberStat.isSymbolicLink()) {
      throw new Error("kernel generation member is not a regular file");
    }
    const claim = lstatSync(
      join(identityRoot, `.${parts[1]!}.publication-claimed`),
    );
    if (!claim.isFile() || claim.isSymbolicLink()) {
      throw new Error("kernel generation publication claim is invalid");
    }
    return member;
  } catch (error) {
    throw new Error(
      "flat Homebrew VFS package-owned generation mirror is invalid: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertRealDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`kernel generation ancestor is not a real directory: ${path}`);
  }
}

export async function runHomebrewFlatVfsProofWithEvidence(options: {
  host: "node" | "chromium";
  inputs: LoadedHomebrewFlatVfsProofInputIdentity;
  evidencePath: string;
  runProof: () => Promise<HomebrewFlatVfsShippingProofResult>;
}): Promise<HomebrewFlatVfsProofEvidence> {
  const proof = await options.runProof();
  const evidence = buildHomebrewFlatVfsProofEvidence({
    host: options.host,
    tapRevision: options.inputs.tapRevision,
    selectionSha256: options.inputs.selectionSha256,
    image: options.inputs.image,
    report: options.inputs.report,
    kernel: options.inputs.kernel,
    proof,
  });
  publishPrivateEvidenceNoClobber(
    options.evidencePath,
    encodeHomebrewFlatVfsProofEvidence(evidence),
  );
  return evidence;
}

export function publishPrivateEvidenceNoClobber(
  outputPath: string,
  bytes: Uint8Array,
): void {
  const resolved = resolve(outputPath);
  const parent = realpathSync(dirname(resolved));
  const finalPath = join(parent, basename(resolved));
  let stagingDirectory: string | null = null;
  let linked = false;
  try {
    if (lstatOrNull(finalPath) !== null) {
      throw new Error(`flat Homebrew VFS evidence already exists: ${finalPath}`);
    }
    stagingDirectory = mkdtempSync(join(parent, ".kandelo-flat-vfs-proof-"));
    chmodSync(stagingDirectory, 0o700);
    const stagedPath = join(stagingDirectory, "evidence.json");
    const descriptor = openSync(
      stagedPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.size !== bytes.byteLength ||
        (stat.mode & 0o777) !== 0o600
      ) {
        throw new Error("flat Homebrew VFS staged evidence is incomplete");
      }
    } finally {
      closeSync(descriptor);
    }
    linkSync(stagedPath, finalPath);
    linked = true;
    const final = lstatSync(finalPath);
    if (
      !final.isFile() ||
      final.isSymbolicLink() ||
      final.size !== bytes.byteLength ||
      (final.mode & 0o777) !== 0o600
    ) {
      throw new Error("flat Homebrew VFS published evidence is invalid");
    }
  } catch (error) {
    if (linked) unlinkSync(finalPath);
    throw error;
  } finally {
    if (stagingDirectory !== null) {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }
}

function assertExactTapCheckout(tapRoot: string, tapRevision: string): void {
  if (!TAP_REVISION_RE.test(tapRevision)) {
    throw new Error("flat Homebrew VFS tap revision is invalid");
  }
  const resolvedTapRoot = realpathSync(resolve(tapRoot));
  const stat = lstatSync(resolvedTapRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("flat Homebrew VFS tap root must be a real directory");
  }
  const gitRoot = gitOutput(resolvedTapRoot, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(gitRoot) !== resolvedTapRoot) {
    throw new Error("flat Homebrew VFS tap root is not the checkout root");
  }
  const actualRevision = gitOutput(resolvedTapRoot, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  if (actualRevision !== tapRevision) {
    throw new Error(
      `flat Homebrew VFS tap checkout revision is ${actualRevision}, ` +
        `expected ${tapRevision}`,
    );
  }
  if (gitOutput(resolvedTapRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]) !== "") {
    throw new Error("flat Homebrew VFS tap checkout is not clean");
  }
}

function gitOutput(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `flat Homebrew VFS tap checkout is invalid: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readBoundedRegularFile(
  path: string,
  label: string,
  maximumBytes: number,
): Uint8Array {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error(`${label} is not an accessible regular file: ${String(error)}`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 1 ||
      stat.size > maximumBytes
    ) {
      throw new Error(`${label} is not a bounded nonempty regular file`);
    }
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count === 0) throw new Error(`${label} changed during its bounded read`);
      offset += count;
    }
    if (
      readSync(descriptor, new Uint8Array(1), 0, 1, null) !== 0 ||
      fstatSync(descriptor).size !== stat.size
    ) {
      throw new Error(`${label} changed during its bounded read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedVfsRegularFile(
  fs: MemoryFileSystem,
  path: string,
  maximumBytes: number,
): Uint8Array {
  const stat = fs.stat(path);
  if (
    (stat.mode & S_IFMT) !== S_IFREG ||
    stat.size < 1 ||
    stat.size > maximumBytes ||
    fs.isPathDeferred(path)
  ) {
    throw new Error(`${path} is not a bounded image-owned regular file`);
  }
  const bytes = new Uint8Array(stat.size);
  const descriptor = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        descriptor,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0) throw new Error(`${path} ended after ${offset} bytes`);
      offset += count;
    }
  } finally {
    fs.close(descriptor);
  }
  return bytes;
}

function parseJsonObject(
  bytes: Uint8Array,
  label: string,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("value is not an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${String(error)}`);
  }
}

function fileIdentity(bytes: Uint8Array): HomebrewFlatVfsProofFileIdentity {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function wholeArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
