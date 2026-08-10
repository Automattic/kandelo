#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MySqlBrowserClient,
  type MySqlResult,
} from "../apps/browser-demos/lib/mysql-client";
import {
  RedisBrowserClient,
  type RedisResult,
} from "../apps/browser-demos/lib/redis-client";
import type {
  NodeKernelHost,
  NodeKernelHostOptions,
} from "../host/src/node-kernel-host";
import type { KernelPipeTransport } from "../host/src/kernel-pipe-transport";
import type {
  ClosedLazyAsset,
  ClosedLazyAssetSource,
} from "../host/src/vfs/closed-lazy-assets";
import {
  hostMountSpecFromProductMounts,
  type VfsMountIntentV1,
} from "../host/src/vfs/product-mount-contract";
import {
  MemoryFileSystem,
  type LazyDownloadEvent,
} from "../host/src/vfs/memory-fs";
import { restoreVerifiedVfsImage } from "../host/src/vfs/load-image";

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_FILES = 32_768;
const MAX_RUNTIME_ENTRIES = 65_536;
const MAX_RUNTIME_DIRECTORIES = 4_096;
const MAX_RUNTIME_DEPTH = 64;
const MAX_RUNTIME_BYTES = 1024 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RUNTIME_NODE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_KERNEL_BYTES = 512 * 1024 * 1024;
// The protected parent, isolated candidate child, and exact host worker each
// retain an artifact view during handoff. Keep the accepted artifact below
// the repository's 256 MiB default VFS capacity so the declared boundary is
// operational under that bounded multi-process lifecycle.
const MAX_VFS_BYTES = 256 * 1024 * 1024;
const MAX_EVIDENCE_VFS_DECOMPRESSED_BYTES = 320 * 1024 * 1024;
const MAX_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_CHILD_STREAM_BYTES = 64 * 1024;
const MAX_SDK_COMPILER_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SDK_COMPILER_FILES = 100_000;
const MAX_SDK_COMPILER_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_SDK_COMPILER_SECONDS = 240;
const MAX_NIX_DEV_ENV_BYTES = 1024 * 1024;
const TINY_SDK_SOURCE =
  '#include <stdio.h>\n\nint main(void) {\n    puts("hello from Kandelo clang");\n    return 0;\n}\n';
const TINY_SDK_EXPECTED_STDOUT = "hello from Kandelo clang\n";
const EVIDENCE_MAX_WORKERS = 24;
const EVIDENCE_MAX_PROCESS_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_EVIDENCE_CLEANUP_TIMEOUT_MILLISECONDS = 1_000;
const MAX_EVIDENCE_CLEANUP_TIMEOUT_MILLISECONDS = 1_000;
const INTERNAL_CHILD_FLAG = "--internal-candidate-child";
const SAFE_AMBIENT_ENVIRONMENT = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NIX_SSL_CERT_FILE",
  "NO_COLOR",
  "PATH",
  "SOURCE_DATE_EPOCH",
  "SSL_CERT_FILE",
  "TERM",
  "TZ",
] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runtimeArtifactByteLimit(path: string): number {
  if (
    path === "host/dist/index.js" ||
    path === "host/dist/node-kernel-worker-entry.js" ||
    path === "browser/dist/abi-staging-harness/index.html" ||
    path === "browser/dist/abi-staging/browser-host.js"
  ) return MAX_RUNTIME_NODE_ENTRY_BYTES;
  if (path === "kernel.wasm") return MAX_RUNTIME_KERNEL_BYTES;
  return MAX_RUNTIME_FILE_BYTES;
}

type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

export interface EvidenceImplementationV1 {
  path: string;
  sha256: string;
}

export interface GeneratedEvidenceDefinitionV1 {
  id: string;
  host: "node" | "browser";
  runner:
    | "exec"
    | "http"
    | "interactive-terminal"
    | "compile"
    | "sql"
    | "service-protocol"
    | "repository-suite";
  timeout_seconds: number;
  probe: Record<string, unknown>;
  implementation: EvidenceImplementationV1[];
  definition_sha256: string;
}

export interface GeneratedEvidenceDefinitionRegistryV1 {
  schema: 1;
  kind: "kandelo-vfs-evidence-definitions";
  version: number;
  definitions: GeneratedEvidenceDefinitionV1[];
}

export interface ProtectedVfsProductCatalogV1 {
  schema?: number;
  kind: "kandelo-vfs-product-catalog";
  products: Array<{
    path: string;
    sha256: string;
    manifest: {
      id: string;
      boot?: VfsBootContractV1;
      mounts: VfsMountIntentV1[];
      evidence: { node?: { test: string }; browser?: { test: string } };
      [key: string]: unknown;
    };
  }>;
}

export interface ExactRuntimeBundleV1 {
  schema: 1;
  kind: "kandelo-exact-runtime-bundle";
  source: { repository: string; commit: string; tree: string };
  target_abi: { version: number; snapshot_sha256: string };
  kernel: {
    wasm_sha256: string;
    bytes: number;
    abi_version: number;
    snapshot_sha256: string;
  };
  host: {
    bundle_sha256: string;
    bytes: number;
    generated_abi_sha256: string;
    worker_protocol_sha256: string;
  };
  browser: {
    bundle_sha256: string;
    bytes: number;
    harness_entry_bytes: number;
    harness_entry_path: string;
    harness_entry_sha256: string;
    host_entry_bytes: number;
    host_entry_path: string;
    host_entry_sha256: string;
    kernel_asset_path: string;
    kernel_asset_sha256: string;
    service_worker_sha256: string;
  };
  build_policy_sha256: string;
  inventory: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface RuntimeEvidenceIdentityV1 {
  bundle_sha256: string;
  source: ExactRuntimeBundleV1["source"];
  target_abi: ExactRuntimeBundleV1["target_abi"];
  kernel: ExactRuntimeBundleV1["kernel"];
  host_runtime: ExactRuntimeBundleV1["host"];
  browser: ExactRuntimeBundleV1["browser"];
  build_policy_sha256: string;
}

export interface VfsBootContractV1 {
  argv: string[];
  cwd: string;
  uid: number;
  gid: number;
  env: Record<string, string>;
}

export {
  hostMountSpecFromProductMounts,
  type VfsMountIntentV1,
} from "../host/src/vfs/product-mount-contract";

export interface ProductEvidenceRunV1 {
  repository: string;
  workflow_ref: string;
  run_id: number;
  job_id: string;
  attempt: number;
}

export interface NodeEvidenceContextV1 {
  schema: 1;
  kind: "kandelo-vfs-product-node-evidence-context";
  request_digest: string;
  product: { id: string; manifest_sha256: string };
  candidate_product: {
    manifest_digest: string;
    vfs_layer_sha256: string;
    vfs_layer_bytes: number;
    builder_report_sha256: string;
  };
  runtime: RuntimeEvidenceIdentityV1;
  host: "node" | "browser";
  definition: GeneratedEvidenceDefinitionV1;
  boot: VfsBootContractV1;
  mounts: VfsMountIntentV1[];
  run: ProductEvidenceRunV1;
}

export type CandidateProductEvidenceDocumentContextV1 = Pick<
  NodeEvidenceContextV1,
  "boot" | "candidate_product" | "definition" | "mounts" | "product" | "runtime"
>;

export interface CandidateProductLocatorV1 {
  reference_class?: "candidate" | "canonical";
  product_id: string;
  repository: string;
  manifest_digest: string;
  immutable_reference: string;
  vfs_layer_sha256: string;
  vfs_layer_bytes: number;
  builder_report_sha256: string;
}

export interface CandidateLazyRequirementV1 {
  id: string;
  url: string;
  sha256: string;
  size: number;
}

export interface ProductEvidenceDiagnosticV1 {
  id: string;
  sha256: string;
  bytes: number;
  text: string;
}

export interface ProductEvidenceResultV1 {
  schema: 1;
  kind: "kandelo-vfs-product-evidence-result";
  request_digest: string;
  product: NodeEvidenceContextV1["product"];
  candidate_product: NodeEvidenceContextV1["candidate_product"];
  runtime: RuntimeEvidenceIdentityV1;
  host: "node" | "browser";
  definition: { id: string; definition_sha256: string };
  outcome: "success" | "failure" | "timeout";
  guard_codes: Array<"verification_failed" | "verification_timeout">;
  bounded_diagnostics: ProductEvidenceDiagnosticV1[];
  run: ProductEvidenceRunV1;
}

interface OperationBase {
  boot: VfsBootContractV1;
  mounts: VfsMountIntentV1[];
}

export type NodeEvidenceOperation =
  | (OperationBase & {
    kind: "exec";
    argv: string[];
    stdin?: string;
    env: Record<string, string>;
  })
  | (OperationBase & {
    kind: "http";
    path: string;
  })
  | (OperationBase & {
    kind: "compile";
    fixture: "tiny-sdk-program";
    /** Protected supervisor-only handoff; absent from evidence definitions. */
    compiled_program_base64?: string;
  })
  | (OperationBase & {
    kind: "sql";
    statements: string[];
  })
  | (OperationBase & {
    kind: "service-protocol";
    protocol: "redis";
    request: string;
  })
  | (OperationBase & {
    kind: "repository-suite";
    suite: NodeRepositorySuite;
  });

export type NodeRepositorySuite =
  | "mariadb-product-node"
  | "php-product-node"
  | "sqlite-product-node";

export interface ProtectedNodeSuiteStep {
  readonly id: string;
  readonly argv: readonly [string, ...string[]];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdout: Readonly<{
    kind: "exact" | "contains";
    value: string;
  }>;
}

export interface ProtectedNodeSuiteDefinition {
  readonly service?: Readonly<{
    argv: "product-boot";
    port: number;
  }>;
  readonly steps: readonly ProtectedNodeSuiteStep[];
}

export interface ProcessObservation {
  status: number;
  stdout: string;
  stderr: string;
}

export interface HttpObservation {
  status: number;
  body: string;
  stdout: string;
  stderr: string;
}

export interface SqlObservation {
  results: string[];
  stdout: string;
  stderr: string;
}

export interface ProtocolObservation {
  response: string;
  stdout: string;
  stderr: string;
}

export interface EvidenceLazyDownloadEventV1 {
  phase: "initialization" | "operation";
  url: string;
  status: LazyDownloadEvent["status"];
  loaded_bytes: number;
  total_bytes?: number;
}

export function formatMysqlEvidenceResult(result: MySqlResult): string {
  if (result.rows.length > 0) {
    return result.rows.map((row) => row.join("\t")).join("\n");
  }
  if (result.affectedRows !== undefined) return String(result.affectedRows);
  return result.info ?? "";
}

export function formatRedisEvidenceResult(result: RedisResult): string {
  if (result.type === "error") {
    throw new Error(`Redis protocol error: ${String(result.value)}`);
  }
  if (result.type === "string" || result.type === "bulk" || result.type === "integer") {
    return String(result.value);
  }
  if (result.type === "null") return "";
  throw new Error("Redis evidence requires one scalar protocol response");
}

export class BoundedEvidenceOutput {
  private readonly chunks: Array<{ pid: number; bytes: Uint8Array }> = [];
  private bytes = 0;

  constructor(
    private readonly maximumBytes: number,
    private readonly label: string,
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error(`${label} evidence bound must be a positive safe integer`);
    }
  }

  append(pid: number, bytes: Uint8Array): void {
    if (!Number.isSafeInteger(pid) || pid < 0) {
      throw new Error(`${this.label} callback has an invalid process ID`);
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`${this.label} callback payload is not a Uint8Array`);
    }
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > this.maximumBytes - this.bytes) {
      throw new Error(
        `${this.label} exceeds its ${this.maximumBytes}-byte evidence bound`,
      );
    }
    this.chunks.push({ pid, bytes: new Uint8Array(bytes) });
    this.bytes += bytes.byteLength;
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }

  decode(pid?: number): string {
    const selected = pid === undefined
      ? this.chunks
      : this.chunks.filter((chunk) => chunk.pid === pid);
    return new TextDecoder().decode(
      Buffer.concat(selected.map((chunk) => Buffer.from(chunk.bytes))),
    );
  }
}

export function createBoundedKernelPipeTransport(
  delegate: KernelPipeTransport,
  maximumBytes: number,
): KernelPipeTransport {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("kernel pipe evidence bound must be a positive safe integer");
  }
  let requestBytes = 0;
  let responseBytes = 0;
  return {
    pickListenerTarget: (port) => delegate.pickListenerTarget(port),
    injectConnection: (pid, fd, address, port) =>
      delegate.injectConnection(pid, fd, address, port),
    async pipeWrite(pid, pipeIdx, bytes) {
      if (bytes.byteLength > maximumBytes - requestBytes) {
        throw new Error(
          `kernel pipe request exceeds its ${maximumBytes}-byte evidence bound`,
        );
      }
      requestBytes += bytes.byteLength;
      return delegate.pipeWrite(pid, pipeIdx, bytes);
    },
    async pipeRead(pid, pipeIdx) {
      const bytes = await delegate.pipeRead(pid, pipeIdx);
      if (bytes !== null) {
        if (bytes.byteLength > maximumBytes - responseBytes) {
          throw new Error(
            `kernel pipe response exceeds its ${maximumBytes}-byte evidence bound`,
          );
        }
        responseBytes += bytes.byteLength;
      }
      return bytes;
    },
    pipeCloseWrite: (pid, pipeIdx) => delegate.pipeCloseWrite(pid, pipeIdx),
    pipeCloseRead: (pid, pipeIdx) => delegate.pipeCloseRead(pid, pipeIdx),
    pipeIsWriteOpen: (pid, pipeIdx) => delegate.pipeIsWriteOpen(pid, pipeIdx),
    wakeBlockedReaders: (pipeIdx) => delegate.wakeBlockedReaders(pipeIdx),
    wakeBlockedWriters: (pipeIdx) => delegate.wakeBlockedWriters(pipeIdx),
  };
}

