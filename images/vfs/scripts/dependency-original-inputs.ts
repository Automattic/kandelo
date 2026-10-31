import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readStableArtifactIdentity } from "../../../host/src/native-artifact-identity";
import type { ResolvedProgramOriginalWasmArtifact } from "../../../host/src/binary-resolver";

interface DependencyOriginalInput {
  packageName: string;
  resolverPath: string;
  executablePath: string;
  executableSize: number;
  executableSha256: string;
  original: ResolvedProgramOriginalWasmArtifact;
}

function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new Error("Invalid dependency original input fields");
}

function relativePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value) ||
    value.split("/").some(part => part === "" || part === "." || part === "..") || value.normalize("NFC") !== value) {
    throw new Error("Invalid dependency original input relative path");
  }
}

function absolutePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Invalid dependency original input absolute path");
  }
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid dependency original input digest");
}

function byteLength(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 512 * 1024 * 1024) throw new Error("Invalid dependency original input byte length");
}

export function loadDependencyOriginalInputs(path: string, consumerPackage?: string): readonly DependencyOriginalInput[] {
  absolutePath(path);
  if (realpathSync(path) !== path) throw new Error("Dependency original inputs cross a symlink");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > 4 * 1024 * 1024) throw new Error("Dependency original inputs must be a regular file within 4 MiB");
    const namedBefore = lstatSync(path);
    if (namedBefore.isSymbolicLink() || namedBefore.dev !== before.dev || namedBefore.ino !== before.ino) throw new Error("Dependency original inputs changed before read");
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("Dependency original inputs ended during read");
      offset += count;
    }
    const after = fstatSync(descriptor);
    const namedAfter = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size ||
      namedAfter.isSymbolicLink() || namedAfter.dev !== after.dev || namedAfter.ino !== after.ino || realpathSync(path) !== path) {
      throw new Error("Dependency original inputs changed during read");
    }
  } finally { closeSync(descriptor); }
  const metadata: unknown = JSON.parse(bytes.toString("utf8"));
  fields(metadata, ["schema", "kind", "consumerPackage", "inputs"]);
  if (metadata.schema !== 1 || metadata.kind !== "kandelo-dependency-original-inputs" ||
    typeof metadata.consumerPackage !== "string" || consumerPackage !== undefined && metadata.consumerPackage !== consumerPackage ||
    !Array.isArray(metadata.inputs) || metadata.inputs.length > 4096) throw new Error("Unsupported dependency original inputs");
  const identities = new Set<string>();
  for (const input of metadata.inputs) {
    fields(input, ["packageName", "resolverPath", "executablePath", "executableSize", "executableSha256", "original"]);
    if (typeof input.packageName !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(input.packageName)) throw new Error("Invalid original input package");
    relativePath(input.resolverPath); absolutePath(input.executablePath); byteLength(input.executableSize); digest(input.executableSha256);
    const original = input.original;
    fields(original, ["packageName", "path", "relPath", "sourceArtifact", "cacheKey", "mode", "size", "sha256"]);
    absolutePath(original.path); relativePath(original.relPath); relativePath(original.sourceArtifact);
    digest(original.cacheKey); digest(original.sha256); byteLength(original.size);
    const components = input.resolverPath.split("/");
    if (components[0] !== "programs" || !["wasm32", "wasm64"].includes(components[1]!) || original.packageName !== input.packageName ||
      !Number.isInteger(original.mode) || Number(original.mode) < 0 || Number(original.mode) > 0o7777 || (Number(original.mode) & ~0o444) !== 0 ||
      original.relPath !== `programs/${components[1]}/.originals/${input.packageName}/${original.cacheKey}/${original.sourceArtifact}`) {
      throw new Error("Dependency original input ownership differs");
    }
    const identity = `${input.packageName}\0${input.resolverPath}`;
    if (identities.has(identity)) throw new Error("Duplicate dependency original input");
    identities.add(identity);
  }
  return metadata.inputs as unknown as DependencyOriginalInput[];
}

export function resolveDependencyOriginalInput(
  inputs: readonly DependencyOriginalInput[], resolverPath: string, dependency: string,
  executablePath: string, program: Uint8Array,
): ResolvedProgramOriginalWasmArtifact | null {
  const input = inputs.find(candidate => candidate.packageName === dependency &&
    (candidate.resolverPath === resolverPath || candidate.resolverPath.replace(/^programs\/wasm(?:32|64)\//, "programs/") === resolverPath));
  if (!input) return null;
  const expected = input.executableSha256;
  if (program.length !== input.executableSize || createHash("sha256").update(program).digest("hex") !== expected) {
    throw new Error("Prepared program differs from dependency original input");
  }
  const executable = readStableArtifactIdentity(executablePath);
  if (executable.size !== input.executableSize || executable.sha256 !== expected) throw new Error("Executable differs from dependency original input");
  const original = readStableArtifactIdentity(input.original.path);
  if (original.mode !== input.original.mode || original.size !== input.original.size || original.sha256 !== input.original.sha256) {
    throw new Error("Original differs from dependency original input");
  }
  return { ...input.original };
}
