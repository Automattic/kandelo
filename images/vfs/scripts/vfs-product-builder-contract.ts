import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_INPUTS = 4_096;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CANDIDATE_NAMESPACE = /homebrew-tap-core-abi-[0-9]+-candidates\//;
const CANONICAL_NAMESPACE = /homebrew-tap-core-abi-[0-9]+\//;
const INPUT_KINDS = [
  "product-image",
  "homebrew-bottle",
  "package-output",
  "source-archive",
  "toolchain-output",
  "repository-path",
] as const;

type VfsProductInputKind = (typeof INPUT_KINDS)[number];
type InputRole = "runtime" | "build";
type InputPlacement = "embedded" | "lazy-reference" | "build-only";
type ReferenceClass = "candidate" | "canonical" | "local-fixture";

export interface ProductIdentity {
  id: string;
  manifest_path: string;
  manifest_sha256: string;
  architecture: "wasm32" | "wasm64";
  output: string;
}

export interface TargetAbi {
  version: number;
  snapshot_sha256: string;
}

interface ResolvedInput {
  id: string;
  kind: VfsProductInputKind;
  role: InputRole;
  architecture: "wasm32" | "wasm64";
  declared_materialization: "embedded" | "lazy" | "build-only";
  effective_materialization: InputPlacement;
  sha256: string;
  bytes: number;
  reference?: string;
  path?: string;
  resolvedPath?: string;
}

interface ResolvedInputs {
  schema: 1;
  kind: "kandelo-resolved-vfs-product-inputs";
  product: ProductIdentity;
  target_abi: TargetAbi;
  build_environment: {
    policy_sha256: string;
    dev_shell_lock_sha256: string;
  };
  reference_class: ReferenceClass;
  source: { repository: string; commit: string; tree: string };
  inputs: ResolvedInput[];
}

export type VfsProductInputHandle =
  | Readonly<{
      id: string;
      sha256: string;
      bytes: number;
      placement: "embedded" | "build-only";
      path: string;
    }>
  | Readonly<{
      id: string;
      sha256: string;
      bytes: number;
      placement: "lazy-reference";
      reference: string;
    }>;

export interface VfsProductBuild {
  readonly product: Readonly<ProductIdentity>;
  readonly targetAbi: Readonly<TargetAbi>;
  requireProductImage(id: string): VfsProductInputHandle;
  requireHomebrewBottle(id: string): VfsProductInputHandle;
  requirePackageOutput(id: string): VfsProductInputHandle;
  requireSourceArchive(id: string): VfsProductInputHandle;
  requireToolchainOutput(id: string): VfsProductInputHandle;
  requireRepositoryPath(id: string): VfsProductInputHandle;
  finish(outputPath: string): Promise<void>;
}

export async function openVfsProductBuild(
  inputsPath: string,
  reportPath: string,
): Promise<VfsProductBuild> {
  return openVfsProductBuildWithPolicy(inputsPath, reportPath, false);
}

/** Local content references are accepted only by the inert transition proof. */
export async function openMiniatureVfsProductBuild(
  inputsPath: string,
  reportPath: string,
): Promise<VfsProductBuild> {
  return openVfsProductBuildWithPolicy(inputsPath, reportPath, true);
}