export interface NodeEvidenceAdapter {
  exec(operation: Extract<NodeEvidenceOperation, { kind: "exec" }>):
    Promise<ProcessObservation>;
  http(operation: Extract<NodeEvidenceOperation, { kind: "http" }>):
    Promise<HttpObservation>;
  compile(operation: Extract<NodeEvidenceOperation, { kind: "compile" }>):
    Promise<ProcessObservation>;
  sql(operation: Extract<NodeEvidenceOperation, { kind: "sql" }>):
    Promise<SqlObservation>;
  serviceProtocol(
    operation: Extract<NodeEvidenceOperation, { kind: "service-protocol" }>,
  ): Promise<ProtocolObservation>;
  repositorySuite(
    operation: Extract<NodeEvidenceOperation, { kind: "repository-suite" }>,
  ): Promise<ProcessObservation>;
  lazyDownloads(): Promise<readonly EvidenceLazyDownloadEventV1[]>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface NodeEvidenceExecutionInputs {
  context: NodeEvidenceContextV1;
  candidateLocator: CandidateProductLocatorV1;
  protectedDefinitions: GeneratedEvidenceDefinitionRegistryV1;
  protectedProducts: ProtectedVfsProductCatalogV1;
  vfsBytes: Uint8Array;
  runtimeBundleBytes: Uint8Array;
  kernelWasmBytes: Uint8Array;
  resolvedInputsBytes: Uint8Array;
  builderReportBytes: Uint8Array;
  lazyAssetSources: readonly ClosedLazyAssetSource[];
  lazyAssets?: readonly ClosedLazyAsset[];
}

export interface NodeEvidenceRunnerDependencies {
  runWithTimeout?<T>(operation: Promise<T>, timeoutMilliseconds: number): Promise<T>;
  cleanupTimeoutMilliseconds?: number;
}

type NodeKernelHostConstructor = new (
  options: NodeKernelHostOptions,
) => NodeKernelHost;

export interface ExactRuntimeArtifactRootV1 {
  root: string;
  kernelPath: string;
  browserHarnessEntryPath: string;
  browserKernelAssetPath: string;
  browserHostEntryPath: string;
  hostModulePath: string;
}

export class EvidenceTimeoutError extends Error {}

class EvidenceFailure extends Error {
  constructor(
    message: string,
    readonly stdout = "",
    readonly stderr = "",
  ) {
    super(message);
  }
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  const normalized = normalizeJson(value);
  return encoder.encode(`${JSON.stringify(normalized)}\n`);
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("canonical JSON permits safe integer numbers only");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) throw new Error(`canonical JSON field ${key} is undefined`);
      result[key] = normalizeJson(item);
    }
    return result;
  }
  throw new Error(`canonical JSON cannot encode ${typeof value}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function evidenceDefinitionSha256(
  definition: GeneratedEvidenceDefinitionV1,
): string {
  return sha256Hex(canonicalJsonBytes({
    host: definition.host,
    id: definition.id,
    implementation: definition.implementation,
    probe: definition.probe,
    runner: definition.runner,
    timeout_seconds: definition.timeout_seconds,
  }));
}

export function runtimeIdentityFromBundle(
  runtimeBundleBytes: Uint8Array,
): RuntimeEvidenceIdentityV1 {
  const bundle = parseExactRuntimeBundle(runtimeBundleBytes);
  return {
    bundle_sha256: sha256Hex(runtimeBundleBytes),
    source: bundle.source,
    target_abi: bundle.target_abi,
    kernel: bundle.kernel,
    host_runtime: bundle.host,
    browser: bundle.browser,
    build_policy_sha256: bundle.build_policy_sha256,
  };
}

function parseExactRuntimeBundle(
  runtimeBundleBytes: Uint8Array,
): ExactRuntimeBundleV1 {
  if (runtimeBundleBytes.byteLength > MAX_RUNTIME_BUNDLE_BYTES) {
    throw new Error("exact runtime bundle exceeds the 16 MiB limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(runtimeBundleBytes));
  } catch (error) {
    throw new Error(`exact runtime bundle is invalid JSON: ${errorMessage(error)}`);
  }
  const bundle = validateRuntimeBundle(value);
  if (!bytesEqual(canonicalJsonBytes(bundle), runtimeBundleBytes)) {
    throw new Error("exact runtime bundle is not canonical JSON");
  }
  return bundle;
}

export function exactRuntimeDevShellLockSha256(runtimeBundleBytes: Uint8Array): string {
  const bundle = parseExactRuntimeBundle(runtimeBundleBytes);
  const lock = bundle.inventory.find((entry) => entry.path === "flake.lock");
  if (lock === undefined) throw new Error("exact runtime inventory lacks flake.lock");
  return lock.sha256;
}

export function validateExactRuntimeArtifactRoot(
  runtimeBundleBytes: Uint8Array,
  runtimeRoot: string,
): ExactRuntimeArtifactRootV1 {
  const bundle = parseExactRuntimeBundle(runtimeBundleBytes);
  const requestedRoot = resolve(runtimeRoot);
  const rootMetadata = lstatSync(requestedRoot);
  if (
    rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()
  ) {
    throw new Error("exact runtime artifact root must be a real directory");
  }
  const root = realpathSync.native(requestedRoot);
  const inventory: ExactRuntimeBundleV1["inventory"] = [];
  let total = 0;
  let entryCount = 0;
  let directoryCount = 0;
  const visit = (directory: string, depth: number): number => {
    if (depth > MAX_RUNTIME_DEPTH) {
      throw new Error("runtime inventory exceeds its directory depth bound");
    }
    let fileCount = 0;
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      entryCount++;
      if (entryCount > MAX_RUNTIME_ENTRIES) {
        throw new Error("runtime inventory exceeds its total entry bound");
      }
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`runtime inventory contains a symbolic link: ${path}`);
      }
      if (metadata.isDirectory()) {
        directoryCount++;
        if (directoryCount > MAX_RUNTIME_DIRECTORIES) {
          throw new Error("runtime inventory exceeds its directory bound");
        }
        const portablePath = relative(root, path).split(sep).join("/");
        relativePath(portablePath, "runtime artifact directory");
        const nestedFiles = visit(path, depth + 1);
        if (nestedFiles === 0) {
          throw new Error(`runtime inventory contains an empty directory: ${path}`);
        }
        fileCount += nestedFiles;
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`runtime inventory contains a nonregular file: ${path}`);
      }
      if (inventory.length >= MAX_RUNTIME_FILES) {
        throw new Error("runtime inventory exceeds its item bound");
      }
      const portablePath = relative(root, path).split(sep).join("/");
      relativePath(portablePath, "runtime artifact path");
      if (metadata.size > runtimeArtifactByteLimit(portablePath)) {
        const label = portablePath.startsWith("host/dist/")
          ? "executable Node artifact"
          : "runtime artifact";
        throw new Error(`${label} ${portablePath} exceeds its byte bound`);
      }
      total += metadata.size;
      if (!Number.isSafeInteger(total) || total > MAX_RUNTIME_BYTES) {
        throw new Error("runtime inventory exceeds its byte bound");
      }
      inventory.push({
        path: portablePath,
        sha256: sha256RegularFile(path, metadata.size),
        bytes: metadata.size,
      });
      fileCount++;
    }
    return fileCount;
  };
  visit(root, 0);
  inventory.sort((left, right) => compareOrdinal(left.path, right.path));
  if (!jsonEqual(inventory, bundle.inventory)) {
    throw new Error("runtime artifact inventory differs from the exact runtime bundle");
  }

  const required = [
    "kernel.wasm",
    "host/dist/index.js",
    "host/dist/node-kernel-worker-entry.js",
    "host/package.json",
  ];
  for (const path of required) {
    if (!bundle.inventory.some((entry) => entry.path === path)) {
      throw new Error(`exact runtime bundle lacks executable Node artifact ${path}`);
    }
  }
  const packageBytes = readRegular(
    join(root, "host/package.json"),
    "runtime Node package identity",
    128,
  );
  if (!bytesEqual(packageBytes, canonicalJsonBytes({ type: "module" }))) {
    throw new Error("runtime Node package identity is not the protected ESM contract");
  }
  return {
    root,
    kernelPath: join(root, "kernel.wasm"),
    browserHarnessEntryPath: join(root, bundle.browser.harness_entry_path),
    browserKernelAssetPath: join(root, bundle.browser.kernel_asset_path),
    browserHostEntryPath: join(root, bundle.browser.host_entry_path),
    hostModulePath: join(root, "host/dist/index.js"),
  };
}

export async function loadExactNodeKernelHostConstructor(
  artifacts: ExactRuntimeArtifactRootV1,
): Promise<NodeKernelHostConstructor> {
  const loaded = await import(pathToFileURL(artifacts.hostModulePath).href) as unknown;
  const Host = isRecord(loaded) ? loaded.NodeKernelHost : undefined;
  if (typeof Host !== "function") {
    throw new Error("exact runtime host module does not export NodeKernelHost");
  }
  return Host as NodeKernelHostConstructor;
}

function sha256RegularFile(path: string, expectedBytes: number): string {
  const hasher = createHash("sha256");
  const descriptor = openSync(path, "r");
  let total = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      total += read;
      if (total > expectedBytes) {
        throw new Error(`runtime artifact changed while hashing: ${path}`);
      }
      hasher.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  if (total !== expectedBytes) {
    throw new Error(`runtime artifact changed while hashing: ${path}`);
  }
  return hasher.digest("hex");
}

export function validateNodeEvidenceContext(
  inputs: NodeEvidenceExecutionInputs,
): CandidateLazyRequirementV1[] {
  const context = validateContextShape(inputs.context);
  validateCandidateLocator(context, inputs.candidateLocator);
  validateProtectedDefinitionSelection(context, inputs.protectedDefinitions);
  validateProtectedProductSelection(context, inputs.protectedProducts);
  const lazyRequirements = validateCandidateProductInputDocuments(
    context,
    inputs.candidateLocator,
    inputs.protectedProducts,
    exactRuntimeDevShellLockSha256(inputs.runtimeBundleBytes),
    inputs.resolvedInputsBytes,
    inputs.builderReportBytes,
  );
  validateCandidateLazyAssetSources(
    lazyRequirements,
    inputs.lazyAssetSources,
    expectedLazyInputIds(context.definition),
  );
  if (inputs.lazyAssets !== undefined) {
    validateProtectedNodeLazyAssets(
      lazyRequirements,
      inputs.lazyAssets,
      expectedLazyInputIds(context.definition),
    );
  }
  const exactRuntime = runtimeIdentityFromBundle(inputs.runtimeBundleBytes);
  if (!jsonEqual(context.runtime, exactRuntime)) {
    throw new Error("Node evidence runtime differs from the exact runtime bundle");
  }
  if (
    inputs.vfsBytes.byteLength === 0 ||
    context.candidate_product.vfs_layer_bytes !== inputs.vfsBytes.byteLength ||
    context.candidate_product.vfs_layer_sha256 !== sha256Hex(inputs.vfsBytes)
  ) {
    throw new Error("candidate VFS bytes differ from their exact identity");
  }
  if (
    inputs.kernelWasmBytes.byteLength === 0 ||
    context.runtime.kernel.bytes !== inputs.kernelWasmBytes.byteLength ||
    context.runtime.kernel.wasm_sha256 !== sha256Hex(inputs.kernelWasmBytes)
  ) {
    throw new Error("kernel bytes differ from the exact runtime identity");
  }
  return lazyRequirements;
}

function validateProtectedDefinitionSelection(
  context: NodeEvidenceContextV1,
  value: unknown,
): void {
  const registry = exactRecord(
    value,
    ["definitions", "kind", "schema", "version"],
    "protected evidence definition registry",
  );
  if (
    registry.schema !== 1 || registry.kind !== "kandelo-vfs-evidence-definitions" ||
    positiveInteger(registry.version, "protected evidence definition version") < 1
  ) throw new Error("protected evidence definition registry has unsupported identity");
  const definitions = array(registry.definitions, "protected evidence definitions");
  let selected: unknown;
  let previous = "";
  for (const candidate of definitions) {
    const item = exactRecord(candidate, [
      "definition_sha256", "host", "id", "implementation", "probe", "runner",
      "timeout_seconds",
    ], "protected evidence definition");
    const id = stableId(item.id, "protected evidence definition id");
    if (id <= previous) throw new Error("protected evidence definitions are not sorted");
    previous = id;
    if (id === context.definition.id) selected = candidate;
  }
  if (selected === undefined || !jsonEqual(selected, context.definition)) {
    throw new Error("Node evidence definition differs from protected current policy");
  }
}

function validateProtectedProductSelection(
  context: NodeEvidenceContextV1,
  value: unknown,
): void {
  if (!isRecord(value)) throw new Error("protected VFS product catalog must be an object");
  const allowed = new Set(["kind", "products", "schema"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("protected VFS product catalog has unknown fields");
  }
  if (value.kind !== "kandelo-vfs-product-catalog") {
    throw new Error("protected VFS product catalog has unsupported identity");
  }
  if (value.schema !== undefined && value.schema !== 1) {
    throw new Error("protected VFS product catalog has unsupported schema");
  }
  let selected: Record<string, unknown> | undefined;
  let previous = "";
  for (const candidate of array(value.products, "protected VFS products")) {
    const entry = exactRecord(candidate, ["manifest", "path", "sha256"], "VFS catalog entry");
    const manifest = isRecord(entry.manifest)
      ? entry.manifest
      : (() => { throw new Error("VFS catalog manifest must be an object"); })();
    const id = stableId(manifest.id, "VFS catalog product id");
    if (id <= previous) throw new Error("protected VFS product catalog is not sorted");
    previous = id;
    const path = relativePath(entry.path, "VFS catalog path");
    if (path !== `images/vfs/products/${id}.toml`) {
      throw new Error(`protected VFS product ${id} has a noncanonical catalog path`);
    }
    const claimedDigest = digest(entry.sha256, "VFS catalog manifest digest");
    if (claimedDigest !== sha256Hex(canonicalJsonBytes(manifest))) {
      throw new Error(`protected VFS product ${id} catalog manifest digest is invalid`);
    }
    if (id === context.product.id) selected = entry;
  }
  if (selected === undefined) throw new Error("Node evidence product is absent from protected catalog");
  if (selected.sha256 !== context.product.manifest_sha256) {
    throw new Error("Node evidence product manifest differs from protected catalog");
  }
  const manifest = selected.manifest as Record<string, unknown>;
  if (!jsonEqual(manifest.boot, context.boot) || !jsonEqual(manifest.mounts, context.mounts)) {
    throw new Error("Node evidence boot or mount contract differs from protected product intent");
  }
  const evidence = isRecord(manifest.evidence) ? manifest.evidence : {};
  const node = isRecord(evidence.node) ? evidence.node : undefined;
  if (node?.test !== context.definition.id) {
    throw new Error("Node evidence definition differs from the protected product registration");
  }
}

export function validateCandidateLocator(
  context: CandidateProductEvidenceDocumentContextV1,
  value: unknown,
): void {
  const locator = exactRecordWithOptional(value, [
    "builder_report_sha256", "immutable_reference", "manifest_digest",
    "product_id", "repository", "vfs_layer_bytes", "vfs_layer_sha256",
  ], ["reference_class"], "candidate product locator");
  const productId = stableId(locator.product_id, "candidate product locator ID");
  const referenceClass = locator.reference_class === undefined
    ? "candidate"
    : oneOf(
      locator.reference_class,
      ["candidate", "canonical"],
      "product locator reference class",
    );
  const repositoryValue = text(
    locator.repository,
    "candidate product locator repository",
    520,
  );
  const expectedRepository = referenceClass === "candidate"
    ? `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${context.runtime.target_abi.version}` +
      `-candidates/products/${productId}`
    : `https://automattic.github.io/kandelo/products/${productId}`;
  if (repositoryValue !== expectedRepository) {
    throw new Error("candidate product locator is outside its exact candidate repository");
  }
  const manifestDigest = text(
    locator.manifest_digest,
    "candidate product locator manifest",
  );
  if (!manifestDigest.startsWith("sha256:")) {
    throw new Error("candidate product locator manifest is not an OCI digest");
  }
  digest(manifestDigest.slice(7), "candidate product locator manifest");
  const vfsLayerSha256 = digest(
    locator.vfs_layer_sha256,
    "candidate product locator VFS",
  );
  const vfsLayerBytes = positiveInteger(
    locator.vfs_layer_bytes,
    "candidate product locator VFS bytes",
  );
  const expectedImmutableReference = referenceClass === "candidate"
    ? `${repositoryValue}@${manifestDigest}`
    : `${repositoryValue}/sha256-${vfsLayerSha256}/${productId}-` +
      `${context.runtime.target_abi.version}.vfs.zst?sha256=${vfsLayerSha256}&` +
      `bytes=${vfsLayerBytes}`;
  if (
    locator.immutable_reference !== expectedImmutableReference ||
    (referenceClass === "canonical" && manifestDigest !== `sha256:${vfsLayerSha256}`)
  ) {
    throw new Error("candidate product locator is not immutable");
  }
  const candidate = {
    manifest_digest: manifestDigest,
    vfs_layer_sha256: vfsLayerSha256,
    vfs_layer_bytes: vfsLayerBytes,
    builder_report_sha256: digest(
      locator.builder_report_sha256,
      "candidate product locator builder report",
    ),
  };
  if (
    productId !== context.product.id ||
    candidate.vfs_layer_bytes > MAX_VFS_BYTES ||
    !jsonEqual(candidate, context.candidate_product)
  ) {
    throw new Error("candidate product locator differs from the exact evidence context");
  }
}

function canonicalDocumentBytes(
  bytes: Uint8Array,
  label: string,
): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error(`${label} is empty or exceeds its byte bound`);
  }
  const value = JSON.parse(decoder.decode(bytes)) as unknown;
  if (!bytesEqual(bytes, canonicalJsonBytes(value))) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function oneOf(
  value: unknown,
  allowed: readonly string[],
  label: string,
): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} is unsupported`);
  }
  return value;
}

export function validateCandidateProductInputDocuments(
  context: CandidateProductEvidenceDocumentContextV1,
  locatorValue: CandidateProductLocatorV1,
  productsValue: ProtectedVfsProductCatalogV1,
  runtimeDevShellLockSha256: string,
  resolvedBytes: Uint8Array,
  reportBytes: Uint8Array,
): CandidateLazyRequirementV1[] {
  const resolved = exactRecord(
    canonicalDocumentBytes(resolvedBytes, "resolved product inputs"),
    [
      "build_environment", "inputs", "kind", "product", "reference_class",
      "schema", "source", "target_abi",
    ],
    "resolved product inputs",
  );
  if (
    resolved.schema !== 1 || resolved.kind !== "kandelo-resolved-vfs-product-inputs" ||
    resolved.reference_class !== (locatorValue.reference_class ?? "candidate")
  ) {
    throw new Error("resolved product inputs lack their exact product reference identity");
  }
  const selected = productsValue.products.find(
    (entry) => entry.manifest.id === context.product.id,
  );
  if (selected === undefined) {
    throw new Error("resolved product inputs name an unprotected product");
  }
  const product = exactRecord(
    resolved.product,
    ["architecture", "id", "manifest_path", "manifest_sha256", "output"],
    "resolved product identity",
  );
  const architecture = oneOf(
    product.architecture,
    ["wasm32", "wasm64"],
    "resolved product architecture",
  );
  const expectedProduct = {
    architecture: oneOf(
      selected.manifest.architecture,
      ["wasm32", "wasm64"],
      "protected product architecture",
    ),
    id: context.product.id,
    manifest_path: selected.path,
    manifest_sha256: context.product.manifest_sha256,
    output: text(selected.manifest.output, "protected product output", 255),
  };
  stableId(product.id, "resolved product ID");
  relativePath(product.manifest_path, "resolved product manifest path");
  digest(product.manifest_sha256, "resolved product manifest digest");
  relativePath(product.output, "resolved product output");
  if (!jsonEqual(product, expectedProduct)) {
    throw new Error("resolved product identity differs from protected product intent");
  }
  const targetAbi = exactRecord(
    resolved.target_abi,
    ["snapshot_sha256", "version"],
    "resolved target ABI",
  );
  positiveInteger(targetAbi.version, "resolved target ABI version");
  digest(targetAbi.snapshot_sha256, "resolved target ABI snapshot");
  if (!jsonEqual(targetAbi, context.runtime.target_abi)) {
    throw new Error("resolved product inputs differ from the exact runtime ABI");
  }
  const source = exactRecord(
    resolved.source,
    ["commit", "repository", "tree"],
    "resolved product source",
  );
  repository(source.repository, "resolved product source repository");
  gitSha(source.commit, "resolved product source commit");
  gitSha(source.tree, "resolved product source tree");
  if (!jsonEqual(source, context.runtime.source)) {
    throw new Error("resolved product inputs differ from the exact runtime source");
  }
  const buildEnvironment = exactRecord(
    resolved.build_environment,
    ["dev_shell_lock_sha256", "policy_sha256"],
    "resolved build environment",
  );
  digest(buildEnvironment.dev_shell_lock_sha256, "resolved dev-shell lock");
  digest(buildEnvironment.policy_sha256, "resolved build policy");
  if (buildEnvironment.policy_sha256 !== context.runtime.build_policy_sha256) {
    throw new Error("resolved product build policy differs from the exact runtime policy");
  }
  if (buildEnvironment.dev_shell_lock_sha256 !== runtimeDevShellLockSha256) {
    throw new Error("resolved product dev-shell lock differs from the exact runtime lock");
  }

  const resolvedInputs = array(resolved.inputs, "resolved product input list");
  if (resolvedInputs.length > 4_096) {
    throw new Error("resolved product inputs exceed their item bound");
  }
  const reportInputs: unknown[] = [];
  const lazyRequirements: CandidateLazyRequirementV1[] = [];
  let previous = "";
  for (const [index, value] of resolvedInputs.entries()) {
    const input = exactRecordWithOptional(
      value,
      [
        "architecture", "bytes", "declared_materialization",
        "effective_materialization", "id", "kind", "role", "sha256",
      ],
      ["descriptor", "path", "reference"],
      `resolved product input ${index}`,
    );
    const id = stableId(input.id, `resolved product input ${index} ID`);
    if (id <= previous) throw new Error("resolved product inputs are not sorted and unique");
    previous = id;
    const kind = oneOf(
      input.kind,
      [
        "product-image", "homebrew-bottle", "package-output", "source-archive",
        "toolchain-output", "repository-path",
      ],
      `resolved product input ${id} kind`,
    );
    const role = oneOf(
      input.role,
      ["runtime", "build"],
      `resolved product input ${id} role`,
    );
    if (input.architecture !== architecture) {
      throw new Error(`resolved product input ${id} architecture differs`);
    }
    const declared = oneOf(
      input.declared_materialization,
      ["embedded", "lazy", "build-only"],
      `resolved product input ${id} declared materialization`,
    );
    const placement = oneOf(
      input.effective_materialization,
      ["embedded", "lazy-reference", "build-only"],
      `resolved product input ${id} placement`,
    );
    if (
      !(
        role === "runtime" && declared === "embedded" && placement === "embedded" ||
        role === "runtime" && declared === "lazy" &&
          (placement === "lazy-reference" || placement === "embedded") ||
        role === "build" && declared === "build-only" && placement === "build-only"
      )
    ) throw new Error(`resolved product input ${id} materialization contradicts its role`);
    const sha256 = digest(input.sha256, `resolved product input ${id} digest`);
    const bytes = nonnegativeInteger(input.bytes, `resolved product input ${id} bytes`);
    const reference = input.reference === undefined
      ? undefined
      : text(input.reference, `resolved product input ${id} reference`, 4_096);
    const path = input.path === undefined
      ? undefined
      : relativePath(input.path, `resolved product input ${id} path`);
    if (reference !== undefined && !reference.includes(`sha256:${sha256}`) &&
      !reference.includes(`sha256=${sha256}`)) {
      throw new Error(`resolved product input ${id} reference does not bind its digest`);
    }
    if (reference !== undefined) {
      validateCandidateReferenceClass(
        reference,
        context.runtime.target_abi.version,
        `resolved product input ${id}`,
        kind === "homebrew-bottle" || kind === "product-image" ||
          placement === "lazy-reference",
        locatorValue.reference_class ?? "candidate",
        { bytes, id, sha256 },
      );
    }
    if (placement === "lazy-reference") {
      if (reference === undefined || path !== undefined || bytes === 0) {
        throw new Error(`lazy resolved product input ${id} lacks its exact reference`);
      }
      lazyRequirements.push({ id, url: reference, sha256, size: bytes });
    } else if (path === undefined) {
      throw new Error(`materialized resolved product input ${id} lacks its staged path`);
    }
    let reportDescriptor: unknown;
    if (input.descriptor !== undefined) {
      if (kind !== "homebrew-bottle" && kind !== "package-output") {
        throw new Error(`resolved product input ${id} has an unsupported descriptor`);
      }
      const descriptor = exactRecord(
        input.descriptor,
        ["bytes", "path", "reference", "sha256"],
        `resolved product input ${id} descriptor`,
      );
      const descriptorSha = digest(
        descriptor.sha256,
        `resolved product input ${id} descriptor digest`,
      );
      const descriptorBytes = positiveInteger(
        descriptor.bytes,
        `resolved product input ${id} descriptor bytes`,
      );
      relativePath(descriptor.path, `resolved product input ${id} descriptor path`);
      const descriptorReference = text(
        descriptor.reference,
        `resolved product input ${id} descriptor reference`,
        4_096,
      );
      if (!descriptorReference.includes(`sha256:${descriptorSha}`) &&
        !descriptorReference.includes(`sha256=${descriptorSha}`)) {
        throw new Error(`resolved product input ${id} descriptor lacks its digest`);
      }
      validateCandidateReferenceClass(
        descriptorReference,
        context.runtime.target_abi.version,
        `resolved product input ${id} descriptor`,
        kind === "homebrew-bottle" || placement === "lazy-reference",
        locatorValue.reference_class ?? "candidate",
        { bytes: descriptorBytes, id, sha256: descriptorSha },
      );
      reportDescriptor = { bytes: descriptorBytes, sha256: descriptorSha };
    } else if (kind === "homebrew-bottle") {
      throw new Error(`resolved Homebrew input ${id} lacks its descriptor`);
    }
    reportInputs.push({
      bytes,
      ...(reportDescriptor === undefined ? {} : { descriptor: reportDescriptor }),
      id,
      kind,
      placement,
      role,
      sha256,
    });
  }

  if (sha256Hex(reportBytes) !== locatorValue.builder_report_sha256) {
    throw new Error("candidate locator differs from the exact builder report bytes");
  }
  const report = exactRecord(
    canonicalDocumentBytes(reportBytes, "candidate builder report"),
    ["capture", "inputs", "kind", "output", "product", "resolved_inputs_sha256", "schema"],
    "candidate builder report",
  );
  if (report.schema !== 1 || report.kind !== "kandelo-vfs-builder-report") {
    throw new Error("candidate builder report has unsupported identity");
  }
  const capture = exactRecord(
    report.capture,
    ["complete", "unreported_reads"],
    "candidate builder report capture",
  );
  if (capture.complete !== true || !jsonEqual(capture.unreported_reads, [])) {
    throw new Error("candidate builder report input capture is incomplete");
  }
  const output = exactRecord(
    report.output,
    ["abi", "bytes", "name", "path", "sha256"],
    "candidate builder report output",
  );
  const expectedOutput = {
    abi: targetAbi,
    bytes: context.candidate_product.vfs_layer_bytes,
    name: expectedProduct.output,
    path: expectedProduct.output,
    sha256: context.candidate_product.vfs_layer_sha256,
  };
  if (
    !jsonEqual(report.product, product) ||
    report.resolved_inputs_sha256 !== sha256Hex(resolvedBytes) ||
    !jsonEqual(report.inputs, reportInputs) ||
    !jsonEqual(output, expectedOutput)
  ) {
    throw new Error("candidate builder report differs from exact resolved product inputs");
  }
  return lazyRequirements;
}

function validateCandidateReferenceClass(
  reference: string,
  targetAbi: number,
  label: string,
  requireCandidateNamespace: boolean,
  referenceClass: "candidate" | "canonical",
  identity: { bytes: number; id: string; sha256: string },
): void {
  const namespace = "ghcr.io/kandelo-dev/homebrew-tap-core-abi-";
  const candidate = `${namespace}${targetAbi}-candidates/`;
  const canonical = `${namespace}${targetAbi}/`;
  const normalized = reference.startsWith("https://")
    ? reference.slice("https://".length)
    : reference;
  const anyCanonical = /^ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[0-9]+\//u
    .test(normalized);
  const managed = anyCanonical ||
    /^ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[0-9]+-candidates\//u
      .test(normalized);
  if (referenceClass === "candidate") {
    if (normalized.startsWith(canonical) || anyCanonical) {
      throw new Error(`${label} enters the canonical ABI namespace`);
    }
    if (
      (requireCandidateNamespace || managed) &&
      !normalized.startsWith(candidate)
    ) {
      throw new Error(`${label} is outside its visibly nonendorsed candidate namespace`);
    }
    return;
  }
  if (normalized.startsWith(candidate)) {
    throw new Error(`${label} retains the visibly nonendorsed candidate namespace`);
  }
  const pagesProduct = normalized.startsWith(
    "automattic.github.io/kandelo/products/",
  );
  if (pagesProduct) {
    validateCanonicalPagesInputReference(
      reference,
      identity.id,
      identity.sha256,
      identity.bytes,
      label,
    );
  }
  if (
    (requireCandidateNamespace || managed) &&
    !normalized.startsWith(canonical) && !pagesProduct
  ) {
    throw new Error(`${label} is outside its exact canonical namespace`);
  }
}

export function validateCanonicalPagesInputReference(
  reference: string,
  id: string,
  sha256: string,
  bytes: number,
  label = "canonical Pages input",
): void {
  const exact =
    `https://automattic.github.io/kandelo/products/inputs/${id}/` +
    `sha256-${sha256}/${id}?sha256=${sha256}&bytes=${bytes}`;
  if (reference !== exact) {
    throw new Error(`${label} lacks its exact canonical Pages input URL`);
  }
}

export async function validateCandidateVfsLazyInventory(
  vfsBytes: Uint8Array,
  requirements: readonly CandidateLazyRequirementV1[],
  targetAbi: ExactRuntimeBundleV1["target_abi"],
): Promise<void> {
  const expected = new Map<string, CandidateLazyRequirementV1>();
  for (const requirement of requirements) {
    if (expected.has(requirement.url)) {
      throw new Error("resolved product inputs contain duplicate lazy URLs");
    }
    expected.set(requirement.url, requirement);
  }
  const observed = new Map<string, {
    kind: "file" | "tree";
    sha256?: string;
    size: number;
  }>();
  const record = (
    url: string,
    value: { kind: "file" | "tree"; sha256?: string; size: number },
  ) => {
    const prior = observed.get(url);
    if (prior !== undefined && !jsonEqual(prior, value)) {
      throw new Error(`candidate VFS lazy URL ${url} has conflicting identities`);
    }
    observed.set(url, value);
  };

  const vfs = await restoreVerifiedVfsImage(vfsBytes, {
    maxDecompressedBytes: MAX_EVIDENCE_VFS_DECOMPRESSED_BYTES,
  });
  const metadata = vfs.getImageMetadata();
  if (
    metadata?.kernelAbi === undefined ||
    metadata.abiSnapshotSha256 === undefined
  ) {
    throw new Error("candidate VFS lacks explicit ABI metadata");
  }
  if (
    metadata.kernelAbi !== targetAbi.version ||
    metadata.abiSnapshotSha256 !== targetAbi.snapshot_sha256
  ) {
    throw new Error("candidate VFS metadata differs from the exact runtime ABI");
  }
  for (const entry of vfs.exportLazyEntries()) {
    record(entry.url, { kind: "file", size: entry.size });
  }
  for (const entry of vfs.exportLazyArchiveEntries()) {
    if (entry.materialized) {
      throw new Error(`candidate VFS lazy tree ${entry.url} is already materialized`);
    }
    const identity = entry.content ?? entry.integrity;
    if (identity === undefined) {
      throw new Error(`candidate VFS lazy tree ${entry.url} lacks exact integrity`);
    }
    record(entry.url, {
      kind: "tree",
      sha256: identity.sha256,
      size: identity.bytes,
    });
  }

  for (const [url, value] of observed) {
    const requirement = expected.get(url);
    if (requirement === undefined) {
      throw new Error(`candidate VFS contains an unbound lazy reference ${url}`);
    }
    if (
      value.size !== requirement.size ||
      (value.sha256 !== undefined && value.sha256 !== requirement.sha256)
    ) {
      throw new Error(`candidate VFS lazy reference ${url} differs from resolved inputs`);
    }
  }
  for (const url of expected.keys()) {
    if (!observed.has(url)) {
      throw new Error(`resolved lazy input ${url} is absent from the candidate VFS`);
    }
  }
}

export function expectedLazyInputIds(
  definition: GeneratedEvidenceDefinitionV1,
): string[] {
  if (definition.probe.lazy_inputs === undefined) return [];
  const values = stringArray(
    definition.probe.lazy_inputs,
    "evidence expected lazy input IDs",
  );
  if (values.length > 32) {
    throw new Error("evidence expected lazy input IDs exceed their item bound");
  }
  let previous = "";
  return values.map((value, index) => {
    const id = stableId(value, `evidence expected lazy input ${index}`);
    if (id <= previous) {
      throw new Error("evidence expected lazy input IDs are not sorted and unique");
    }
    previous = id;
    return id;
  });
}

const GHCR_IMMUTABLE_BLOB =
  /^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:([0-9a-f]{64})$/;

function candidateLazySource(
  requirement: CandidateLazyRequirementV1,
): ClosedLazyAssetSource {
  const oci = GHCR_IMMUTABLE_BLOB.exec(requirement.url);
  let sourceUrl: string;
  if (oci !== null) {
    if (oci[2] !== requirement.sha256) {
      throw new Error(`lazy resolved product input ${requirement.id} OCI digest differs`);
    }
    sourceUrl = `https://ghcr.io/v2/${oci[1]}/blobs/sha256:${oci[2]}`;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(requirement.url);
    } catch (error) {
      throw new Error(
        `lazy resolved product input ${requirement.id} lacks a fetchable immutable URL`,
        { cause: error },
      );
    }
    if (
      parsed.protocol !== "https:" || parsed.username !== "" ||
      parsed.password !== "" || parsed.hash !== "" ||
      parsed.href !== requirement.url
    ) {
      throw new Error(
        `lazy resolved product input ${requirement.id} lacks a canonical HTTPS source`,
      );
    }
    sourceUrl = requirement.url;
  }
  return {
    url: requirement.url,
    sourceUrl,
    sha256: requirement.sha256,
    size: requirement.size,
  };
}

export function candidateLazyAssetSources(
  requirements: readonly CandidateLazyRequirementV1[],
  expectedIds: readonly string[],
): ClosedLazyAssetSource[] {
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  return expectedIds.map((id) => {
    const requirement = byId.get(id);
    if (requirement === undefined) {
      throw new Error(`protected lazy input ${id} is not an exact lazy product input`);
    }
    return candidateLazySource(requirement);
  });
}

function validateCandidateLazyAssetSources(
  requirements: readonly CandidateLazyRequirementV1[],
  sources: readonly ClosedLazyAssetSource[],
  expectedIds: readonly string[],
): void {
  const expected = candidateLazyAssetSources(requirements, expectedIds);
  if (!jsonEqual(sources, expected)) {
    throw new Error("closed candidate lazy sources differ from protected product inputs");
  }
}

function validateProtectedNodeLazyAssets(
  requirements: readonly CandidateLazyRequirementV1[],
  assets: readonly ClosedLazyAsset[],
  expectedIds: readonly string[],
): void {
  const byUrl = new Map(assets.map((asset) => [asset.url, asset]));
  if (byUrl.size !== assets.length || assets.length !== expectedIds.length) {
    throw new Error("protected Node lazy bytes differ from the selected lazy input set");
  }
  const requirementsById = new Map(
    requirements.map((requirement) => [requirement.id, requirement]),
  );
  for (const id of expectedIds) {
    const requirement = requirementsById.get(id);
    const asset = requirement === undefined ? undefined : byUrl.get(requirement.url);
    if (
      requirement === undefined || asset === undefined ||
      asset.size !== requirement.size || asset.sha256 !== requirement.sha256 ||
      asset.bytes.byteLength !== requirement.size ||
      sha256Hex(asset.bytes) !== requirement.sha256
    ) {
      throw new Error(`protected Node lazy bytes differ for input ${id}`);
    }
  }
}

export async function runNodeProductEvidence(
  inputs: NodeEvidenceExecutionInputs,
  adapter: NodeEvidenceAdapter,
  dependencies: NodeEvidenceRunnerDependencies = {},
): Promise<ProductEvidenceResultV1> {
  const lazyRequirements = validateNodeEvidenceContext(inputs);
  const context = inputs.context;
  const runWithTimeout = dependencies.runWithTimeout ?? defaultRunWithTimeout;
  const cleanupTimeoutMilliseconds = dependencies.cleanupTimeoutMilliseconds ??
    DEFAULT_EVIDENCE_CLEANUP_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(cleanupTimeoutMilliseconds) ||
    cleanupTimeoutMilliseconds < 1 ||
    cleanupTimeoutMilliseconds > MAX_EVIDENCE_CLEANUP_TIMEOUT_MILLISECONDS
  ) {
    throw new Error("evidence cleanup timeout exceeds its protected bound");
  }
  let outcome: ProductEvidenceResultV1["outcome"] = "success";
  let guardCodes: ProductEvidenceResultV1["guard_codes"] = [];
  let stdout = "";
  let stderr = "";
  let runnerDiagnostic = "";
  const cleanupDiagnostics: string[] = [];
  try {
    const observation = await runWithTimeout(
      (async () => {
        await validateCandidateVfsLazyInventory(
          inputs.vfsBytes,
          lazyRequirements,
          inputs.context.runtime.target_abi,
        );
        return executeDefinitionAndValidateLazy(inputs, adapter);
      })(),
      context.definition.timeout_seconds * 1_000,
    );
    stdout = observation.stdout;
    stderr = observation.stderr;
  } catch (error) {
    if (error instanceof EvidenceFailure) {
      stdout = error.stdout;
      stderr = error.stderr;
    }
    runnerDiagnostic = errorMessage(error);
    if (error instanceof EvidenceTimeoutError) {
      outcome = "timeout";
      guardCodes = ["verification_timeout"];
      const diagnostic = await boundedEvidenceCleanup(
        "cancel",
        () => adapter.cancel(),
        cleanupTimeoutMilliseconds,
      );
      if (diagnostic !== undefined) cleanupDiagnostics.push(diagnostic);
    } else {
      outcome = "failure";
      guardCodes = ["verification_failed"];
    }
  } finally {
    const diagnostic = await boundedEvidenceCleanup(
      "dispose",
      () => adapter.dispose(),
      cleanupTimeoutMilliseconds,
    );
    if (diagnostic !== undefined) cleanupDiagnostics.push(diagnostic);
  }
  const cleanupDiagnostic = cleanupDiagnostics.join("\n");
  if (cleanupDiagnostic !== "") {
    runnerDiagnostic = runnerDiagnostic === ""
      ? cleanupDiagnostic
      : `${runnerDiagnostic}\n${cleanupDiagnostic}`;
    if (outcome === "success") {
      outcome = "failure";
      guardCodes = ["verification_failed"];
    }
  }

  return terminalProductEvidenceResult(context, "node", outcome, {
    runner: runnerDiagnostic,
    stderr,
    stdout,
  });
}

async function boundedEvidenceCleanup(
  label: "cancel" | "dispose",
  operation: () => Promise<void>,
  timeoutMilliseconds: number,
): Promise<string | undefined> {
  try {
    await defaultRunWithTimeout(
      Promise.resolve().then(operation),
      timeoutMilliseconds,
    );
    return undefined;
  } catch (error) {
    if (error instanceof EvidenceTimeoutError) {
      return `evidence ${label} exceeded its ${timeoutMilliseconds}-millisecond cleanup bound`;
    }
    return `evidence ${label} failed: ${errorMessage(error)}`;
  }
}

async function executeDefinitionAndValidateLazy(
  inputs: NodeEvidenceExecutionInputs,
  adapter: NodeEvidenceAdapter,
): Promise<{ stdout: string; stderr: string }> {
  const observation = await executeDefinition(inputs.context, adapter);
  assertLazyMaterialization(inputs, await adapter.lazyDownloads());
  return observation;
}

function assertLazyMaterialization(
  inputs: NodeEvidenceExecutionInputs,
  eventsValue: readonly EvidenceLazyDownloadEventV1[],
): void {
  if (!Array.isArray(eventsValue) || eventsValue.length > 2_048) {
    throw new EvidenceFailure("lazy materialization events exceed their item bound");
  }
  const expected = new Map(
    inputs.lazyAssetSources.map((source) => [source.url, source]),
  );
  const byUrl = new Map<string, EvidenceLazyDownloadEventV1[]>();
  for (const [index, eventValue] of eventsValue.entries()) {
    const event = exactRecordWithOptional(
      eventValue,
      ["loaded_bytes", "phase", "status", "url"],
      ["total_bytes"],
      `lazy materialization event ${index}`,
    );
    if (event.phase !== "initialization" && event.phase !== "operation") {
      throw new EvidenceFailure("lazy materialization event has an invalid phase");
    }
    if (
      event.status !== "started" && event.status !== "progress" &&
      event.status !== "complete" && event.status !== "error"
    ) {
      throw new EvidenceFailure("lazy materialization event has an invalid status");
    }
    const url = text(event.url, `lazy materialization event ${index} URL`, 8_192);
    const loaded = nonnegativeInteger(
      event.loaded_bytes,
      `lazy materialization event ${index} loaded bytes`,
    );
    const total = event.total_bytes === undefined
      ? undefined
      : positiveInteger(
        event.total_bytes,
        `lazy materialization event ${index} total bytes`,
      );
    if (event.phase !== "operation") {
      throw new EvidenceFailure("candidate lazy bytes materialized before the protected operation");
    }
    const source = expected.get(url);
    if (source === undefined) {
      throw new EvidenceFailure(`candidate materialized unbound lazy URL ${url}`);
    }
    if (loaded > source.size || (total !== undefined && total !== source.size)) {
      throw new EvidenceFailure(`candidate lazy URL ${url} differs from its exact byte bound`);
    }
    const checked: EvidenceLazyDownloadEventV1 = {
      phase: "operation",
      status: event.status,
      url,
      loaded_bytes: loaded,
      ...(total === undefined ? {} : { total_bytes: total }),
    };
    const events = byUrl.get(url) ?? [];
    events.push(checked);
    byUrl.set(url, events);
  }
  for (const [url, source] of expected) {
    const events = byUrl.get(url);
    if (
      events === undefined || events[0]?.status !== "started" ||
      events.at(-1)?.status !== "complete" ||
      events.at(-1)?.loaded_bytes !== source.size ||
      events.some((event) => event.status === "error")
    ) {
      throw new EvidenceFailure(
        `candidate lazy URL ${url} was not fetched completely during the protected operation`,
      );
    }
  }
  if (byUrl.size !== expected.size) {
    throw new EvidenceFailure("candidate lazy materialization differs from protected policy");
  }
}

export type ProductEvidenceIdentityContextV1 = Pick<
  NodeEvidenceContextV1,
  "candidate_product" | "definition" | "product" | "request_digest" | "run" |
    "runtime"
>;

export function terminalProductEvidenceResult(
  context: ProductEvidenceIdentityContextV1,
  host: ProductEvidenceResultV1["host"],
  outcome: ProductEvidenceResultV1["outcome"],
  streams: Record<"runner" | "stderr" | "stdout", string>,
): ProductEvidenceResultV1 {
  const result: ProductEvidenceResultV1 = {
    schema: 1,
    kind: "kandelo-vfs-product-evidence-result",
    request_digest: context.request_digest,
    product: context.product,
    candidate_product: context.candidate_product,
    runtime: context.runtime,
    host,
    definition: {
      id: context.definition.id,
      definition_sha256: context.definition.definition_sha256,
    },
    outcome,
    guard_codes: outcome === "success"
      ? []
      : outcome === "timeout"
      ? ["verification_timeout"]
      : ["verification_failed"],
    bounded_diagnostics: boundedDiagnostics(streams),
    run: context.run,
  };
  validateProductEvidenceResult(result);
  return result;
}

async function executeDefinition(
  context: NodeEvidenceContextV1,
  adapter: NodeEvidenceAdapter,
): Promise<{ stdout: string; stderr: string }> {
  const definition = context.definition;
  const probe = definition.probe;
  const base: OperationBase = { boot: context.boot, mounts: context.mounts };
  switch (definition.runner) {
    case "exec": {
      const operation: Extract<NodeEvidenceOperation, { kind: "exec" }> = {
        ...base,
        kind: "exec",
        argv: stringArray(probe.argv, "exec argv"),
        env: optionalStringRecord(probe.env, "exec env"),
        ...(probe.stdin === undefined ? {} : { stdin: text(probe.stdin, "exec stdin") }),
      };
      const observed = await adapter.exec(operation);
      const expectedStatus = probe.expected_status === undefined
        ? 0
        : integer(probe.expected_status, "exec expected status");
      if (observed.status !== expectedStatus) {
        throw new EvidenceFailure(
          `exec exited with status ${observed.status}, expected ${expectedStatus}`,
          observed.stdout,
          observed.stderr,
        );
      }
      assertTextPredicates(observed.stdout, probe, "exec stdout", observed);
      return observed;
    }
    case "http": {
      const operation: Extract<NodeEvidenceOperation, { kind: "http" }> = {
        ...base,
        kind: "http",
        path: httpPath(probe.path, "HTTP path"),
      };
      const observed = await adapter.http(operation);
      const expectedStatus = integer(probe.status, "HTTP expected status");
      if (observed.status !== expectedStatus) {
        throw new EvidenceFailure(
          `HTTP status ${observed.status}, expected ${expectedStatus}`,
          observed.stdout,
          observed.stderr,
        );
      }
      assertTextPredicates(observed.body, probe, "HTTP body", observed);
      return observed;
    }
    case "compile": {
      const fixture = text(probe.fixture, "compile fixture");
      if (fixture !== "tiny-sdk-program") throw new Error("compile fixture is unregistered");
      const observed = await adapter.compile({
        ...base,
        kind: "compile",
        fixture,
      });
      if (observed.status !== 0) {
        throw new EvidenceFailure(
          `compile fixture exited with status ${observed.status}`,
          observed.stdout,
          observed.stderr,
        );
      }
      if (observed.stdout !== TINY_SDK_EXPECTED_STDOUT) {
        throw new EvidenceFailure(
          "compiled SDK fixture output differs from its protected value",
          observed.stdout,
          observed.stderr,
        );
      }
      return observed;
    }
    case "sql": {
      const operation: Extract<NodeEvidenceOperation, { kind: "sql" }> = {
        ...base,
        kind: "sql",
        statements: stringArray(probe.statements, "SQL statements"),
      };
      const observed = await adapter.sql(operation);
      const expected = stringArray(probe.results_exact, "SQL exact results");
      if (!jsonEqual(observed.results, expected)) {
        throw new EvidenceFailure(
          `SQL results ${JSON.stringify(observed.results)} differ from ${JSON.stringify(expected)}`,
          observed.stdout,
          observed.stderr,
        );
      }
      return observed;
    }
    case "service-protocol": {
      const protocol = text(probe.protocol, "service protocol");
      if (protocol !== "redis") throw new Error("service protocol is unregistered");
      const operation: Extract<NodeEvidenceOperation, { kind: "service-protocol" }> = {
        ...base,
        kind: "service-protocol",
        protocol,
        request: text(probe.request, "service protocol request"),
      };
      const observed = await adapter.serviceProtocol(operation);
      const expected = text(probe.response_exact, "service protocol response");
      if (observed.response !== expected) {
        throw new EvidenceFailure(
          `service response ${JSON.stringify(observed.response)} differs from ${JSON.stringify(expected)}`,
          observed.stdout,
          observed.stderr,
        );
      }
      return observed;
    }
    case "repository-suite": {
      const suite = text(probe.suite, "repository suite");
      if (!isNodeRepositorySuite(suite)) throw new Error("repository suite is unregistered");
      const observed = await adapter.repositorySuite({
        ...base,
        kind: "repository-suite",
        suite,
      });
      if (observed.status !== 0) {
        throw new EvidenceFailure(
          `registered repository suite exited with status ${observed.status}`,
          observed.stdout,
          observed.stderr,
        );
      }
      return observed;
    }
    case "interactive-terminal":
      throw new Error("interactive-terminal evidence is browser-only");
  }
}