async function openVfsProductBuildWithPolicy(
  inputsPath: string,
  reportPath: string,
  allowLocalFixture: boolean,
): Promise<VfsProductBuild> {
  const absoluteInputsPath = resolve(inputsPath);
  const absoluteReportPath = resolve(reportPath);
  assertRegularNonsymlink(absoluteInputsPath, "resolved input document");
  assertAbsent(absoluteReportPath, "builder report");
  assertDirectoryNonsymlink(dirname(absoluteReportPath), "builder report parent");

  const inputBytes = readFileSync(absoluteInputsPath);
  if (inputBytes.byteLength > MAX_DOCUMENT_BYTES) {
    fail(`resolved input document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  const inputText = inputBytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputText);
  } catch (error) {
    fail(`resolved input document is invalid JSON: ${describeError(error)}`);
  }
  if (canonicalJson(parsed) !== inputText) {
    fail("resolved input document is not canonical JSON");
  }
  const inputs = parseResolvedInputs(
    parsed,
    dirname(absoluteInputsPath),
    allowLocalFixture,
  );
  const byId = new Map(inputs.inputs.map((input) => [input.id, input]));
  const consumed = new Map<string, ResolvedInput>();
  let finished = false;

  const requireInput = (
    id: string,
    expectedKind: VfsProductInputKind,
  ): VfsProductInputHandle => {
    if (finished) fail("VFS product build is already finished");
    const input = byId.get(id);
    if (!input) fail(`VFS product input ${JSON.stringify(id)} is not declared`);
    if (input.kind !== expectedKind) {
      fail(
        `VFS product input ${JSON.stringify(id)} is declared as ${input.kind}, not ${expectedKind}`,
      );
    }
    consumed.set(id, input);
    if (input.effective_materialization === "lazy-reference") {
      return Object.freeze({
        id: input.id,
        sha256: input.sha256,
        bytes: input.bytes,
        placement: input.effective_materialization,
        reference: input.reference!,
      });
    }
    return Object.freeze({
      id: input.id,
      sha256: input.sha256,
      bytes: input.bytes,
      placement: input.effective_materialization,
      path: input.resolvedPath!,
    });
  };

  return Object.freeze({
    product: Object.freeze({ ...inputs.product }),
    targetAbi: Object.freeze({ ...inputs.target_abi }),
    requireProductImage: (id: string) => requireInput(id, "product-image"),
    requireHomebrewBottle: (id: string) => requireInput(id, "homebrew-bottle"),
    requirePackageOutput: (id: string) => requireInput(id, "package-output"),
    requireSourceArchive: (id: string) => requireInput(id, "source-archive"),
    requireToolchainOutput: (id: string) => requireInput(id, "toolchain-output"),
    requireRepositoryPath: (id: string) => requireInput(id, "repository-path"),
    finish: async (outputPath: string) => {
      if (finished) fail("VFS product build is already finished");
      const unconsumed = inputs.inputs
        .map((input) => input.id)
        .filter((id) => !consumed.has(id));
      if (unconsumed.length > 0) {
        fail(`VFS product build has unconsumed inputs: ${unconsumed.join(", ")}`);
      }

      const reportRoot = dirname(absoluteReportPath);
      const absoluteOutputPath = resolve(outputPath);
      const relativeOutputPath = relative(reportRoot, absoluteOutputPath);
      assertNormalizedRelativePath(relativeOutputPath, "builder output path");
      assertRegularNonsymlinkBelow(
        reportRoot,
        relativeOutputPath,
        "builder output",
      );
      if (basename(absoluteOutputPath) !== inputs.product.output) {
        fail(
          `builder output name ${JSON.stringify(basename(absoluteOutputPath))} does not match product output ${JSON.stringify(inputs.product.output)}`,
        );
      }
      const outputBytes = readFileSync(absoluteOutputPath);
      const metadata = MemoryFileSystem.readImageMetadata(
        new Uint8Array(
          outputBytes.buffer,
          outputBytes.byteOffset,
          outputBytes.byteLength,
        ),
      );
      if (metadata?.kernelAbi !== inputs.target_abi.version) {
        fail(
          `builder output kernel ABI ${String(metadata?.kernelAbi)} does not match target ABI ${inputs.target_abi.version}`,
        );
      }
      // VFS metadata is deliberately extensible. Staging outputs add the
      // structural snapshot binding without changing legacy image readers,
      // which already preserve unknown metadata fields.
      if (metadata.abiSnapshotSha256 !== inputs.target_abi.snapshot_sha256) {
        fail(
          "builder output ABI snapshot SHA-256 does not match the resolved target snapshot",
        );
      }

      const report = {
        capture: { complete: true, unreported_reads: [] },
        inputs: inputs.inputs.map((input) => ({
          bytes: input.bytes,
          id: input.id,
          kind: input.kind,
          placement: input.effective_materialization,
          role: input.role,
          sha256: input.sha256,
        })),
        kind: "kandelo-vfs-builder-report",
        output: {
          abi: {
            snapshot_sha256: inputs.target_abi.snapshot_sha256,
            version: inputs.target_abi.version,
          },
          bytes: outputBytes.byteLength,
          name: basename(absoluteOutputPath),
          path: relativeOutputPath.split(sep).join("/"),
          sha256: digest(outputBytes),
        },
        product: inputs.product,
        resolved_inputs_sha256: digest(inputBytes),
        schema: 1,
      };
      publishNewCanonicalReport(absoluteReportPath, canonicalJson(report));
      finished = true;
    },
  });
}

function parseResolvedInputs(
  value: unknown,
  inputRoot: string,
  allowLocalFixture: boolean,
): ResolvedInputs {
  const root = exactRecord(
    value,
    [
      "build_environment",
      "inputs",
      "kind",
      "product",
      "reference_class",
      "schema",
      "source",
      "target_abi",
    ],
    "resolved input document",
  );
  if (root.schema !== 1 || root.kind !== "kandelo-resolved-vfs-product-inputs") {
    fail("resolved input document has unsupported identity");
  }
  const productValue = exactRecord(
    root.product,
    ["architecture", "id", "manifest_path", "manifest_sha256", "output"],
    "resolved input product",
  );
  const architecture = oneOf(
    productValue.architecture,
    ["wasm32", "wasm64"] as const,
    "product architecture",
  );
  const product: ProductIdentity = {
    architecture,
    id: stableId(productValue.id, "product id"),
    manifest_path: normalizedRelativePath(
      productValue.manifest_path,
      "product manifest path",
    ),
    manifest_sha256: sha256(productValue.manifest_sha256, "manifest SHA-256"),
    output: outputName(productValue.output),
  };
  const targetValue = exactRecord(
    root.target_abi,
    ["snapshot_sha256", "version"],
    "target ABI",
  );
  const targetAbi: TargetAbi = {
    version: nonnegativeInteger(targetValue.version, "target ABI version"),
    snapshot_sha256: sha256(
      targetValue.snapshot_sha256,
      "target ABI snapshot SHA-256",
    ),
  };
  const environmentValue = exactRecord(
    root.build_environment,
    ["dev_shell_lock_sha256", "policy_sha256"],
    "build environment",
  );
  const sourceValue = exactRecord(
    root.source,
    ["commit", "repository", "tree"],
    "exact source",
  );
  const repository = string(sourceValue.repository, "source repository");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    fail("source repository must be an exact owner/name identity");
  }
  if (root.reference_class === "local-fixture" && !allowLocalFixture) {
    fail("local-fixture references are accepted only by the miniature builder");
  }
  const referenceClass = oneOf(
    root.reference_class,
    allowLocalFixture
      ? (["candidate", "canonical", "local-fixture"] as const)
      : (["candidate", "canonical"] as const),
    "reference class",
  );
  if (!Array.isArray(root.inputs) || root.inputs.length > MAX_INPUTS) {
    fail(`resolved inputs must be an array with at most ${MAX_INPUTS} entries`);
  }
  const inputs = root.inputs.map((input, index) =>
    parseResolvedInput(
      input,
      index,
      architecture,
      referenceClass,
      inputRoot,
    ),
  );
  for (let index = 1; index < inputs.length; index += 1) {
    if (inputs[index - 1].id >= inputs[index].id) {
      fail("resolved inputs must be sorted by unique stable input id");
    }
  }
  const localPaths = new Set<string>();
  for (const input of inputs) {
    if (input.resolvedPath && localPaths.has(input.resolvedPath)) {
      fail(`resolved input ${JSON.stringify(input.id)} duplicates a local file`);
    }
    if (input.resolvedPath) localPaths.add(input.resolvedPath);
  }
  return {
    schema: 1,
    kind: "kandelo-resolved-vfs-product-inputs",
    product,
    target_abi: targetAbi,
    build_environment: {
      policy_sha256: sha256(
        environmentValue.policy_sha256,
        "build policy SHA-256",
      ),
      dev_shell_lock_sha256: sha256(
        environmentValue.dev_shell_lock_sha256,
        "dev-shell lock SHA-256",
      ),
    },
    reference_class: referenceClass,
    source: {
      repository,
      commit: gitSha(sourceValue.commit, "source commit"),
      tree: gitSha(sourceValue.tree, "source tree"),
    },
    inputs,
  };
}

function parseResolvedInput(
  value: unknown,
  index: number,
  productArchitecture: "wasm32" | "wasm64",
  referenceClass: ReferenceClass,
  inputRoot: string,
): ResolvedInput {
  const label = `resolved input ${index}`;
  const record = recordValue(value, label);
  const permitted = new Set([
    "architecture",
    "bytes",
    "declared_materialization",
    "effective_materialization",
    "id",
    "kind",
    "path",
    "reference",
    "role",
    "sha256",
  ]);
  for (const key of Object.keys(record)) {
    if (!permitted.has(key)) fail(`${label} has unknown field ${JSON.stringify(key)}`);
  }
  for (const key of permitted) {
    if (key !== "path" && key !== "reference" && !(key in record)) {
      fail(`${label} is missing required field ${JSON.stringify(key)}`);
    }
  }
  const id = stableId(record.id, `${label} id`);
  const kind = oneOf(record.kind, INPUT_KINDS, `${label} kind`);
  const role = oneOf(record.role, ["runtime", "build"] as const, `${label} role`);
  const architecture = oneOf(
    record.architecture,
    ["wasm32", "wasm64"] as const,
    `${label} architecture`,
  );
  if (architecture !== productArchitecture) {
    fail(`${label} architecture does not match product architecture`);
  }
  if (kind === "toolchain-output" && role !== "build") {
    fail(`${label} toolchain output must have build role`);
  }
  const declared = oneOf(
    record.declared_materialization,
    ["embedded", "lazy", "build-only"] as const,
    `${label} declared materialization`,
  );
  const effective = oneOf(
    record.effective_materialization,
    ["embedded", "lazy-reference", "build-only"] as const,
    `${label} effective materialization`,
  );
  const validMaterialization =
    (role === "runtime" && declared === "embedded" && effective === "embedded") ||
    (role === "runtime" &&
      declared === "lazy" &&
      (effective === "lazy-reference" || effective === "embedded")) ||
    (role === "build" && declared === "build-only" && effective === "build-only");
  if (!validMaterialization) fail(`${label} has inconsistent role and materialization`);
  const inputSha256 = sha256(record.sha256, `${label} SHA-256`);
  const bytes = nonnegativeInteger(record.bytes, `${label} byte count`);
  const reference =
    record.reference === undefined
      ? undefined
      : immutableReference(
          record.reference,
          inputSha256,
          bytes,
          kind,
          referenceClass,
          label,
        );
  const path =
    record.path === undefined
      ? undefined
      : normalizedRelativePath(record.path, `${label} path`);
  if (effective === "lazy-reference") {
    if (!reference || path !== undefined) {
      fail(`${label} lazy input requires a reference and forbids a local path`);
    }
    return {
      id,
      kind,
      role,
      architecture,
      declared_materialization: declared,
      effective_materialization: effective,
      sha256: inputSha256,
      bytes,
      reference,
    };
  }
  if (!path) fail(`${label} materialized input requires a local path`);
  const resolvedPath = assertRegularNonsymlinkBelow(inputRoot, path, `${label} ${id}`);
  const contents = readFileSync(resolvedPath);
  if (contents.byteLength !== bytes) {
    fail(
      `${label} ${id} byte count does not match: expected ${bytes}, got ${contents.byteLength}`,
    );
  }
  if (digest(contents) !== inputSha256) {
    fail(`${label} ${id} SHA-256 does not match`);
  }
  return {
    id,
    kind,
    role,
    architecture,
    declared_materialization: declared,
    effective_materialization: effective,
    sha256: inputSha256,
    bytes,
    ...(reference === undefined ? {} : { reference }),
    path,
    resolvedPath,
  };
}

function immutableReference(
  value: unknown,
  inputSha256: string,
  inputBytes: number,
  kind: VfsProductInputKind,
  referenceClass: ReferenceClass,
  label: string,
): string {
  const reference = string(value, `${label} reference`);
  if (
    reference.length > 4_096 ||
    /\s/.test(reference) ||
    (!reference.includes(`sha256:${inputSha256}`) &&
      !reference.includes(`sha256=${inputSha256}`))
  ) {
    fail(`${label} reference is not immutable or does not bind its SHA-256`);
  }
  const candidate = CANDIDATE_NAMESPACE.test(reference);
  const canonical = CANONICAL_NAMESPACE.test(reference);
  const local = reference.match(
    /^local-fixture:sha256:([0-9a-f]{64})\?namespace=(candidate|canonical|source)&bytes=([1-9][0-9]*)$/,
  );
  if (referenceClass === "candidate" && canonical) {
    fail(`${label} candidate input references the canonical namespace`);
  }
  if (referenceClass === "canonical" && candidate) {
    fail(`${label} canonical input references the candidate namespace`);
  }
  if (referenceClass === "local-fixture") {
    if (
      !local ||
      local[1] !== inputSha256 ||
      Number(local[3]) !== inputBytes ||
      !Number.isSafeInteger(Number(local[3])) ||
      ((kind === "homebrew-bottle" || kind === "product-image") &&
        local[2] === "source")
    ) {
      fail(`${label} local-fixture reference does not bind exact namespace and bytes`);
    }
    return reference;
  }
  if (
    (kind === "homebrew-bottle" || kind === "product-image") &&
    !candidate &&
    !canonical
  ) {
    fail(`${label} managed input does not use a versioned namespace`);
  }
  return reference;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = recordValue(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      `${label} must contain exactly ${expected.join(", ")}; got ${actual.join(", ")}`,
    );
  }
  return record;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} must be a nonempty string`);
  }
  return value;
}