function assertTextPredicates(
  actual: string,
  probe: Record<string, unknown>,
  label: string,
  observed: { stdout: string; stderr: string },
): void {
  if (probe.stdout_exact !== undefined || probe.body_exact !== undefined) {
    const expected = text(probe.stdout_exact ?? probe.body_exact, `${label} exact value`);
    if (actual !== expected) {
      throw new EvidenceFailure(
        `${label} differs from its exact protected value`,
        observed.stdout,
        observed.stderr,
      );
    }
  }
  if (probe.stdout_contains !== undefined || probe.body_contains !== undefined) {
    const expected = text(
      probe.stdout_contains ?? probe.body_contains,
      `${label} contained value`,
    );
    if (!actual.includes(expected)) {
      throw new EvidenceFailure(
        `${label} lacks its protected substring`,
        observed.stdout,
        observed.stderr,
      );
    }
  }
  if (probe.stdout_regex !== undefined || probe.body_regex !== undefined) {
    const expected = text(
      probe.stdout_regex ?? probe.body_regex,
      `${label} regular expression`,
    );
    if (!new RegExp(expected, "u").test(actual)) {
      throw new EvidenceFailure(
        `${label} does not match its protected expression`,
        observed.stdout,
        observed.stderr,
      );
    }
  }
}

export function validateProductEvidenceResult(value: unknown): asserts value is ProductEvidenceResultV1 {
  const result = exactRecord(value, [
    "bounded_diagnostics", "candidate_product", "definition", "guard_codes",
    "host", "kind", "outcome", "product", "request_digest", "run", "runtime",
    "schema",
  ], "product evidence result");
  if (result.schema !== 1 || result.kind !== "kandelo-vfs-product-evidence-result") {
    throw new Error("product evidence result has unsupported identity");
  }
  digest(result.request_digest, "product evidence request digest");
  validateProduct(result.product, "product evidence product");
  validateCandidate(result.candidate_product);
  validateRuntimeIdentity(result.runtime);
  if (result.host !== "node" && result.host !== "browser") {
    throw new Error("product evidence result host is unsupported");
  }
  const definition = exactRecord(
    result.definition,
    ["definition_sha256", "id"],
    "product evidence definition",
  );
  stableId(definition.id, "product evidence definition id");
  digest(definition.definition_sha256, "product evidence definition digest");
  if (!isOutcome(result.outcome)) throw new Error("product evidence outcome is unsupported");
  const guards = array(result.guard_codes, "product evidence guard codes")
    .map((item, index) => stableId(item, `product evidence guard code ${index}`));
  const expected = result.outcome === "success"
    ? []
    : result.outcome === "failure"
    ? ["verification_failed"]
    : ["verification_timeout"];
  if (!jsonEqual(guards, expected)) {
    throw new Error("product evidence outcome and guard codes contradict");
  }
  const diagnostics = array(result.bounded_diagnostics, "product evidence diagnostics");
  if (diagnostics.length > MAX_DIAGNOSTICS) {
    throw new Error("product evidence diagnostics exceed their item bound");
  }
  let previous = "";
  for (const [index, candidate] of diagnostics.entries()) {
    const item = exactRecord(
      candidate,
      ["bytes", "id", "sha256", "text"],
      `product evidence diagnostic ${index}`,
    );
    const id = stableId(item.id, `product evidence diagnostic ${index} id`);
    if (id <= previous) {
      throw new Error("product evidence diagnostics must be sorted and duplicate-free");
    }
    previous = id;
    const body = encoder.encode(text(item.text, `product evidence diagnostic ${id}`));
    if (body.byteLength === 0 || body.byteLength > MAX_DIAGNOSTIC_BYTES) {
      throw new Error("product evidence diagnostic text exceeds its bound");
    }
    if (
      integer(item.bytes, `product evidence diagnostic ${id} bytes`) !== body.byteLength ||
      digest(item.sha256, `product evidence diagnostic ${id} digest`) !== sha256Hex(body)
    ) {
      throw new Error("product evidence diagnostic differs from its bytes");
    }
  }
  validateRun(result.run);
  if (canonicalJsonBytes(result).byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("product evidence result exceeds the 4 MiB limit");
  }
}

function validateContextShape(value: unknown): NodeEvidenceContextV1 {
  const context = exactRecord(value, [
    "boot", "candidate_product", "definition", "host", "kind", "mounts",
    "product", "request_digest", "run", "runtime", "schema",
  ], "Node product evidence context");
  if (context.schema !== 1 || context.kind !== "kandelo-vfs-product-node-evidence-context") {
    throw new Error("Node product evidence context has unsupported identity");
  }
  digest(context.request_digest, "Node evidence request digest");
  validateProduct(context.product, "Node evidence product");
  validateCandidate(context.candidate_product);
  validateRuntimeIdentity(context.runtime);
  if (context.host !== "node") throw new Error("Node product evidence context has a non-Node host");
  validateGeneratedDefinition(context.definition);
  validateBoot(context.boot);
  validateMounts(context.mounts);
  validateRun(context.run);
  return context as unknown as NodeEvidenceContextV1;
}

function validateGeneratedDefinition(value: unknown): void {
  const definition = exactRecord(value, [
    "definition_sha256", "host", "id", "implementation", "probe", "runner",
    "timeout_seconds",
  ], "generated evidence definition") as unknown as GeneratedEvidenceDefinitionV1;
  stableId(definition.id, "evidence definition id");
  if (definition.host !== "node") throw new Error("Node evidence definition has a non-Node host");
  if (!isRunner(definition.runner)) throw new Error("evidence runner is unsupported");
  const timeout = integer(definition.timeout_seconds, "evidence timeout");
  if (timeout < 1 || timeout > 3 * 60 * 60) throw new Error("evidence timeout is out of bounds");
  validateProbe(definition.runner, definition.probe);
  const implementations = array(definition.implementation, "evidence implementation");
  const paths: string[] = [];
  let previous = "";
  for (const item of implementations) {
    const implementation = exactRecord(
      item,
      ["path", "sha256"],
      "evidence implementation entry",
    );
    const path = relativePath(implementation.path, "evidence implementation path");
    if (path <= previous) throw new Error("evidence implementations are not sorted");
    previous = path;
    paths.push(path);
    digest(implementation.sha256, "evidence implementation digest");
  }
  if (!jsonEqual(paths, [
    "apps/browser-demos/lib/mysql-client.ts",
    "apps/browser-demos/lib/redis-client.ts",
    "flake.lock",
    "flake.nix",
    "host/package-lock.json",
    "host/package.json",
    "host/src/generated/abi.ts",
    "host/src/homebrew-bottle-relocation.ts",
    "host/src/homebrew-guest-layout.ts",
    "host/src/pathconf.ts",
    "host/src/statfs.ts",
    "host/src/vfs/deferred-tree-limits.ts",
    "host/src/vfs/hardlink-graph.ts",
    "host/src/vfs/load-image.ts",
    "host/src/vfs/memory-fs.ts",
    "host/src/vfs/product-mount-contract.ts",
    "host/src/vfs/sharedfs-vendor.ts",
    "package-lock.json",
    "package.json",
    "scripts/abi-staging-product-node-evidence.ts",
    "scripts/check-dev-shell-tools.sh",
    "scripts/dev-shell.sh",
    "tools/xtask/src/abi_staging/evidence_policy.rs",
  ])) {
    throw new Error("Node evidence definition is not bound to the protected Node runner");
  }
  if (digest(definition.definition_sha256, "evidence definition digest") !==
    evidenceDefinitionSha256(definition)) {
    throw new Error("evidence definition digest differs from its protected identity");
  }
}

function validateProbe(
  runner: GeneratedEvidenceDefinitionV1["runner"],
  value: unknown,
): void {
  switch (runner) {
    case "exec": {
      const probe = exactRecordWithOptional(value, ["argv"], [
        "env", "expected_status", "lazy_inputs", "stdin", "stdout_contains",
        "stdout_exact", "stdout_regex",
      ], "exec probe");
      stringArray(probe.argv, "exec argv");
      if (probe.env !== undefined) optionalStringRecord(probe.env, "exec env");
      if (probe.stdin !== undefined) text(probe.stdin, "exec stdin");
      if (probe.expected_status !== undefined) integer(probe.expected_status, "exec status");
      validateOnePredicate(probe, "stdout", "exec stdout");
      return;
    }
    case "http": {
      const probe = exactRecordWithOptional(value, ["path", "status"], [
        "body_contains", "body_exact", "body_regex", "lazy_inputs",
      ], "HTTP probe");
      httpPath(probe.path, "HTTP path");
      const status = integer(probe.status, "HTTP status");
      if (status < 100 || status > 599) throw new Error("HTTP status is out of range");
      validateOnePredicate(probe, "body", "HTTP body");
      return;
    }
    case "compile": {
      const probe = exactRecordWithOptional(
        value,
        ["fixture"],
        ["lazy_inputs"],
        "compile probe",
      );
      if (probe.fixture !== "tiny-sdk-program") throw new Error("compile fixture is unregistered");
      return;
    }
    case "sql": {
      const probe = exactRecordWithOptional(
        value,
        ["results_exact", "statements"],
        ["lazy_inputs"],
        "SQL probe",
      );
      const statements = stringArray(probe.statements, "SQL statements");
      const results = stringArray(probe.results_exact, "SQL exact results");
      if (statements.length !== results.length) {
        throw new Error("SQL statements and exact results must have equal length");
      }
      return;
    }
    case "service-protocol": {
      const probe = exactRecordWithOptional(
        value,
        ["protocol", "request", "response_exact"],
        ["lazy_inputs"],
        "service protocol probe",
      );
      if (probe.protocol !== "redis") throw new Error("service protocol is unregistered");
      text(probe.request, "service request");
      text(probe.response_exact, "service response");
      return;
    }
    case "repository-suite": {
      const probe = exactRecordWithOptional(
        value,
        ["suite"],
        ["lazy_inputs"],
        "repository suite probe",
      );
      if (!isNodeRepositorySuite(probe.suite)) throw new Error("repository suite is unregistered");
      return;
    }
    case "interactive-terminal":
      throw new Error("interactive-terminal evidence is browser-only");
  }
}

function validateOnePredicate(
  probe: Record<string, unknown>,
  prefix: "stdout" | "body",
  label: string,
): void {
  const keys = [`${prefix}_exact`, `${prefix}_contains`, `${prefix}_regex`]
    .filter((key) => probe[key] !== undefined);
  if (keys.length !== 1) throw new Error(`${label} requires exactly one predicate`);
  text(probe[keys[0]!], `${label} predicate`);
  if (keys[0]!.endsWith("_regex")) new RegExp(probe[keys[0]!] as string, "u");
}

function validateRuntimeBundle(value: unknown): ExactRuntimeBundleV1 {
  const bundle = exactRecord(value, [
    "browser", "build_policy_sha256", "host", "inventory", "kernel", "kind",
    "schema", "source", "target_abi",
  ], "exact runtime bundle");
  if (bundle.schema !== 1 || bundle.kind !== "kandelo-exact-runtime-bundle") {
    throw new Error("exact runtime bundle has unsupported identity");
  }
  const source = validateSource(bundle.source);
  const target = exactRecord(
    bundle.target_abi,
    ["snapshot_sha256", "version"],
    "runtime target ABI",
  );
  const version = nonnegativeInteger(target.version, "runtime ABI version");
  const snapshot = digest(target.snapshot_sha256, "runtime ABI snapshot");
  const kernel = exactRecord(bundle.kernel, [
    "abi_version", "bytes", "snapshot_sha256", "wasm_sha256",
  ], "runtime kernel");
  const kernelIdentity = {
    wasm_sha256: digest(kernel.wasm_sha256, "runtime kernel digest"),
    bytes: positiveInteger(kernel.bytes, "runtime kernel bytes"),
    abi_version: nonnegativeInteger(kernel.abi_version, "runtime kernel ABI"),
    snapshot_sha256: digest(kernel.snapshot_sha256, "runtime kernel snapshot"),
  };
  if (kernelIdentity.abi_version !== version || kernelIdentity.snapshot_sha256 !== snapshot) {
    throw new Error("runtime kernel differs from the exact target ABI");
  }
  const host = exactRecord(bundle.host, [
    "bundle_sha256", "bytes", "generated_abi_sha256", "worker_protocol_sha256",
  ], "runtime host");
  const hostIdentity = {
    bundle_sha256: digest(host.bundle_sha256, "runtime host bundle"),
    bytes: positiveInteger(host.bytes, "runtime host bytes"),
    generated_abi_sha256: digest(host.generated_abi_sha256, "runtime generated ABI"),
    worker_protocol_sha256: digest(host.worker_protocol_sha256, "runtime worker protocol"),
  };
  const browser = exactRecord(bundle.browser, [
    "bundle_sha256", "bytes", "harness_entry_bytes", "harness_entry_path",
    "harness_entry_sha256", "host_entry_bytes", "host_entry_path",
    "host_entry_sha256", "kernel_asset_path", "kernel_asset_sha256",
    "service_worker_sha256",
  ], "runtime browser");
  const browserHarnessPath = relativePath(
    browser.harness_entry_path,
    "runtime browser harness entry path",
  );
  const browserHostPath = relativePath(
    browser.host_entry_path,
    "runtime browser host entry path",
  );
  const browserKernelPath = relativePath(
    browser.kernel_asset_path,
    "runtime browser kernel asset path",
  );
  const browserIdentity = {
    bundle_sha256: digest(browser.bundle_sha256, "runtime browser bundle"),
    bytes: positiveInteger(browser.bytes, "runtime browser bytes"),
    harness_entry_bytes: positiveInteger(
      browser.harness_entry_bytes,
      "runtime browser harness entry bytes",
    ),
    harness_entry_path: browserHarnessPath,
    harness_entry_sha256: digest(
      browser.harness_entry_sha256,
      "runtime browser harness entry",
    ),
    host_entry_bytes: positiveInteger(
      browser.host_entry_bytes,
      "runtime browser host entry bytes",
    ),
    host_entry_path: browserHostPath,
    host_entry_sha256: digest(
      browser.host_entry_sha256,
      "runtime browser host entry",
    ),
    kernel_asset_path: browserKernelPath,
    kernel_asset_sha256: digest(
      browser.kernel_asset_sha256,
      "runtime browser kernel asset",
    ),
    service_worker_sha256: digest(
      browser.service_worker_sha256,
      "runtime service worker",
    ),
  };
  if (
    browserHarnessPath !== "browser/dist/abi-staging-harness/index.html" ||
    browserIdentity.harness_entry_bytes > MAX_RUNTIME_NODE_ENTRY_BYTES ||
    browserHostPath !== "browser/dist/abi-staging/browser-host.js" ||
    browserIdentity.host_entry_bytes > MAX_RUNTIME_NODE_ENTRY_BYTES ||
    !browserKernelPath.startsWith("browser/dist/") ||
    !browserKernelPath.endsWith(".wasm") ||
    browserIdentity.kernel_asset_sha256 !== kernelIdentity.wasm_sha256
  ) {
    throw new Error("runtime browser kernel asset differs from exact kernel identity");
  }
  const inventory = array(bundle.inventory, "runtime inventory");
  if (inventory.length === 0 || inventory.length > MAX_RUNTIME_FILES) {
    throw new Error("runtime inventory is empty or exceeds its item bound");
  }
  const checked: Array<{ path: string; sha256: string; bytes: number }> = [];
  let previous = "";
  let total = 0;
  for (const [index, value] of inventory.entries()) {
    const item = exactRecord(value, ["bytes", "path", "sha256"], `runtime inventory ${index}`);
    const path = relativePath(item.path, `runtime inventory ${index} path`);
    if (path <= previous) throw new Error("runtime inventory must be sorted and duplicate-free");
    previous = path;
    const entry = {
      path,
      sha256: digest(item.sha256, `runtime inventory ${path} digest`),
      bytes: path.startsWith("toolchain/")
        ? nonnegativeInteger(item.bytes, `runtime inventory ${path} bytes`)
        : positiveInteger(item.bytes, `runtime inventory ${path} bytes`),
    };
    if (entry.bytes > runtimeArtifactByteLimit(path)) {
      throw new Error(`runtime inventory ${path} exceeds its per-file byte bound`);
    }
    checked.push(entry);
    total += entry.bytes;
  }
  if (total > MAX_RUNTIME_BYTES) throw new Error("runtime inventory exceeds its byte bound");
  const byPath = new Map(checked.map((entry) => [entry.path, entry]));
  const exactFile = (path: string, expectedDigest: string, expectedBytes?: number) => {
    const item = byPath.get(path);
    if (
      item === undefined || item.sha256 !== expectedDigest ||
      (expectedBytes !== undefined && item.bytes !== expectedBytes)
    ) throw new Error(`runtime inventory lacks exact ${path}`);
  };
  exactFile("kernel.wasm", kernelIdentity.wasm_sha256, kernelIdentity.bytes);
  exactFile("host/generated-abi.ts", hostIdentity.generated_abi_sha256);
  exactFile("host/worker-protocol.ts", hostIdentity.worker_protocol_sha256);
  exactFile("browser/dist/service-worker.js", browserIdentity.service_worker_sha256);
  exactFile(
    browserIdentity.harness_entry_path,
    browserIdentity.harness_entry_sha256,
    browserIdentity.harness_entry_bytes,
  );
  exactFile(
    browserIdentity.host_entry_path,
    browserIdentity.host_entry_sha256,
    browserIdentity.host_entry_bytes,
  );
  exactFile(
    browserIdentity.kernel_asset_path,
    browserIdentity.kernel_asset_sha256,
    kernelIdentity.bytes,
  );
  for (const path of [
    "flake.lock",
    "host/dist/index.js",
    "host/dist/node-kernel-worker-entry.js",
    "host/package.json",
  ]) {
    if (!byPath.has(path)) {
      throw new Error(`runtime inventory lacks executable Node artifact ${path}`);
    }
  }
  const subset = (prefix: string) => checked.filter((entry) => entry.path.startsWith(prefix));
  const hostFiles = subset("host/");
  const browserFiles = subset("browser/");
  if (
    hostFiles.length === 0 || browserFiles.length === 0 ||
    sha256Hex(canonicalJsonBytes(hostFiles)) !== hostIdentity.bundle_sha256 ||
    hostFiles.reduce((sum, entry) => sum + entry.bytes, 0) !== hostIdentity.bytes ||
    sha256Hex(canonicalJsonBytes(browserFiles)) !== browserIdentity.bundle_sha256 ||
    browserFiles.reduce((sum, entry) => sum + entry.bytes, 0) !== browserIdentity.bytes
  ) throw new Error("runtime host or browser bundle differs from its inventory");
  return {
    schema: 1,
    kind: "kandelo-exact-runtime-bundle",
    source,
    target_abi: { version, snapshot_sha256: snapshot },
    kernel: kernelIdentity,
    host: hostIdentity,
    browser: browserIdentity,
    build_policy_sha256: digest(bundle.build_policy_sha256, "runtime build policy"),
    inventory: checked,
  };
}

function validateRuntimeIdentity(value: unknown): RuntimeEvidenceIdentityV1 {
  const runtime = exactRecord(value, [
    "browser", "build_policy_sha256", "bundle_sha256", "host_runtime", "kernel",
    "source", "target_abi",
  ], "runtime evidence identity");
  const source = validateSource(runtime.source);
  const target = exactRecord(
    runtime.target_abi,
    ["snapshot_sha256", "version"],
    "runtime target ABI identity",
  );
  const targetIdentity = {
    version: nonnegativeInteger(target.version, "runtime ABI version"),
    snapshot_sha256: digest(target.snapshot_sha256, "runtime ABI snapshot"),
  };
  const kernel = exactRecord(runtime.kernel, [
    "abi_version", "bytes", "snapshot_sha256", "wasm_sha256",
  ], "runtime kernel identity");
  const kernelIdentity = {
    wasm_sha256: digest(kernel.wasm_sha256, "runtime kernel digest"),
    bytes: positiveInteger(kernel.bytes, "runtime kernel bytes"),
    abi_version: nonnegativeInteger(kernel.abi_version, "runtime kernel ABI"),
    snapshot_sha256: digest(kernel.snapshot_sha256, "runtime kernel snapshot"),
  };
  if (
    kernelIdentity.abi_version !== targetIdentity.version ||
    kernelIdentity.snapshot_sha256 !== targetIdentity.snapshot_sha256
  ) throw new Error("runtime kernel differs from the exact target ABI");
  const host = exactRecord(runtime.host_runtime, [
    "bundle_sha256", "bytes", "generated_abi_sha256", "worker_protocol_sha256",
  ], "runtime host identity");
  const hostIdentity = {
    bundle_sha256: digest(host.bundle_sha256, "runtime host bundle"),
    bytes: positiveInteger(host.bytes, "runtime host bytes"),
    generated_abi_sha256: digest(host.generated_abi_sha256, "runtime generated ABI"),
    worker_protocol_sha256: digest(host.worker_protocol_sha256, "runtime worker protocol"),
  };
  const browser = exactRecord(runtime.browser, [
    "bundle_sha256", "bytes", "harness_entry_bytes", "harness_entry_path",
    "harness_entry_sha256", "host_entry_bytes", "host_entry_path",
    "host_entry_sha256", "kernel_asset_path", "kernel_asset_sha256",
    "service_worker_sha256",
  ], "runtime browser identity");
  const browserHarnessPath = relativePath(
    browser.harness_entry_path,
    "runtime browser harness entry path",
  );
  const browserHostPath = relativePath(
    browser.host_entry_path,
    "runtime browser host entry path",
  );
  const browserKernelPath = relativePath(
    browser.kernel_asset_path,
    "runtime browser kernel asset path",
  );
  const browserIdentity = {
    bundle_sha256: digest(browser.bundle_sha256, "runtime browser bundle"),
    bytes: positiveInteger(browser.bytes, "runtime browser bytes"),
    harness_entry_bytes: positiveInteger(
      browser.harness_entry_bytes,
      "runtime browser harness entry bytes",
    ),
    harness_entry_path: browserHarnessPath,
    harness_entry_sha256: digest(
      browser.harness_entry_sha256,
      "runtime browser harness entry",
    ),
    host_entry_bytes: positiveInteger(
      browser.host_entry_bytes,
      "runtime browser host entry bytes",
    ),
    host_entry_path: browserHostPath,
    host_entry_sha256: digest(
      browser.host_entry_sha256,
      "runtime browser host entry",
    ),
    kernel_asset_path: browserKernelPath,
    kernel_asset_sha256: digest(
      browser.kernel_asset_sha256,
      "runtime browser kernel asset",
    ),
    service_worker_sha256: digest(
      browser.service_worker_sha256,
      "runtime service worker",
    ),
  };
  if (
    browserHarnessPath !== "browser/dist/abi-staging-harness/index.html" ||
    browserIdentity.harness_entry_bytes > MAX_RUNTIME_NODE_ENTRY_BYTES ||
    browserHostPath !== "browser/dist/abi-staging/browser-host.js" ||
    browserIdentity.host_entry_bytes > MAX_RUNTIME_NODE_ENTRY_BYTES ||
    !browserKernelPath.startsWith("browser/dist/") ||
    !browserKernelPath.endsWith(".wasm") ||
    browserIdentity.kernel_asset_sha256 !== kernelIdentity.wasm_sha256
  ) {
    throw new Error("runtime browser kernel asset differs from exact kernel identity");
  }
  return {
    bundle_sha256: digest(runtime.bundle_sha256, "runtime bundle digest"),
    source,
    target_abi: targetIdentity,
    kernel: kernelIdentity,
    host_runtime: hostIdentity,
    browser: browserIdentity,
    build_policy_sha256: digest(runtime.build_policy_sha256, "runtime build policy"),
  };
}

function validateSource(value: unknown): ExactRuntimeBundleV1["source"] {
  const source = exactRecord(value, ["commit", "repository", "tree"], "runtime source");
  return {
    repository: repository(source.repository, "runtime source repository"),
    commit: gitSha(source.commit, "runtime source commit"),
    tree: gitSha(source.tree, "runtime source tree"),
  };
}

function validateCandidate(value: unknown): void {
  const candidate = exactRecord(value, [
    "builder_report_sha256", "manifest_digest", "vfs_layer_bytes", "vfs_layer_sha256",
  ], "candidate product identity");
  const manifest = text(candidate.manifest_digest, "candidate product manifest digest");
  if (!manifest.startsWith("sha256:")) throw new Error("candidate manifest is not an OCI digest");
  digest(manifest.slice(7), "candidate product manifest digest");
  digest(candidate.vfs_layer_sha256, "candidate VFS digest");
  const bytes = positiveInteger(candidate.vfs_layer_bytes, "candidate VFS bytes");
  if (bytes > MAX_VFS_BYTES) {
    throw new Error("candidate VFS exceeds the 256 MiB evidence limit");
  }
  digest(candidate.builder_report_sha256, "candidate builder report digest");
}

function validateProduct(value: unknown, label: string): void {
  const product = exactRecord(value, ["id", "manifest_sha256"], label);
  stableId(product.id, `${label} id`);
  digest(product.manifest_sha256, `${label} manifest digest`);
}

function validateBoot(value: unknown): void {
  const boot = exactRecord(value, ["argv", "cwd", "env", "gid", "uid"], "boot contract");
  const argv = stringArray(boot.argv, "boot argv");
  if (argv.length > 64) throw new Error("boot argv exceeds its item bound");
  absolutePath(boot.cwd, "boot cwd");
  unsigned32(boot.uid, "boot uid");
  unsigned32(boot.gid, "boot gid");
  const env = environmentRecord(boot.env, "boot environment", false, 8_192);
  if (Object.keys(env).length > 128) throw new Error("boot environment exceeds its item bound");
}

function validateMounts(value: unknown): void {
  const mounts = array(value, "mount contract");
  if (mounts.length === 0 || mounts.length > 64) throw new Error("mount contract is out of bounds");
  const paths = new Set<string>();
  let builtRoot = false;
  for (const candidate of mounts) {
    if (!isRecord(candidate)) throw new Error("mount entry must be an object");
    if (candidate.source === "built-image") {
      const mount = exactRecord(candidate, ["path", "readonly", "source"], "built-image mount");
      const path = absolutePath(mount.path, "built-image mount path");
      if (typeof mount.readonly !== "boolean") throw new Error("built-image readonly must be boolean");
      if (path === "/") builtRoot = true;
      if (paths.has(path)) throw new Error("mount paths must be unique");
      paths.add(path);
    } else if (candidate.source === "scratch") {
      const mount = exactRecord(candidate, [
        "ephemeral", "gid", "mode", "path", "source", "uid",
      ], "scratch mount");
      const path = absolutePath(mount.path, "scratch mount path");
      if (mount.ephemeral !== true || !/^[0-7]{3,4}$/.test(text(mount.mode, "scratch mode"))) {
        throw new Error("scratch mount must be ephemeral with a three- or four-digit octal mode");
      }
      unsigned32(mount.uid, "scratch uid");
      unsigned32(mount.gid, "scratch gid");
      if (paths.has(path)) throw new Error("mount paths must be unique");
      paths.add(path);
    } else {
      throw new Error("mount source is unsupported");
    }
  }
  if (!builtRoot) throw new Error("mount contract lacks the candidate VFS at /");
}

function validateRun(value: unknown): void {
  const run = exactRecord(value, [
    "attempt", "job_id", "repository", "run_id", "workflow_ref",
  ], "product evidence run");
  repository(run.repository, "product evidence run repository");
  text(run.workflow_ref, "product evidence workflow reference", 2_048);
  positiveInteger(run.run_id, "product evidence run id");
  stableId(run.job_id, "product evidence job id");
  positiveInteger(run.attempt, "product evidence attempt");
}

function boundedDiagnostics(streams: Record<"runner" | "stderr" | "stdout", string>) {
  return (Object.entries(streams) as Array<["runner" | "stderr" | "stdout", string]>)
    .filter(([, value]) => value.length > 0)
    .map(([id, value]) => {
      const text = truncateUtf8(value, MAX_DIAGNOSTIC_BYTES);
      const bytes = encoder.encode(text);
      return { id, sha256: sha256Hex(bytes), bytes: bytes.byteLength, text };
    })
    .sort((left, right) => compareOrdinal(left.id, right.id));
}

function truncateUtf8(value: string, maximum: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximum) return value;
  let end = maximum;
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end--;
    }
  }
  return "";
}

async function defaultRunWithTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new EvidenceTimeoutError("protected evidence deadline exceeded")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface CompiledSdkFixtureV1 extends ProcessObservation {
  programBytes: Uint8Array;
  compilerIdentitySha256: string;
}

export interface ExactSdkCompilerSourceV1 {
  sourceRoot: string;
  source: ExactRuntimeBundleV1["source"];
  devShellLockSha256: string;
}

/**
 * Bind SDK compilation to one clean checkout of the exact runtime source.
 * The checkout supplies only the reviewed flake/toolchain declaration; the
 * protected runner still owns fixture bytes and every compiler argument.
 */
export function validateExactSdkCompilerSourceRoot(
  sourceRoot: string,
  source: ExactRuntimeBundleV1["source"],
  devShellLockSha256: string,
): ExactSdkCompilerSourceV1 {
  const sourceMetadata = lstatSync(sourceRoot);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("SDK compiler source root must be a real directory");
  }
  const canonicalRoot = realpathSync.native(sourceRoot);
  const git = join(protectedPathToolDirectory(["git"]), "git");
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    HOME: canonicalRoot,
    LANG: "C",
    LC_ALL: "C",
    PATH: protectedDevShellToolPath(),
  };
  const gitText = (args: readonly string[]) => execFileSync(
    git,
    ["-C", canonicalRoot, ...args],
    {
      encoding: "utf8",
      env: environment,
      maxBuffer: MAX_DOCUMENT_BYTES,
      timeout: 30_000,
    },
  ).trim();
  const commit = gitText(["rev-parse", "--verify", "HEAD"]);
  const tree = gitText(["rev-parse", "--verify", "HEAD^{tree}"]);
  if (commit !== source.commit || tree !== source.tree) {
    throw new Error("SDK compiler checkout differs from the exact runtime source");
  }
  if (gitText(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("SDK compiler requires a clean exact source checkout");
  }
  for (const relative of ["flake.nix", "flake.lock"]) {
    const path = join(canonicalRoot, relative);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`SDK compiler exact source ${relative} is not a regular file`);
    }
  }
  const lockBytes = readRegular(
    join(canonicalRoot, "flake.lock"),
    "SDK compiler exact dev-shell lock",
    MAX_DOCUMENT_BYTES,
  );
  if (sha256Hex(lockBytes) !== devShellLockSha256) {
    throw new Error("SDK compiler checkout differs from the exact dev-shell lock");
  }
  return {
    sourceRoot: canonicalRoot,
    source: { ...source },
    devShellLockSha256,
  };
}

type CompilerProcessObserver = (child: ChildProcess, active: boolean) => void;

interface ExactSdkCompilerToolchainV1 {
  clang: string;
  wasmLd: string;
  directory: string;
  path: string;
  identitySha256: string;
}