function stableId(value: unknown, label: string): string {
  const result = string(value, label);
  if (!STABLE_ID.test(result)) fail(`${label} is not a stable identifier`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA256.test(result)) fail(`${label} must be 64 lowercase hexadecimal characters`);
  return result;
}

function gitSha(value: unknown, label: string): string {
  const result = string(value, label);
  if (!GIT_SHA.test(result)) fail(`${label} must be 40 lowercase hexadecimal characters`);
  return result;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  permitted: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !permitted.includes(value)) {
    fail(`${label} must be one of ${permitted.join(", ")}`);
  }
  return value as T[number];
}

function outputName(value: unknown): string {
  const result = string(value, "product output");
  if (
    result.length > 255 ||
    result.startsWith(".") ||
    result.includes("/") ||
    result.includes("\\") ||
    (!result.endsWith(".vfs") && !result.endsWith(".vfs.zst"))
  ) {
    fail(`invalid VFS output filename ${JSON.stringify(result)}`);
  }
  return result;
}

function normalizedRelativePath(value: unknown, label: string): string {
  const result = string(value, label);
  assertNormalizedRelativePath(result, label);
  return result;
}

function assertNormalizedRelativePath(value: string, label: string): void {
  const parts = value.split(/[\\/]/);
  if (
    value.length > 4_096 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} is not a normalized relative path: ${JSON.stringify(value)}`);
  }
}

function assertRegularNonsymlinkBelow(
  root: string,
  relativePath: string,
  label: string,
): string {
  assertDirectoryNonsymlink(root, `${label} root`);
  assertNormalizedRelativePath(relativePath, `${label} path`);
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) {
    fail(`${label} is outside its caller-owned root`);
  }
  let current = resolve(root);
  for (const part of relativePath.split(/[\\/]/)) {
    current = resolve(current, part);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) fail(`${label} contains a symbolic link`);
  }
  assertRegularNonsymlink(absolute, label);
  return absolute;
}

function assertRegularNonsymlink(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular nonsymlink file`);
  }
}

function assertDirectoryNonsymlink(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a nonsymlink directory`);
  }
}

function assertAbsent(path: string, label: string): void {
  if (existsSync(path)) fail(`${label} already exists`);
  try {
    lstatSync(path);
    fail(`${label} already exists`);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
}

function publishNewCanonicalReport(path: string, contents: string): void {
  assertAbsent(path, "builder report");
  const temporary = `${path}.tmp-${process.pid}`;
  assertAbsent(temporary, "builder report temporary file");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, contents, undefined, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function canonicalJson(value: unknown): string {
  assertIntegerJson(value, "canonical JSON");
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function assertIntegerJson(value: unknown, label: string): void {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    fail(`${label} permits safe integer numbers only`);
  }
  if (Array.isArray(value)) {
    value.forEach((child) => assertIntegerJson(child, label));
  } else if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((child) =>
      assertIntegerJson(child, label),
    );
  }
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  throw new Error(message);
}