async function resolveExactSdkCompilerToolchain(
  source: ExactSdkCompilerSourceV1,
  workRoot: string,
  observeProcess?: CompilerProcessObserver,
): Promise<ExactSdkCompilerToolchainV1> {
  validateExactSdkCompilerSourceRoot(
    source.sourceRoot,
    source.source,
    source.devShellLockSha256,
  );
  const nix = exactNixExecutable();
  const environment = isolatedNixEnvironment(workRoot);
  const result = await runBoundedHostCommand(
    nix,
    [
      "print-dev-env",
      `path:${source.sourceRoot}`,
      "--json",
      "--accept-flake-config",
    ],
    { cwd: source.sourceRoot, env: environment },
    observeProcess,
    MAX_NIX_DEV_ENV_BYTES,
  );
  if (result.status !== 0) {
    throw new Error(
      `exact SDK compiler dev environment failed with status ${result.status}: ` +
        truncateUtf8(result.stderr, MAX_DIAGNOSTIC_BYTES),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`exact SDK compiler dev environment is not JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.variables)) {
    throw new Error("exact SDK compiler dev environment lacks variables");
  }
  const pathVariable = parsed.variables.PATH;
  if (
    !isRecord(pathVariable) || pathVariable.type !== "exported" ||
    typeof pathVariable.value !== "string" || pathVariable.value.length === 0 ||
    encoder.encode(pathVariable.value).byteLength > MAX_NIX_DEV_ENV_BYTES ||
    pathVariable.value.includes("\0")
  ) {
    throw new Error("exact SDK compiler dev environment has an invalid PATH");
  }
  const directory = toolDirectoryFromExactPath(
    pathVariable.value,
    ["clang", "wasm-ld"],
  );
  const storeRoot = nixStoreRoot(nix);
  const tools = [
    ["clang", join(directory, "clang")],
    ["wasm-ld", join(directory, "wasm-ld")],
  ] as const;
  const identities = tools.map(([name, path]) => {
    accessSync(path, fsConstants.X_OK);
    const realPath = realpathSync.native(path);
    if (!realPath.startsWith(`${storeRoot}${sep}`)) {
      throw new Error(`exact SDK compiler ${name} resolves outside the Nix store`);
    }
    const bytes = readRegular(realPath, `exact SDK compiler ${name}`, MAX_RUNTIME_FILE_BYTES);
    return {
      bytes: bytes.byteLength,
      name,
      path: realPath,
      sha256: sha256Hex(bytes),
    };
  });
  const identitySha256 = sha256Hex(canonicalJsonBytes({
    dev_shell_lock_sha256: source.devShellLockSha256,
    source: source.source,
    tools: identities,
  }));
  return {
    clang: join(directory, "clang"),
    wasmLd: join(directory, "wasm-ld"),
    directory,
    path: pathVariable.value,
    identitySha256,
  };
}

function exactNixExecutable(): string {
  const configured = process.env.KANDELO_NIX_BIN;
  if (configured === undefined || !configured.startsWith("/")) {
    throw new Error("exact SDK compiler requires KANDELO_NIX_BIN from scripts/dev-shell.sh");
  }
  const realPath = realpathSync.native(configured);
  const metadata = lstatSync(realPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("exact SDK compiler Nix executable is not a regular file");
  }
  accessSync(realPath, fsConstants.X_OK);
  return realPath;
}

function nixStoreRoot(nix: string): string {
  const match = /^(.*\/store)\/[^/]+\/bin\/nix$/u.exec(nix);
  if (match?.[1] === undefined) {
    throw new Error("exact SDK compiler Nix executable is outside a store closure");
  }
  return match[1];
}

function toolDirectoryFromExactPath(path: string, names: readonly string[]): string {
  for (const entry of path.split(delimiter)) {
    if (!entry.startsWith("/")) continue;
    try {
      for (const name of names) accessSync(join(entry, name), fsConstants.X_OK);
      return entry;
    } catch {
      // Continue until one exact-head dev-shell directory owns the tool pair.
    }
  }
  throw new Error(
    `exact SDK compiler cannot resolve ${names.join(" and ")} from candidate dev-shell PATH`,
  );
}

function isolatedNixEnvironment(workRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_AMBIENT_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const home = join(workRoot, "nix-home");
  const temporary = join(workRoot, "nix-tmp");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(temporary, { mode: 0o700 });
  environment.CI = "true";
  environment.HOME = home;
  environment.LC_ALL = "C";
  environment.TMPDIR = temporary;
  environment.TZ = "UTC";
  return environment;
}

const SDK_COMPILER_INPUTS = [
  { path: "/usr/lib/llvm/lib/clang/21", tree: true },
  { path: "/usr/wasm32posix/glue", tree: true },
  { path: "/usr/wasm32posix/glue-objects", tree: true },
  { path: "/usr/wasm32posix/sysroot", tree: true },
] as const;

interface SdkExtractionState {
  entries: number;
  bytes: number;
}

/**
 * Compile the one protected SDK fixture with repository-declared host tools.
 * The fixture source and compiler driver remain protected reviewed code.
 * Candidate VFS scripts and sources are inert data and are never executed or
 * compiled natively. Only the exact candidate headers, sysroot, glue source,
 * and glue objects are extracted. Clang and wasm-ld are invoked directly with
 * a closed argument list from the exact tool path exported by
 * scripts/dev-shell.sh.
 */
export async function compileSdkFixtureFromCandidateVfs(
  vfsBytes: Uint8Array,
  privateParentRoot: string,
  compilerSource: ExactSdkCompilerSourceV1,
  observeProcess?: CompilerProcessObserver,
): Promise<CompiledSdkFixtureV1> {
  const parent = lstatSync(privateParentRoot);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("SDK compiler parent must be a real private directory");
  }
  const workRoot = mkdtempSync(join(privateParentRoot, "sdk-compiler-"));
  try {
    const extractionRoot = join(workRoot, "candidate");
    mkdirSync(extractionRoot, { mode: 0o700 });
    const fs = await restoreVerifiedVfsImage(vfsBytes, {
      maxDecompressedBytes: MAX_EVIDENCE_VFS_DECOMPRESSED_BYTES,
    });
    const state: SdkExtractionState = { entries: 0, bytes: 0 };
    for (const input of SDK_COMPILER_INPUTS) {
      const stat = fs.lstat(input.path);
      const kind = stat.mode & 0xf000;
      if (kind !== (input.tree ? 0x4000 : 0x8000)) {
        throw new Error(
          `candidate SDK compiler input ${input.path} has the wrong file type`,
        );
      }
      extractSdkCompilerPath(fs, input.path, extractionRoot, state, 0);
    }

    const toolchain = await resolveExactSdkCompilerToolchain(
      compilerSource,
      workRoot,
      observeProcess,
    );
    const llvmDirectory = toolchain.directory;
    const outputDirectory = join(workRoot, "output");
    mkdirSync(outputDirectory, { mode: 0o700 });
    const sourcePath = join(outputDirectory, "protected-tiny-sdk-program.c");
    writeFileSync(sourcePath, TINY_SDK_SOURCE, { encoding: "utf8", mode: 0o600 });
    const sourceObjectPath = join(outputDirectory, "tiny-sdk-program.o");
    const channelObjectPath = join(outputDirectory, "channel_syscall.o");
    const outputPath = join(outputDirectory, "tiny-sdk-program.wasm");
    const environment = isolatedSdkCompilerEnvironment(
      workRoot,
      extractionRoot,
      toolchain.path,
      llvmDirectory,
    );
    const sysroot = sdkCompilerHostPath(
      extractionRoot,
      "/usr/wasm32posix/sysroot",
    );
    const resourceDirectory = sdkCompilerHostPath(
      extractionRoot,
      "/usr/lib/llvm/lib/clang/21",
    );
    const commonCompileArgs = [
      "--target=wasm32-unknown-unknown",
      "-matomics",
      "-mbulk-memory",
      "-mexception-handling",
      "-mllvm",
      "-wasm-enable-sjlj",
      "-mllvm",
      "-wasm-use-legacy-eh=false",
      "-fno-trapping-math",
      "-fintegrated-cc1",
      "-ccc-install-dir",
      llvmDirectory,
      `-B${llvmDirectory}`,
      `--sysroot=${sysroot}`,
      "-resource-dir",
      resourceDirectory,
      "-O2",
    ];
    const sourceCompilation = await runBoundedHostCommand(
      toolchain.clang,
      [...commonCompileArgs, "-c", sourcePath, "-o", sourceObjectPath],
      { cwd: workRoot, env: environment },
      observeProcess,
    );
    if (sourceCompilation.status !== 0) {
      return {
        ...sourceCompilation,
        compilerIdentitySha256: toolchain.identitySha256,
        programBytes: new Uint8Array(),
      };
    }
    const channelSource = sdkCompilerHostPath(
      extractionRoot,
      "/usr/wasm32posix/glue/channel_syscall.c",
    );
    const channelCompilation = await runBoundedHostCommand(
      toolchain.clang,
      [
        ...commonCompileArgs,
        "-DWASM_POSIX_THREAD_SLOT_DECL=0",
        "-c",
        channelSource,
        "-o",
        channelObjectPath,
      ],
      { cwd: workRoot, env: environment },
      observeProcess,
    );
    if (channelCompilation.status !== 0) {
      return {
        ...channelCompilation,
        stdout: sourceCompilation.stdout + channelCompilation.stdout,
        stderr: sourceCompilation.stderr + channelCompilation.stderr,
        compilerIdentitySha256: toolchain.identitySha256,
        programBytes: new Uint8Array(),
      };
    }
    const linkInputs = [
      sourceObjectPath,
      channelObjectPath,
      sdkCompilerHostPath(
        extractionRoot,
        "/usr/wasm32posix/glue-objects/compiler_rt.o",
      ),
      sdkCompilerHostPath(
        extractionRoot,
        "/usr/wasm32posix/glue-objects/cxxrt.o",
      ),
      sdkCompilerHostPath(extractionRoot, "/usr/wasm32posix/sysroot/lib/crt1.o"),
      sdkCompilerHostPath(extractionRoot, "/usr/wasm32posix/sysroot/lib/libc.a"),
    ];
    for (const input of linkInputs.slice(2)) {
      assertExtractedCompilerFile(extractionRoot, input);
    }
    const linking = await runBoundedHostCommand(
      toolchain.wasmLd,
      [
        "-m",
        "wasm32",
        `-L${join(sysroot, "lib")}`,
        ...linkInputs,
        "--entry=_start",
        "--export=_start",
        "--export=__heap_base",
        "--import-memory",
        "--shared-memory",
        "--max-memory=1073741824",
        "--allow-undefined",
        "--global-base=1114112",
        "--table-base=3",
        "--export-table",
        "--growable-table",
        "--export=__wasm_init_tls",
        "--export=__tls_base",
        "--export=__tls_size",
        "--export=__tls_align",
        "--export=__stack_pointer",
        "--export=__wasm_thread_init",
        "--export=__abi_version",
        "-z",
        "stack-size=8388608",
        "-o",
        outputPath,
      ],
      { cwd: workRoot, env: environment },
      observeProcess,
    );
    const compilation = {
      status: linking.status,
      stdout: sourceCompilation.stdout + channelCompilation.stdout + linking.stdout,
      stderr: sourceCompilation.stderr + channelCompilation.stderr + linking.stderr,
    };
    if (compilation.status !== 0) {
      return {
        ...compilation,
        compilerIdentitySha256: toolchain.identitySha256,
        programBytes: new Uint8Array(),
      };
    }
    if (compilation.stdout !== "" || compilation.stderr !== "") {
      throw new Error("protected SDK fixture compilation produced unexpected diagnostics");
    }
    const output = lstatSync(outputPath);
    if (
      !output.isFile() || output.isSymbolicLink() || output.size < 8 ||
      output.size > MAX_SDK_COMPILER_OUTPUT_BYTES
    ) {
      throw new Error("protected SDK fixture compiler output is not a bounded regular file");
    }
    const programBytes = new Uint8Array(readFileSync(outputPath));
    if (
      programBytes[0] !== 0x00 || programBytes[1] !== 0x61 ||
      programBytes[2] !== 0x73 || programBytes[3] !== 0x6d ||
      programBytes[4] !== 0x01 || programBytes[5] !== 0x00 ||
      programBytes[6] !== 0x00 || programBytes[7] !== 0x00
    ) {
      throw new Error("protected SDK fixture compiler output is not WebAssembly v1");
    }
    validateExactSdkCompilerSourceRoot(
      compilerSource.sourceRoot,
      compilerSource.source,
      compilerSource.devShellLockSha256,
    );
    return {
      ...compilation,
      compilerIdentitySha256: toolchain.identitySha256,
      programBytes,
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function assertExtractedCompilerFile(extractionRoot: string, path: string): void {
  const resolved = realpathSync.native(path);
  const canonicalRoot = realpathSync.native(extractionRoot);
  if (!resolved.startsWith(`${canonicalRoot}${sep}`) || !lstatSync(resolved).isFile()) {
    throw new Error("candidate SDK linker input leaves its extraction root");
  }
}

function extractSdkCompilerPath(
  fs: MemoryFileSystem,
  guestPath: string,
  extractionRoot: string,
  state: SdkExtractionState,
  depth: number,
): void {
  if (depth > 64) throw new Error("candidate SDK compiler tree exceeds its depth bound");
  state.entries++;
  if (state.entries > MAX_SDK_COMPILER_FILES) {
    throw new Error("candidate SDK compiler tree exceeds its entry bound");
  }
  const stat = fs.lstat(guestPath);
  const kind = stat.mode & 0xf000;
  const mode = stat.mode & 0o7777;
  const destination = sdkCompilerHostPath(extractionRoot, guestPath);
  if (kind === 0x4000) {
    mkdirSync(destination, { recursive: true, mode });
    chmodSync(destination, mode);
    const directory = fs.opendir(guestPath);
    try {
      const names: string[] = [];
      for (;;) {
        const entry = fs.readdir(directory);
        if (entry === null) break;
        if (entry.name !== "." && entry.name !== "..") names.push(entry.name);
      }
      names.sort(compareOrdinal);
      for (const name of names) {
        extractSdkCompilerPath(
          fs,
          posix.join(guestPath, name),
          extractionRoot,
          state,
          depth + 1,
        );
      }
    } finally {
      fs.closedir(directory);
    }
    return;
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (kind === 0xa000) {
    const target = fs.readlink(guestPath);
    if (encoder.encode(target).byteLength > 4_096 || target.includes("\0")) {
      throw new Error(`candidate SDK symlink ${guestPath} exceeds its bound`);
    }
    const resolvedTarget = posix.resolve(posix.dirname(guestPath), target);
    if (!isSdkCompilerGuestPath(resolvedTarget)) {
      throw new Error(`candidate SDK symlink ${guestPath} escapes compiler inputs`);
    }
    const hostTarget = sdkCompilerHostPath(extractionRoot, resolvedTarget);
    symlinkSync(relative(dirname(destination), hostTarget), destination);
    return;
  }
  if (kind !== 0x8000) {
    throw new Error(`candidate SDK compiler input ${guestPath} is not a file`);
  }
  if (
    !Number.isSafeInteger(stat.size) || stat.size < 0 ||
    stat.size > MAX_SDK_COMPILER_FILE_BYTES ||
    stat.size > MAX_VFS_BYTES - state.bytes
  ) {
    throw new Error(`candidate SDK compiler file ${guestPath} exceeds its byte bound`);
  }
  const bytes = new Uint8Array(stat.size);
  const handle = fs.open(guestPath, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        handle,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0) {
        throw new Error(`candidate SDK compiler file ${guestPath} ended early`);
      }
      offset += count;
    }
  } finally {
    fs.close(handle);
  }
  state.bytes += bytes.byteLength;
  writeFileSync(destination, bytes, { flag: "wx", mode });
  chmodSync(destination, mode);
}

function isSdkCompilerGuestPath(guestPath: string): boolean {
  return SDK_COMPILER_INPUTS.some((input) =>
    guestPath === input.path || (input.tree && guestPath.startsWith(`${input.path}/`))
  );
}

function sdkCompilerHostPath(root: string, guestPath: string): string {
  if (!guestPath.startsWith("/") || guestPath.includes("\0")) {
    throw new Error("candidate SDK compiler path is not absolute");
  }
  const destination = resolve(root, guestPath.slice(1));
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
    throw new Error("candidate SDK compiler path escapes its extraction root");
  }
  return destination;
}

function protectedPathToolDirectory(names: readonly string[]): string {
  const path = protectedDevShellToolPath();
  for (const entry of path.split(delimiter)) {
    if (!entry.startsWith("/")) continue;
    try {
      for (const name of names) accessSync(join(entry, name), fsConstants.X_OK);
      return entry;
    } catch {
      // Continue until one exact directory contains the complete LLVM pair.
    }
  }
  throw new Error(
    `protected SDK compiler cannot resolve ${names.join(" and ")} from dev-shell PATH`,
  );
}

function protectedDevShellToolPath(): string {
  const path = process.env.KANDELO_DEV_SHELL_TOOL_PATH;
  if (path === undefined || path.length === 0) {
    throw new Error("protected SDK compiler must run through scripts/dev-shell.sh");
  }
  return path;
}

function isolatedSdkCompilerEnvironment(
  workRoot: string,
  extractionRoot: string,
  exactToolPath: string,
  llvmDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_AMBIENT_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const home = join(workRoot, "home");
  const temporary = join(workRoot, "tmp");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(temporary, { mode: 0o700 });
  environment.CI = "true";
  environment.HOME = home;
  environment.LC_ALL = "C";
  environment.TMPDIR = temporary;
  environment.TZ = "UTC";
  environment.PATH = exactToolPath;
  environment.WASM_POSIX_CLANG_RESOURCE_DIR = sdkCompilerHostPath(
    extractionRoot,
    "/usr/lib/llvm/lib/clang/21",
  );
  environment.WASM_POSIX_CXX_DRIVER = "0";
  environment.WASM_POSIX_GLUE_DIR = sdkCompilerHostPath(
    extractionRoot,
    "/usr/wasm32posix/glue",
  );
  environment.WASM_POSIX_GLUE_OBJ_DIR = sdkCompilerHostPath(
    extractionRoot,
    "/usr/wasm32posix/glue-objects",
  );
  environment.WASM_POSIX_LLVM_DIR = llvmDirectory;
  environment.WASM_POSIX_SYSROOT = sdkCompilerHostPath(
    extractionRoot,
    "/usr/wasm32posix/sysroot",
  );
  return environment;
}

async function runBoundedHostCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  observeProcess?: CompilerProcessObserver,
  outputByteLimit = MAX_CHILD_STREAM_BYTES,
): Promise<ProcessObservation> {
  return new Promise((resolveResult, rejectResult) => {
    const stdout = new BoundedChildStream(outputByteLimit);
    const stderr = new BoundedChildStream(outputByteLimit);
    const child = spawn(command, [...args], {
      ...options,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    observeProcess?.(child, true);
    let settled = false;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("protected SDK compiler exceeded its deadline");
      killChildProcessTree(child);
    }, MAX_SDK_COMPILER_SECONDS * 1_000);
    const capture = (stream: BoundedChildStream, chunk: Buffer, label: string) => {
      stream.append(chunk);
      if (stream.overflow && failure === undefined) {
        failure = new Error(`protected SDK compiler ${label} exceeded its byte bound`);
        killChildProcessTree(child);
      }
    };
    child.stdout!.on("data", (chunk: Buffer) => capture(stdout, chunk, "stdout"));
    child.stderr!.on("data", (chunk: Buffer) => capture(stderr, chunk, "stderr"));
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observeProcess?.(child, false);
      if (failure !== undefined) {
        rejectResult(failure);
        return;
      }
      resolveResult({
        status: code ?? (signal === null ? 1 : 128),
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });
  });
}

function killChildProcessTree(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct handle if process-group creation raced launch.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // A process that already exited needs no further cleanup.
  }
}

export function nodeEvidenceHostOptions(
  inputs: NodeEvidenceExecutionInputs,
  onStdout: NonNullable<NodeKernelHostOptions["onStdout"]>,
  onStderr: NonNullable<NodeKernelHostOptions["onStderr"]>,
): NodeKernelHostOptions {
  return {
    maxWorkers: EVIDENCE_MAX_WORKERS,
    maxProcessMemoryBytes: EVIDENCE_MAX_PROCESS_MEMORY_BYTES,
    rootfsImage: inputs.vfsBytes,
    ...(inputs.lazyAssets === undefined
      ? { rootfsLazyAssetSources: inputs.lazyAssetSources }
      : { rootfsLazyAssets: inputs.lazyAssets }),
    rootfsMountSpec: hostMountSpecFromProductMounts(inputs.context.mounts),
    onStdout,
    onStderr,
  };
}

class KernelNodeEvidenceAdapter implements NodeEvidenceAdapter {
  private readonly stdout: BoundedEvidenceOutput;
  private readonly stderr: BoundedEvidenceOutput;
  private readonly lazyEvents: EvidenceLazyDownloadEventV1[] = [];
  private lazyCaptureError: Error | undefined;
  private lazyPhase: EvidenceLazyDownloadEventV1["phase"] = "initialization";
  private unsubscribeLazyDownloads: (() => void) | undefined;
  private servicePids = new Set<number>();

  private constructor(
    private readonly host: NodeKernelHost,
    stdout: BoundedEvidenceOutput,
    stderr: BoundedEvidenceOutput,
  ) {
    this.stdout = stdout;
    this.stderr = stderr;
  }

  static async create(
    inputs: NodeEvidenceExecutionInputs,
    Host: NodeKernelHostConstructor,
  ): Promise<KernelNodeEvidenceAdapter> {
    const stdout = new BoundedEvidenceOutput(MAX_DIAGNOSTIC_BYTES, "stdout");
    const stderr = new BoundedEvidenceOutput(MAX_DIAGNOSTIC_BYTES, "stderr");
    const host = new Host(nodeEvidenceHostOptions(
      inputs,
      (pid, bytes) => stdout.append(pid, bytes),
      (pid, bytes) => stderr.append(pid, bytes),
    ));
    const adapter = new KernelNodeEvidenceAdapter(host, stdout, stderr);
    adapter.unsubscribeLazyDownloads = host.subscribeLazyDownloads((event) => {
      adapter.captureLazyDownload(event);
    });
    await host.init(toArrayBuffer(inputs.kernelWasmBytes));
    return adapter;
  }

  async exec(operation: Extract<NodeEvidenceOperation, { kind: "exec" }>) {
    this.beginOperation();
    const { pid: _pid, exit } = await this.host.spawnFromVfs(
      operation.argv[0]!,
      operation.argv,
      spawnOptions(operation.boot, operation.env, operation.stdin),
    );
    const status = await exit;
    return this.processObservation(status);
  }

  async http(operation: Extract<NodeEvidenceOperation, { kind: "http" }>) {
    this.beginOperation();
    const service = await this.startService(operation.boot.argv, operation.boot);
    await waitForListenerTarget(this.host, 80, service.exit);
    const response = await this.host.fetchInKernel(80, {
      method: "GET",
      url: operation.path,
      headers: { Host: "localhost" },
      body: null,
    }, { maxResponseBytes: MAX_DIAGNOSTIC_BYTES });
    return {
      status: response.status,
      body: new TextDecoder().decode(response.body),
      ...this.output(),
    };
  }

  async compile(operation: Extract<NodeEvidenceOperation, { kind: "compile" }>) {
    this.beginOperation();
    const encoded = operation.compiled_program_base64;
    if (encoded === undefined || encoded.length > MAX_SDK_COMPILER_OUTPUT_BYTES * 2) {
      throw new Error("protected SDK compiler program handoff is absent or oversized");
    }
    const programBytes = Buffer.from(encoded, "base64");
    if (
      programBytes.byteLength < 8 ||
      programBytes.byteLength > MAX_SDK_COMPILER_OUTPUT_BYTES ||
      programBytes.toString("base64") !== encoded
    ) {
      throw new Error("protected SDK compiler program handoff is not canonical base64");
    }
    const status = await this.host.spawn(
      toArrayBuffer(programBytes),
      ["/tmp/tiny-sdk-program.wasm"],
      spawnOptions(operation.boot, {}),
    );
    return this.processObservation(status);
  }

  async sql(operation: Extract<NodeEvidenceOperation, { kind: "sql" }>) {
    this.beginOperation();
    const service = await this.startService(operation.boot.argv, operation.boot);
    await waitForListenerTarget(this.host, 3306, service.exit);
    const client = await MySqlBrowserClient.connect(
      createBoundedKernelPipeTransport(this.host, MAX_DIAGNOSTIC_BYTES),
      3306,
    );
    const results: string[] = [];
    try {
      for (const statement of operation.statements) {
        results.push(formatMysqlEvidenceResult(await client.query(statement)));
      }
    } finally {
      client.close();
    }
    return { results, ...this.output() };
  }

  async serviceProtocol(
    operation: Extract<NodeEvidenceOperation, { kind: "service-protocol" }>,
  ) {
    this.beginOperation();
    const service = await this.startService(operation.boot.argv, operation.boot);
    await waitForListenerTarget(this.host, 6379, service.exit);
    const client = await RedisBrowserClient.connect(
      createBoundedKernelPipeTransport(this.host, MAX_DIAGNOSTIC_BYTES),
      6379,
    );
    return {
      response: formatRedisEvidenceResult(await client.command(operation.request)),
      ...this.output(),
    };
  }

  async repositorySuite(
    operation: Extract<NodeEvidenceOperation, { kind: "repository-suite" }>,
  ): Promise<ProcessObservation> {
    // Candidate data selects only this protected ID. Commands, readiness
    // conditions, and pass predicates all remain reviewed runner code.
    const suite = protectedNodeSuiteDefinition(operation.suite);
    this.beginOperation();
    if (suite.service !== undefined) {
      const service = await this.startService([...operation.boot.argv], operation.boot);
      await waitForListenerTarget(this.host, suite.service.port, service.exit);
      if (suite.service.port === 3306) {
        const client = await MySqlBrowserClient.connect(
          createBoundedKernelPipeTransport(this.host, MAX_DIAGNOSTIC_BYTES),
          suite.service.port,
        );
        try {
          await client.query("SELECT 1");
        } finally {
          client.close();
        }
      }
    }
    for (const step of suite.steps) {
      this.resetOutput();
      const process = await this.host.spawnFromVfs(
        step.argv[0],
        [...step.argv],
        spawnOptions(operation.boot, { ...step.env }),
      );
      const observation = this.processObservation(await process.exit, process.pid);
      validateProtectedNodeSuiteStep(step, observation);
    }
    return { status: 0, ...this.output() };
  }

  async cancel(): Promise<void> {
    await this.destroyServices();
  }

  async lazyDownloads(): Promise<readonly EvidenceLazyDownloadEventV1[]> {
    if (this.lazyCaptureError !== undefined) throw this.lazyCaptureError;
    return this.lazyEvents.map((event) => ({ ...event }));
  }

  async dispose(): Promise<void> {
    await this.destroyServices();
    await this.host.destroy();
    this.unsubscribeLazyDownloads?.();
    this.unsubscribeLazyDownloads = undefined;
  }

  private async startService(argv: string[], boot: VfsBootContractV1) {
    const service = await this.host.spawnFromVfs(
      argv[0]!,
      argv,
      spawnOptions(boot, {}),
    );
    this.servicePids.add(service.pid);
    void service.exit.then(() => this.servicePids.delete(service.pid));
    return service;
  }

  private async destroyServices(): Promise<void> {
    await Promise.all(
      [...this.servicePids].map((pid) => this.host.terminateProcess(pid).catch(() => {})),
    );
    this.servicePids.clear();
  }

  private resetOutput(): void {
    this.stdout.clear();
    this.stderr.clear();
  }

  private beginOperation(): void {
    if (this.lazyPhase === "operation") {
      throw new Error("protected evidence adapter started more than one operation");
    }
    this.lazyPhase = "operation";
    this.resetOutput();
  }

  private captureLazyDownload(event: LazyDownloadEvent): void {
    if (this.lazyCaptureError !== undefined) return;
    try {
      if (this.lazyEvents.length >= 2_048) {
        throw new Error("lazy materialization events exceed their item bound");
      }
      if (
        typeof event.url !== "string" || encoder.encode(event.url).byteLength > 8_192 ||
        !Number.isSafeInteger(event.loadedBytes) || event.loadedBytes < 0 ||
        (event.totalBytes !== undefined &&
          (!Number.isSafeInteger(event.totalBytes) || event.totalBytes <= 0))
      ) {
        throw new Error("candidate host emitted an invalid lazy materialization event");
      }
      this.lazyEvents.push({
        phase: this.lazyPhase,
        status: event.status,
        url: event.url,
        loaded_bytes: event.loadedBytes,
        ...(event.totalBytes === undefined ? {} : { total_bytes: event.totalBytes }),
      });
    } catch (error) {
      this.lazyCaptureError = error instanceof Error ? error : new Error(String(error));
    }
  }

  private output(pid?: number) {
    return {
      stdout: this.stdout.decode(pid),
      stderr: this.stderr.decode(pid),
    };
  }

  private processObservation(status: number, pid?: number): ProcessObservation {
    return { status, ...this.output(pid) };
  }

}

async function waitForListenerTarget(
  host: NodeKernelHost,
  port: number,
  serviceExit: Promise<number>,
): Promise<void> {
  let exitStatus: number | undefined;
  void serviceExit.then((status) => {
    exitStatus = status;
  });
  for (;;) {
    if (await host.pickListenerTarget(port) !== null) return;
    if (exitStatus !== undefined) {
      throw new Error(
        `service exited with status ${exitStatus} before listening on port ${port}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const MYSQLTEST_BASE_ARGV = [
  "/usr/bin/mysqltest",
  "--no-defaults",
  "--host=127.0.0.1",
  "--port=3306",
  "--user=root",
  "--database=test",
  "--basedir=/mysql-test",
  "--tmpdir=/tmp",
  "--silent",
  "--protocol=tcp",
] as const;

const MYSQLTEST_ENV = {
  HOME: "/tmp",
  MYSQLTEST_VARDIR: "/data",
  MYSQL_TEST_DIR: "/mysql-test",
  MYSQL_TMP_DIR: "/tmp",
  PATH: "/usr/bin:/bin",
  TMPDIR: "/tmp",
} as const;

const PHP_ZEND_004_PHPT_HARNESS = [
  "$path='/php-src/Zend/tests/004.phpt';",
  "$source=file_get_contents($path);",
  "if($source===false){fwrite(STDERR,'cannot read protected PHPT\\n');exit(1);}",
  "$parts=preg_split('/^--([A-Z_]+)--\\R/m',$source,-1,PREG_SPLIT_DELIM_CAPTURE);",
  "if($parts===false){fwrite(STDERR,'cannot parse protected PHPT\\n');exit(1);}",
  "$sections=[];",
  "for($i=1;$i<count($parts);$i+=2){$sections[$parts[$i]]=$parts[$i+1]??'';}",
  "if(array_keys($sections)!==['TEST','FILE','EXPECT']){",
  "fwrite(STDERR,'protected PHPT sections changed\\n');exit(1);}",
  "ob_start();",
  "try{eval('?>'.$sections['FILE']);}finally{$actual=ob_get_clean();}",
  "$normalize=static fn($value)=>str_replace([\"\\r\\n\",\"\\r\"],\"\\n\",$value);",
  "if($normalize($actual)!==$normalize($sections['EXPECT'])){",
  "fwrite(STDERR,'protected PHPT output mismatch\\n'.substr($actual,0,4096));exit(1);}",
  "echo \"phpt-pass:Zend/tests/004.phpt\\n\";",
].join("");

const PROTECTED_NODE_SUITES: Readonly<Record<
  NodeRepositorySuite,
  ProtectedNodeSuiteDefinition
>> = {
  "mariadb-product-node": {
    service: { argv: "product-boot", port: 3306 },
    steps: [
      {
        id: "initialize-test-databases",
        argv: [
          ...MYSQLTEST_BASE_ARGV,
          "--test-file=/mysql-test/main/__setup.test",
        ],
        env: MYSQLTEST_ENV,
        stdout: { kind: "exact", value: "" },
      },
      {
        id: "upstream-main-1st",
        argv: [
          ...MYSQLTEST_BASE_ARGV,
          "--test-file=/mysql-test/main/1st.test",
        ],
        env: MYSQLTEST_ENV,
        stdout: { kind: "exact", value: "" },
      },
    ],
  },
  "php-product-node": {
    steps: [
      {
        id: "upstream-zend-004-phpt",
        argv: [
          "/usr/local/bin/php",
          "-r",
          PHP_ZEND_004_PHPT_HARNESS,
        ],
        stdout: { kind: "exact", value: "phpt-pass:Zend/tests/004.phpt\n" },
      },
      {
        id: "pdo-sqlite-round-trip",
        argv: [
          "/usr/local/bin/php",
          "-r",
          "$db=new PDO('sqlite::memory:');"
            + "$db->exec('CREATE TABLE evidence(value INTEGER)');"
            + "$db->exec('INSERT INTO evidence VALUES (17)');"
            + "echo $db->query('SELECT value FROM evidence')->fetchColumn(),\"\\n\";",
        ],
        stdout: { kind: "exact", value: "17\n" },
      },
    ],
  },
  "sqlite-product-node": {
    steps: [
      {
        id: "upstream-select1",
        argv: ["/usr/bin/testfixture", "test/select1.test"],
        stdout: { kind: "contains", value: "0 errors out of" },
      },
      {
        id: "upstream-func",
        argv: ["/usr/bin/testfixture", "test/func.test"],
        stdout: { kind: "contains", value: "0 errors out of" },
      },
    ],
  },
};

export function protectedNodeSuiteDefinition(
  suite: NodeRepositorySuite,
): ProtectedNodeSuiteDefinition {
  return PROTECTED_NODE_SUITES[suite];
}

export function validateProtectedNodeSuiteStep(
  step: ProtectedNodeSuiteStep,
  observation: ProcessObservation,
): void {
  if (observation.status !== 0) {
    throw new EvidenceFailure(
      `registered suite step ${step.id} exited with status ${observation.status}`,
      observation.stdout,
      observation.stderr,
    );
  }
  const outputMatches = step.stdout.kind === "exact"
    ? observation.stdout === step.stdout.value
    : observation.stdout.includes(step.stdout.value);
  if (!outputMatches) {
    throw new EvidenceFailure(
      `registered suite step ${step.id} lacks its protected output`,
      observation.stdout,
      observation.stderr,
    );
  }
}

function spawnOptions(
  boot: VfsBootContractV1,
  probeEnv: Record<string, string>,
  stdin?: string,
) {
  const env = { ...boot.env, ...probeEnv };
  return {
    cwd: boot.cwd,
    uid: boot.uid,
    gid: boot.gid,
    env: Object.entries(env).sort(([left], [right]) => compareOrdinal(left, right))
      .map(([name, value]) => `${name}=${value}`),
    ...(stdin === undefined ? {} : { stdin: encoder.encode(stdin) }),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

export function assertUncredentialedEnvironment(environment: NodeJS.ProcessEnv): void {
  const forbidden = [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "CARGO_REGISTRY_TOKEN",
    "GHCR_PAT",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HOMEBREW_DOCKER_REGISTRY_TOKEN",
    "HOMEBREW_GITHUB_API_TOKEN",
    "HOMEBREW_GITHUB_PACKAGES_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "SSH_AUTH_SOCK",
  ];
  const present = forbidden.filter((name) => environment[name] !== undefined);
  if (present.length > 0) {
    throw new Error(`candidate evidence environment contains credentials: ${present.join(", ")}`);
  }
}

interface CliInputOptions {
  builderReport: string;
  context: string;
  candidateLocator: string;
  definitions: string;
  products: string;
  resolvedInputs: string;
  runtimeBundle: string;
  runtimeRoot: string;
  lazyInputs?: string;
  sourceRoot?: string;
  vfs: string;
}

export interface CliOptions extends CliInputOptions {
  output: string;
}

interface PreparedCliEvidence {
  context: NodeEvidenceContextV1;
  artifacts: ExactRuntimeArtifactRootV1;
  inputs: NodeEvidenceExecutionInputs;
  compilerSource?: ExactSdkCompilerSourceV1;
}

function parseArgs(args: readonly string[]): CliOptions {
  const flags = new Map([
    ["--builder-report", "builderReport"],
    ["--context", "context"],
    ["--candidate-locator", "candidateLocator"],
    ["--definitions", "definitions"],
    ["--products", "products"],
    ["--resolved-inputs", "resolvedInputs"],
    ["--runtime-bundle", "runtimeBundle"],
    ["--runtime-root", "runtimeRoot"],
    ["--lazy-inputs", "lazyInputs"],
    ["--source-root", "sourceRoot"],
    ["--vfs", "vfs"],
    ["--output", "output"],
  ] as const);
  const parsed: Partial<CliOptions> = {};
  if (args.length % 2 !== 0 || args.length < (flags.size - 2) * 2) return usage();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const raw = args[index + 1];
    const key = flag === undefined ? undefined : flags.get(flag as never);
    if (key === undefined || raw === undefined || raw.length === 0 || parsed[key] !== undefined) {
      return usage();
    }
    parsed[key] = resolve(raw);
  }
  for (const key of flags.values()) {
    if (key !== "sourceRoot" && key !== "lazyInputs" && parsed[key] === undefined) return usage();
  }
  return parsed as CliOptions;
}

function parseInputArgs(args: readonly string[]): CliInputOptions {
  const flags = new Map([
    ["--builder-report", "builderReport"],
    ["--context", "context"],
    ["--candidate-locator", "candidateLocator"],
    ["--definitions", "definitions"],
    ["--products", "products"],
    ["--resolved-inputs", "resolvedInputs"],
    ["--runtime-bundle", "runtimeBundle"],
    ["--runtime-root", "runtimeRoot"],
    ["--lazy-inputs", "lazyInputs"],
    ["--source-root", "sourceRoot"],
    ["--vfs", "vfs"],
  ] as const);
  const parsed: Partial<CliInputOptions> = {};
  if (args.length % 2 !== 0 || args.length < (flags.size - 2) * 2) {
    throw new Error("candidate evidence child received invalid protected inputs");
  }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const raw = args[index + 1];
    const key = flag === undefined ? undefined : flags.get(flag as never);
    if (key === undefined || raw === undefined || raw.length === 0 || parsed[key] !== undefined) {
      throw new Error("candidate evidence child received invalid protected inputs");
    }
    parsed[key] = resolve(raw);
  }
  for (const key of flags.values()) {
    if (key !== "sourceRoot" && key !== "lazyInputs" && parsed[key] === undefined) {
      throw new Error("candidate evidence child lacks a protected input");
    }
  }
  return parsed as CliInputOptions;
}

function readRegular(
  path: string,
  label: string,
  maximum: number,
  expected?: number,
): Uint8Array {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (metadata.size > maximum) throw new Error(`${label} exceeds its byte bound`);
  if (expected !== undefined && metadata.size !== expected) {
    throw new Error(`${label} differs from its exact byte count`);
  }
  return new Uint8Array(readFileSync(path));
}

function loadCanonicalContext(path: string): NodeEvidenceContextV1 {
  const bytes = readRegular(path, "Node evidence context", MAX_DOCUMENT_BYTES);
  const value = JSON.parse(decoder.decode(bytes)) as unknown;
  const context = validateContextShape(value);
  if (!bytesEqual(bytes, canonicalJsonBytes(context))) {
    throw new Error("Node evidence context is not canonical JSON");
  }
  return context;
}

function loadCanonicalJson(path: string, label: string, maximum: number): unknown {
  const bytes = readRegular(path, label, maximum);
  const value = JSON.parse(decoder.decode(bytes)) as unknown;
  if (!bytesEqual(bytes, canonicalJsonBytes(value))) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

export function loadProtectedNodeLazyInputs(
  manifestPath: string,
  requirements: readonly CandidateLazyRequirementV1[],
  expectedIds: readonly string[],
): ClosedLazyAsset[] {
  const manifest = exactRecord(
    loadCanonicalJson(manifestPath, "protected Node lazy input manifest", MAX_DOCUMENT_BYTES),
    ["inputs", "kind", "schema"],
    "protected Node lazy input manifest",
  );
  if (manifest.schema !== 1 || manifest.kind !== "kandelo-protected-node-lazy-inputs") {
    throw new Error("protected Node lazy input manifest has unsupported identity");
  }
  if (!Array.isArray(manifest.inputs) || manifest.inputs.length > 128) {
    throw new Error("protected Node lazy input manifest exceeds its item bound");
  }
  const records = manifest.inputs.map((value, index) => exactRecord(
    value,
    ["bytes", "id", "path", "reference", "sha256"],
    `protected Node lazy input ${index}`,
  ));
  const ids = records.map((item, index) =>
    stableId(item.id, `protected Node lazy input ${index} ID`));
  if (!jsonEqual(ids, expectedIds)) {
    throw new Error("protected Node lazy input IDs differ from protected evidence policy");
  }
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  let aggregate = 0;
  const assets = records.map((item, index): ClosedLazyAsset => {
    const id = ids[index]!;
    const requirement = byId.get(id);
    const bytes = positiveInteger(item.bytes, `protected Node lazy input ${id} bytes`);
    const sha256 = digest(item.sha256, `protected Node lazy input ${id} digest`);
    const reference = text(
      item.reference,
      `protected Node lazy input ${id} reference`,
      8_192,
    );
    const path = text(item.path, `protected Node lazy input ${id} path`, 16_384);
    if (resolve(path) !== path) {
      throw new Error(`protected Node lazy input ${id} path is not absolute and normalized`);
    }
    if (
      requirement === undefined || reference !== requirement.url ||
      sha256 !== requirement.sha256 || bytes !== requirement.size
    ) {
      throw new Error(`protected Node lazy input ${id} differs from its resolved identity`);
    }
    if (bytes > 512 * 1024 * 1024) {
      throw new Error(`protected Node lazy input ${id} exceeds its byte bound`);
    }
    aggregate += bytes;
    if (aggregate > 1024 * 1024 * 1024) {
      throw new Error("protected Node lazy inputs exceed their aggregate byte bound");
    }
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`protected Node lazy input ${id} must be a private regular file`);
    }
    const body = readRegular(path, `protected Node lazy input ${id}`, bytes, bytes);
    if (sha256Hex(body) !== sha256) {
      throw new Error(`protected Node lazy input ${id} differs from its digest`);
    }
    return { bytes: body, sha256, size: bytes, url: reference };
  });
  validateProtectedNodeLazyAssets(requirements, assets, expectedIds);
  return assets;
}

async function prepareCliEvidence(
  options: CliInputOptions,
): Promise<PreparedCliEvidence> {
  const context = loadCanonicalContext(options.context);
  const runtimeBundleBytes = readRegular(
    options.runtimeBundle,
    "exact runtime bundle",
    MAX_RUNTIME_BUNDLE_BYTES,
  );
  const artifacts = validateExactRuntimeArtifactRoot(
    runtimeBundleBytes,
    options.runtimeRoot,
  );
  const candidateLocator = loadCanonicalJson(
    options.candidateLocator,
    "candidate product locator",
    MAX_DOCUMENT_BYTES,
  ) as CandidateProductLocatorV1;
  const protectedProducts = loadCanonicalJson(
    options.products,
    "protected VFS product catalog",
    MAX_DOCUMENT_BYTES,
  ) as ProtectedVfsProductCatalogV1;
  const resolvedInputsBytes = readRegular(
    options.resolvedInputs,
    "resolved product inputs",
    MAX_DOCUMENT_BYTES,
  );
  const builderReportBytes = readRegular(
    options.builderReport,
    "candidate builder report",
    MAX_DOCUMENT_BYTES,
  );
  const lazyRequirements = validateCandidateProductInputDocuments(
    context,
    candidateLocator,
    protectedProducts,
    exactRuntimeDevShellLockSha256(runtimeBundleBytes),
    resolvedInputsBytes,
    builderReportBytes,
  );
  const vfsBytes = readRegular(
    options.vfs,
    "candidate VFS",
    Math.min(MAX_VFS_BYTES, context.candidate_product.vfs_layer_bytes),
    context.candidate_product.vfs_layer_bytes,
  );
  await validateCandidateVfsLazyInventory(
    vfsBytes,
    lazyRequirements,
    context.runtime.target_abi,
  );
  let compilerSource: ExactSdkCompilerSourceV1 | undefined;
  if (context.definition.runner === "compile") {
    if (options.sourceRoot === undefined) {
      throw new Error("SDK compile evidence lacks the exact source checkout");
    }
    compilerSource = validateExactSdkCompilerSourceRoot(
      options.sourceRoot,
      context.runtime.source,
      exactRuntimeDevShellLockSha256(runtimeBundleBytes),
    );
  } else if (options.sourceRoot !== undefined) {
    throw new Error("non-compile evidence received an unexpected source checkout");
  }
  const inputs: NodeEvidenceExecutionInputs = {
    context,
    candidateLocator,
    protectedDefinitions: loadCanonicalJson(
      options.definitions,
      "protected evidence definition registry",
      MAX_DOCUMENT_BYTES,
    ) as GeneratedEvidenceDefinitionRegistryV1,
    protectedProducts,
    runtimeBundleBytes,
    resolvedInputsBytes,
    builderReportBytes,
    lazyAssetSources: candidateLazyAssetSources(
      lazyRequirements,
      expectedLazyInputIds(context.definition),
    ),
    ...(options.lazyInputs === undefined
      ? {}
      : {
        lazyAssets: loadProtectedNodeLazyInputs(
          options.lazyInputs,
          lazyRequirements,
          expectedLazyInputIds(context.definition),
        ),
      }),
    vfsBytes,
    kernelWasmBytes: readRegular(
      artifacts.kernelPath,
      "runtime kernel",
      512 * 1024 * 1024,
      context.runtime.kernel.bytes,
    ),
  };
  validateNodeEvidenceContext(inputs);
  return { context, artifacts, inputs, compilerSource };
}

function inputCliArgs(options: CliInputOptions): string[] {
  return [
    "--builder-report", options.builderReport,
    "--context", options.context,
    "--candidate-locator", options.candidateLocator,
    "--definitions", options.definitions,
    "--products", options.products,
    "--resolved-inputs", options.resolvedInputs,
    "--runtime-bundle", options.runtimeBundle,
    "--runtime-root", options.runtimeRoot,
    ...(options.lazyInputs === undefined
      ? []
      : ["--lazy-inputs", options.lazyInputs]),
    ...(options.sourceRoot === undefined
      ? []
      : ["--source-root", options.sourceRoot]),
    "--vfs", options.vfs,
  ];
}

function candidateChildExecArgv(): string[] {
  const result: string[] = [];
  const protectedRequire = createRequire(import.meta.url);
  const resolveHook = (flag: string, specifier: string): string =>
    flag === "--require"
      ? protectedRequire.resolve(specifier)
      : import.meta.resolve(specifier);
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index]!;
    if (["--import", "--loader", "--require"].includes(argument)) {
      const value = process.execArgv[index + 1];
      if (value !== undefined) {
        result.push(argument, resolveHook(argument, value));
        index++;
      }
    } else {
      const match = /^(--(?:import|loader|require))=(.+)$/u.exec(argument);
      if (match !== null) {
        result.push(`${match[1]}=${resolveHook(match[1]!, match[2]!)}`);
      }
    }
  }
  return result;
}

function isolatedCandidateEnvironment(workRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_AMBIENT_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  // The child repeats exact-source validation before importing candidate host
  // code. This is a repository-declared tool locator, not a credential, and
  // the child already receives the same closed dev-shell PATH.
  const protectedToolPath = process.env.KANDELO_DEV_SHELL_TOOL_PATH;
  if (protectedToolPath !== undefined) {
    environment.KANDELO_DEV_SHELL_TOOL_PATH = protectedToolPath;
  }
  environment.HOME = join(workRoot, "home");
  environment.TMPDIR = join(workRoot, "tmp");
  environment.CI = "true";
  environment.KANDELO_ABI_EVIDENCE_CHILD = "1";
  return environment;
}

class BoundedChildStream {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  overflow = false;

  constructor(private readonly maximumBytes = MAX_CHILD_STREAM_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("child stream byte bound must be a positive safe integer");
    }
  }

  append(chunk: Buffer): void {
    const remaining = this.maximumBytes - this.bytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      this.chunks.push(Buffer.from(retained));
      this.bytes += retained.byteLength;
    }
    if (chunk.byteLength > remaining) this.overflow = true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

type CandidateRpcMethod =
  | "exec"
  | "http"
  | "compile"
  | "sql"
  | "serviceProtocol"
  | "repositorySuite"
  | "lazyDownloads"
  | "cancel"
  | "dispose";

interface CandidateRpcRequest {
  type: "request";
  request_id: number;
  method: CandidateRpcMethod;
  operation?: NodeEvidenceOperation;
}

interface CandidateRpcSuccess {
  type: "response";
  request_id: number;
  ok: true;
  value: unknown;
}

interface CandidateRpcFailure {
  type: "response";
  request_id: number;
  ok: false;
  error: string;
}

type CandidateRpcResponse = CandidateRpcSuccess | CandidateRpcFailure;

class CandidateChildFailure extends Error {}
class SupervisorDeadlineError extends Error {}

export function classifySupervisorLifecycleError(
  error: unknown,
  deadlineAt: number,
  now = Date.now(),
): Error {
  if (now >= deadlineAt) {
    return new SupervisorDeadlineError(
      "protected evidence deadline exceeded before candidate lifecycle completion",
    );
  }
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function observationText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  if (encoder.encode(value).byteLength > MAX_DIAGNOSTIC_BYTES) {
    throw new Error(`${label} exceeds its protected byte bound`);
  }
  return value;
}

function processObservation(value: unknown, label: string): ProcessObservation {
  const record = exactRecord(value, ["status", "stderr", "stdout"], label);
  return {
    status: integer(record.status, `${label} status`),
    stdout: observationText(record.stdout, `${label} stdout`),
    stderr: observationText(record.stderr, `${label} stderr`),
  };
}

function validateRpcValue(method: CandidateRpcMethod, value: unknown): unknown {
  switch (method) {
    case "exec":
    case "compile":
    case "repositorySuite":
      return processObservation(value, `${method} observation`);
    case "http": {
      const record = exactRecord(
        value,
        ["body", "status", "stderr", "stdout"],
        "HTTP observation",
      );
      return {
        status: integer(record.status, "HTTP observation status"),
        body: observationText(record.body, "HTTP observation body"),
        stdout: observationText(record.stdout, "HTTP observation stdout"),
        stderr: observationText(record.stderr, "HTTP observation stderr"),
      } satisfies HttpObservation;
    }
    case "sql": {
      const record = exactRecord(
        value,
        ["results", "stderr", "stdout"],
        "SQL observation",
      );
      const values = array(record.results, "SQL observation results");
      if (values.length > 1_024) throw new Error("SQL observation has too many results");
      return {
        results: values.map((entry, index) =>
          observationText(entry, `SQL observation result ${index}`)
        ),
        stdout: observationText(record.stdout, "SQL observation stdout"),
        stderr: observationText(record.stderr, "SQL observation stderr"),
      } satisfies SqlObservation;
    }
    case "serviceProtocol": {
      const record = exactRecord(
        value,
        ["response", "stderr", "stdout"],
        "service protocol observation",
      );
      return {
        response: observationText(record.response, "service protocol response"),
        stdout: observationText(record.stdout, "service protocol stdout"),
        stderr: observationText(record.stderr, "service protocol stderr"),
      } satisfies ProtocolObservation;
    }
    case "lazyDownloads": {
      const events = array(value, "lazy materialization observations");
      if (events.length > 2_048) {
        throw new Error("lazy materialization observations exceed their item bound");
      }
      return events.map((event, index) => {
        const record = exactRecordWithOptional(
          event,
          ["loaded_bytes", "phase", "status", "url"],
          ["total_bytes"],
          `lazy materialization observation ${index}`,
        );
        if (record.phase !== "initialization" && record.phase !== "operation") {
          throw new Error("lazy materialization observation phase is invalid");
        }
        if (
          record.status !== "started" && record.status !== "progress" &&
          record.status !== "complete" && record.status !== "error"
        ) throw new Error("lazy materialization observation status is invalid");
        return {
          phase: record.phase,
          status: record.status,
          url: observationText(record.url, `lazy observation ${index} URL`),
          loaded_bytes: nonnegativeInteger(
            record.loaded_bytes,
            `lazy observation ${index} loaded bytes`,
          ),
          ...(record.total_bytes === undefined
            ? {}
            : {
              total_bytes: positiveInteger(
                record.total_bytes,
                `lazy observation ${index} total bytes`,
              ),
            }),
        } satisfies EvidenceLazyDownloadEventV1;
      });
    }
    case "cancel":
    case "dispose":
      if (value !== null) throw new Error(`${method} response must be null`);
      return null;
  }
}

function rpcMethod(value: unknown): CandidateRpcMethod {
  if (
    value === "exec" || value === "http" || value === "compile" || value === "sql" ||
    value === "serviceProtocol" || value === "repositorySuite" || value === "cancel" ||
    value === "dispose" || value === "lazyDownloads"
  ) return value;
  throw new Error("candidate RPC method is unregistered");
}

class CandidateRpcAdapter implements NodeEvidenceAdapter {
  readonly ready: Promise<void>;
  readonly stdout = new BoundedChildStream();
  readonly stderr = new BoundedChildStream();

  private readonly child: ChildProcess;
  private readonly compilerProcesses = new Set<ChildProcess>();
  private readonly pending = new Map<number, {
    method: CandidateRpcMethod;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly closed: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveClosed!: () => void;
  private nextRequestId = 1;
  private readySettled = false;
  private terminating = false;
  private failure: Error | undefined;

  constructor(
    options: CliInputOptions,
    private readonly workRoot: string,
    private readonly protectedVfsBytes: Uint8Array,
    private readonly compilerSource?: ExactSdkCompilerSourceV1,
  ) {
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    this.closed = new Promise<void>((resolveClosed) => {
      this.resolveClosed = resolveClosed;
    });
    this.child = spawn(
      process.execPath,
      [
        ...candidateChildExecArgv(),
        fileURLToPath(import.meta.url),
        INTERNAL_CHILD_FLAG,
        ...inputCliArgs(options),
      ],
      {
        cwd: workRoot,
        detached: process.platform !== "win32",
        env: isolatedCandidateEnvironment(workRoot),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.stdout.append(chunk);
      if (this.stdout.overflow) {
        this.fail(new CandidateChildFailure(
          "candidate evidence child exceeded its protected stdout bound",
        ));
      }
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr.append(chunk);
      if (this.stderr.overflow) {
        this.fail(new CandidateChildFailure(
          "candidate evidence child exceeded its protected stderr bound",
        ));
      }
    });
    this.child.on("message", (message) => this.onMessage(message));
    this.child.once("error", (error) => {
      this.fail(new CandidateChildFailure(
        `candidate evidence child failed to launch: ${error.message}`,
      ));
    });
    this.child.once("close", (code, signal) => {
      this.resolveClosed();
      if (!this.terminating) {
        this.fail(new CandidateChildFailure(
          `candidate evidence child exited with code ${String(code)}` +
            (signal === null ? "" : ` and signal ${signal}`),
          ));
      }
    });
  }

  private onMessage(message: unknown): void {
    try {
      if (!isRecord(message)) throw new Error("candidate RPC message is not an object");
      if (message.type === "ready") {
        exactRecord(message, ["type"], "candidate RPC ready message");
        if (this.readySettled) throw new Error("candidate RPC sent duplicate readiness");
        this.readySettled = true;
        this.resolveReady();
        return;
      }
      if (message.type === "startup-error") {
        const record = exactRecord(
          message,
          ["error", "type"],
          "candidate RPC startup error",
        );
        throw new CandidateChildFailure(
          observationText(record.error, "candidate RPC startup error"),
        );
      }
      const record = exactRecord(
        message,
        message.ok === true
          ? ["ok", "request_id", "type", "value"]
          : ["error", "ok", "request_id", "type"],
        "candidate RPC response",
      );
      if (record.type !== "response" || typeof record.ok !== "boolean") {
        throw new Error("candidate RPC response fields are invalid");
      }
      const requestId = positiveInteger(record.request_id, "candidate RPC request ID");
      const pending = this.pending.get(requestId);
      if (pending === undefined) throw new Error("candidate RPC response ID is unknown");
      this.pending.delete(requestId);
      if (record.ok) {
        pending.resolve(validateRpcValue(pending.method, record.value));
      } else {
        pending.reject(new CandidateChildFailure(
          observationText(record.error, "candidate RPC failure"),
        ));
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.terminating) killChildProcessTree(this.child);
  }

  private call(method: CandidateRpcMethod, operation?: NodeEvidenceOperation): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (!this.readySettled || !this.child.connected) {
      return Promise.reject(new CandidateChildFailure("candidate RPC is not ready"));
    }
    const requestId = this.nextRequestId++;
    const request: CandidateRpcRequest = {
      type: "request",
      request_id: requestId,
      method,
      ...(operation === undefined ? {} : { operation }),
    };
    return new Promise((resolveValue, rejectValue) => {
      this.pending.set(requestId, {
        method,
        resolve: resolveValue,
        reject: rejectValue,
      });
      this.child.send(request, (error) => {
        if (error === null) return;
        this.pending.delete(requestId);
        rejectValue(new CandidateChildFailure(
          `candidate RPC request failed: ${error.message}`,
        ));
      });
    });
  }

  exec(operation: Extract<NodeEvidenceOperation, { kind: "exec" }>) {
    return this.call("exec", operation) as Promise<ProcessObservation>;
  }

  http(operation: Extract<NodeEvidenceOperation, { kind: "http" }>) {
    return this.call("http", operation) as Promise<HttpObservation>;
  }

  async compile(operation: Extract<NodeEvidenceOperation, { kind: "compile" }>) {
    if (this.compilerSource === undefined) {
      throw new Error("SDK compile evidence lacks its exact compiler source");
    }
    const compilation = await compileSdkFixtureFromCandidateVfs(
      this.protectedVfsBytes,
      this.workRoot,
      this.compilerSource,
      (child, active) => {
        if (active) this.compilerProcesses.add(child);
        else this.compilerProcesses.delete(child);
      },
    );
    if (compilation.status !== 0) {
      return {
        status: compilation.status,
        stdout: compilation.stdout,
        stderr: compilation.stderr,
      };
    }
    return this.call("compile", {
      ...operation,
      compiled_program_base64: Buffer.from(compilation.programBytes).toString("base64"),
    }) as Promise<ProcessObservation>;
  }

  sql(operation: Extract<NodeEvidenceOperation, { kind: "sql" }>) {
    return this.call("sql", operation) as Promise<SqlObservation>;
  }

  serviceProtocol(
    operation: Extract<NodeEvidenceOperation, { kind: "service-protocol" }>,
  ) {
    return this.call("serviceProtocol", operation) as Promise<ProtocolObservation>;
  }

  repositorySuite(
    operation: Extract<NodeEvidenceOperation, { kind: "repository-suite" }>,
  ) {
    return this.call("repositorySuite", operation) as Promise<ProcessObservation>;
  }

  lazyDownloads() {
    return this.call("lazyDownloads") as Promise<readonly EvidenceLazyDownloadEventV1[]>;
  }

  async cancel(): Promise<void> {
    await this.call("cancel");
  }

  async dispose(): Promise<void> {
    await this.call("dispose");
  }

  async terminate(): Promise<void> {
    this.terminating = true;
    const terminated = new CandidateChildFailure("candidate evidence child was terminated");
    for (const pending of this.pending.values()) pending.reject(terminated);
    this.pending.clear();
    for (const compiler of this.compilerProcesses) killChildProcessTree(compiler);
    this.compilerProcesses.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      killChildProcessTree(this.child);
    }
    await Promise.race([
      this.closed,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  }
}

function supervisorTerminalResult(
  context: NodeEvidenceContextV1,
  outcome: "failure" | "timeout",
  message: string,
  stdout: string,
  stderr: string,
): ProductEvidenceResultV1 {
  return terminalProductEvidenceResult(context, "node", outcome, {
    runner: message,
    stderr,
    stdout,
  });
}

export async function superviseNodeEvidenceCli(
  options: CliOptions,
): Promise<ProductEvidenceResultV1> {
  const startedAt = Date.now();
  // A canonical context is the minimum identity required to construct a
  // terminal ProductEvidenceResultV1. Everything candidate-controlled after
  // this bounded read belongs to the protected lifecycle and becomes a
  // canonical failure/timeout rather than an uncaught CLI error.
  const context = loadCanonicalContext(options.context);
  const deadlineAt = startedAt + context.definition.timeout_seconds * 1_000;
  let prepared: PreparedCliEvidence | undefined;
  let workRoot: string | undefined;
  let adapter: CandidateRpcAdapter | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: ProductEvidenceResultV1 | undefined;
  const deadlineError = () => new SupervisorDeadlineError(
    "protected evidence deadline exceeded before candidate lifecycle completion",
  );
  const streams = () => ({
    stdout: adapter?.stdout.text() ?? "",
    stderr: adapter?.stderr.text() ?? "",
  });
  const terminal = (error: unknown) => {
    const output = streams();
    return supervisorTerminalResult(
      context,
      error instanceof SupervisorDeadlineError ? "timeout" : "failure",
      errorMessage(error),
      output.stdout,
      output.stderr,
    );
  };
  try {
    assertUncredentialedEnvironment(process.env);
    prepared = await prepareCliEvidence(options);
    let remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw deadlineError();
    workRoot = mkdtempSync(join(tmpdir(), "kandelo-node-evidence-supervisor-"));
    mkdirSync(join(workRoot, "home"), { mode: 0o700 });
    mkdirSync(join(workRoot, "tmp"), { mode: 0o700 });
    adapter = new CandidateRpcAdapter(
      options,
      workRoot,
      new Uint8Array(prepared.inputs.vfsBytes),
      prepared.compilerSource,
    );
    const evidence = (async () => {
      await adapter!.ready;
      return runNodeProductEvidence(prepared!.inputs, adapter!);
    })();
    void evidence.catch(() => {});
    remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw deadlineError();
    result = await Promise.race([
      evidence,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(deadlineError()), remaining);
      }),
    ]);
  } catch (error) {
    result = terminal(classifySupervisorLifecycleError(error, deadlineAt));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (adapter !== undefined) {
      await adapter.terminate();
    }
  }
  if (prepared !== undefined) {
    try {
      if (Date.now() >= deadlineAt) throw deadlineError();
      await prepareCliEvidence(options);
      if (Date.now() >= deadlineAt) throw deadlineError();
    } catch (error) {
      const classified = classifySupervisorLifecycleError(error, deadlineAt);
      result = terminal(
        classified instanceof SupervisorDeadlineError
          ? classified
          : new Error(
            `candidate execution mutated its protected inputs: ${errorMessage(classified)}`,
          ),
      );
    }
  }
  try {
    if (result === undefined) {
      throw new Error("protected evidence lifecycle produced no terminal result");
    }
    return result;
  } finally {
    if (workRoot !== undefined) {
      try {
        rmSync(workRoot, { recursive: true, force: true });
      } catch {
        // The runner has already produced a terminal result; runner-temp
        // cleanup is best effort and must not replace that result.
      }
    }
  }
}

async function candidateChildMain(args: readonly string[]): Promise<void> {
  if (process.env.KANDELO_ABI_EVIDENCE_CHILD !== "1") {
    throw new Error("candidate evidence child lacks its protected supervisor marker");
  }
  assertUncredentialedEnvironment(process.env);
  const protectedSend = process.send?.bind(process);
  const protectedOn = process.on.bind(process);
  if (protectedSend === undefined) {
    throw new Error("candidate evidence child lacks protected IPC");
  }
  Object.defineProperty(process, "send", {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  try {
    const options = parseInputArgs(args);
    const { artifacts, inputs } = await prepareCliEvidence(options);
    const Host = await loadExactNodeKernelHostConstructor(artifacts);
    const adapter = await KernelNodeEvidenceAdapter.create(inputs, Host);
    let operationActive = false;
    protectedOn("message", (message: unknown) => {
      void (async () => {
        let requestId = 0;
        try {
          const request = exactRecord(
            message,
            isRecord(message) && message.operation === undefined
              ? ["method", "request_id", "type"]
              : ["method", "operation", "request_id", "type"],
            "candidate RPC request",
          );
          if (request.type !== "request") throw new Error("candidate RPC request type is invalid");
          requestId = positiveInteger(request.request_id, "candidate RPC request ID");
          const method = rpcMethod(request.method);
          const isOperation = method !== "cancel" && method !== "dispose" &&
            method !== "lazyDownloads";
          if (isOperation && operationActive) {
            throw new Error("candidate RPC permits only one evidence operation at a time");
          }
          if (isOperation) operationActive = true;
          let value: unknown;
          try {
            switch (method) {
              case "exec":
                value = await adapter.exec(request.operation as Extract<NodeEvidenceOperation, { kind: "exec" }>);
                break;
              case "http":
                value = await adapter.http(request.operation as Extract<NodeEvidenceOperation, { kind: "http" }>);
                break;
              case "compile":
                value = await adapter.compile(request.operation as Extract<NodeEvidenceOperation, { kind: "compile" }>);
                break;
              case "sql":
                value = await adapter.sql(request.operation as Extract<NodeEvidenceOperation, { kind: "sql" }>);
                break;
              case "serviceProtocol":
                value = await adapter.serviceProtocol(request.operation as Extract<NodeEvidenceOperation, { kind: "service-protocol" }>);
                break;
              case "repositorySuite":
                value = await adapter.repositorySuite(request.operation as Extract<NodeEvidenceOperation, { kind: "repository-suite" }>);
                break;
              case "lazyDownloads":
                value = await adapter.lazyDownloads();
                break;
              case "cancel":
                await adapter.cancel();
                value = null;
                break;
              case "dispose":
                await adapter.dispose();
                value = null;
                break;
            }
            value = validateRpcValue(method, value);
          } finally {
            if (isOperation) operationActive = false;
          }
          const response: CandidateRpcResponse = {
            type: "response",
            request_id: requestId,
            ok: true,
            value,
          };
          if (canonicalJsonBytes(response).byteLength > MAX_DOCUMENT_BYTES) {
            throw new Error("candidate RPC response exceeds its protected byte bound");
          }
          protectedSend(response);
        } catch (error) {
          const response: CandidateRpcFailure = {
            type: "response",
            request_id: requestId,
            ok: false,
            error: truncateUtf8(errorMessage(error), MAX_DIAGNOSTIC_BYTES),
          };
          protectedSend(response);
        }
      })();
    });
    protectedSend({ type: "ready" });
  } catch (error) {
    protectedSend({
      type: "startup-error",
      error: truncateUtf8(errorMessage(error), MAX_DIAGNOSTIC_BYTES),
    });
    throw error;
  }
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseArgs(args);
  const result = await superviseNodeEvidenceCli(options);
  writeFileSync(options.output, canonicalJsonBytes(result), { flag: "wx", mode: 0o600 });
}

function usage(): never {
  throw new Error(
    "usage: abi-staging-product-node-evidence.ts " +
      "--context <context.json> --candidate-locator <locator.json> " +
      "--definitions <evidence-definitions.json> " +
      "--products <catalog.json> --runtime-bundle <runtime-bundle.json> " +
      "--runtime-root <runtime-dir> [--source-root <exact-checkout>] " +
      "--vfs <product.vfs> --output <result.json>",
  );
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!jsonEqual(actual, expected)) {
    throw new Error(`${label} fields differ: expected ${expected.join(", ")}`);
  }
  return value;
}

function exactRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  for (const key of required) if (!(key in value)) throw new Error(`${label} lacks ${key}`);
  const allowed = new Set([...required, ...optional]);
  if (actual.some((key) => !allowed.has(key))) throw new Error(`${label} has unknown fields`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string, maximum = 64 * 1024): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    encoder.encode(value).byteLength > maximum || value.includes("\0")
  ) throw new Error(`${label} must contain 1 through ${maximum} UTF-8 bytes`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 0) throw new Error(`${label} must be nonnegative`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

function unsigned32(value: unknown, label: string): number {
  const result = nonnegativeInteger(value, label);
  if (result > 0xffff_ffff) throw new Error(`${label} exceeds its unsigned 32-bit bound`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${label} is not a SHA-256 digest`);
  return result;
}

function gitSha(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${label} is not a Git SHA`);
  return result;
}

function stableId(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function repository(value: unknown, label: string): string {
  const result = text(value, label, 255);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(result)) {
    throw new Error(`${label} is not owner/name`);
  }
  return result;
}

function relativePath(value: unknown, label: string): string {
  const result = text(value, label, 4_096);
  if (
    result.startsWith("/") || result.includes("\\") ||
    result.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error(`${label} is not a normalized relative path`);
  return result;
}

function absolutePath(value: unknown, label: string): string {
  const result = text(value, label, 4_096);
  if (
    !result.startsWith("/") || result.includes("\\") ||
    result.split("/").slice(1).some((part) => part === "." || part === "..") ||
    (result !== "/" && result.endsWith("/")) || result.includes("//")
  ) throw new Error(`${label} is not a normalized absolute POSIX path`);
  return result;
}

function httpPath(value: unknown, label: string): string {
  const result = absolutePath(value, label);
  if (result.includes("#")) throw new Error(`${label} must not contain a fragment`);
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  const result = array(value, label).map((item, index) =>
    boundedString(item, `${label} ${index}`, 4_096));
  if (
    result.length === 0 || result.length > 64 || result[0]!.length === 0
  ) throw new Error(`${label} is out of bounds`);
  return result;
}

function environmentRecord(
  value: unknown,
  label: string,
  uppercaseOnly: boolean,
  maximumValueBytes = 64 * 1024,
): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, string> = {};
  for (const [name, candidate] of Object.entries(value)) {
    const pattern = uppercaseOnly ? /^[A-Z_][A-Z0-9_]*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!pattern.test(name)) throw new Error(`${label} name ${name} is invalid`);
    result[name] = boundedString(candidate, `${label} ${name}`, maximumValueBytes);
  }
  return result;
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const result = environmentRecord(value, label, false);
  if (Object.keys(result).length > 64) {
    throw new Error(`${label} exceeds 64 entries`);
  }
  return result;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || encoder.encode(value).byteLength > maximum ||
    value.includes("\0")
  ) throw new Error(`${label} must contain at most ${maximum} non-NUL UTF-8 bytes`);
  return value;
}

function isRunner(value: unknown): value is GeneratedEvidenceDefinitionV1["runner"] {
  return [
    "compile", "exec", "http", "interactive-terminal", "repository-suite",
    "service-protocol", "sql",
  ].includes(String(value));
}

function isNodeRepositorySuite(
  value: unknown,
): value is Extract<NodeEvidenceOperation, { kind: "repository-suite" }>["suite"] {
  return value === "mariadb-product-node" || value === "php-product-node" ||
    value === "sqlite-product-node";
}

function isOutcome(value: unknown): value is ProductEvidenceResultV1["outcome"] {
  return value === "success" || value === "failure" || value === "timeout";
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return bytesEqual(canonicalJsonBytes(left), canonicalJsonBytes(right));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const invocation = args[0] === INTERNAL_CHILD_FLAG
    ? candidateChildMain(args.slice(1))
    : main(args);
  void invocation.catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
