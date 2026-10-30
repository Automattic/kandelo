import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ERRNO } from "../../../host/src/generated/abi";
import { normalizeImageOwnedLazyReference } from "../../../host/src/vfs/vfs-asset-group-reference";
import {
  resolveProgramOriginalWasmArtifact,
  type ResolvedProgramOriginalWasmArtifact,
} from "../../../host/src/binary-resolver";
import { KandeloImageError, type KandeloImageFs, type KandeloImageStat } from "../lib/kandelo-image-fs";
import { loadDependencyOriginalInputs, resolveDependencyOriginalInput } from "./dependency-original-inputs";

export type ProgramOriginalResolver = (
  resolverPath: string,
  dependency: string,
  executablePath: string,
) => ResolvedProgramOriginalWasmArtifact | null;

export interface ProgramOriginalImageOptions {
  resolveOriginal?: ProgramOriginalResolver;
  existingProgramDependencies?: ReadonlySet<string>;
}

export function resolveProgramOriginalForImage(resolverPath: string, dependency: string, executablePath: string, program: Uint8Array): ResolvedProgramOriginalWasmArtifact | null {
  const inputs = process.env.WASM_POSIX_DEP_ORIGINAL_INPUTS;
  if (inputs !== undefined) return resolveDependencyOriginalInput(
    loadDependencyOriginalInputs(inputs, process.env.WASM_POSIX_DEP_NAME), resolverPath, dependency, executablePath, program);
  const key = `WASM_POSIX_DEP_${dependency.replaceAll("-", "_").toUpperCase()}_DIR`;
  return resolveProgramOriginalWasmArtifact(resolverPath, dependency, executablePath, process.env[key]);
}

export function imageFileStat(fs: KandeloImageFs, path: string): KandeloImageStat | null {
  try {
    return fs.stat(path);
  } catch (error) {
    if (error instanceof KandeloImageError && error.errno === ERRNO.ENOENT) return null;
    throw error;
  }
}

function imageFileDigest(fs: KandeloImageFs, path: string, stat: KandeloImageStat): string {
  if (!stat.deferred) return createHash("sha256").update(fs.readFile(path)).digest("hex");
  const entry = fs.lazyEntries().files.find((entry) => entry.ino === BigInt(stat.ino));
  if (!entry || entry.archiveId !== 0) throw new Error(`Cannot bind an original to an image file without its own digest: ${path}`);
  return Buffer.from(entry.digest).toString("hex");
}

export function registerProgramOriginal(
  fs: KandeloImageFs,
  options: {
    resolverPath: string;
    dependency: string;
    executablePath: string;
    program: Uint8Array;
    vfsPath: string;
    resolveOriginal?: ProgramOriginalResolver;
  },
): void {
  const hasReference = fs.hasOriginalProgramReference(options.program);
  const original = options.resolveOriginal
    ? options.resolveOriginal(options.resolverPath, options.dependency, options.executablePath)
    : resolveProgramOriginalForImage(options.resolverPath, options.dependency, options.executablePath, options.program);
  if (original === null) {
    if (hasReference) throw new Error(`Program references an original absent from its selected package: ${options.resolverPath}`);
    return;
  }
  if (original.packageName !== options.dependency || (original.mode & 0o7333) !== 0) {
    throw new Error(`Original companion has invalid package ownership or mode: ${options.resolverPath}`);
  }
  fs.checkOriginalProgramReference(options.program, original);
  if (original.relPath.includes("%")) throw new Error("Original companion resolver path is invalid for image delivery");
  const uri = `kandelo-lazy:${original.relPath}`;
  normalizeImageOwnedLazyReference(uri);
  const existingProgram = imageFileStat(fs, options.vfsPath);
  if (existingProgram !== null) {
    const digest = createHash("sha256").update(options.program).digest("hex");
    if (existingProgram.size !== options.program.byteLength || imageFileDigest(fs, options.vfsPath, existingProgram) !== digest) {
      throw new Error(`Existing image program differs from the selected original-bearing artifact: ${options.vfsPath}`);
    }
  }
  const path = `/usr/lib/kandelo/originals/${original.sha256}.wasm`;
  const previous = imageFileStat(fs, path);
  if (previous !== null) {
    const leaf = fs.lstat(path);
    if ((leaf.mode & 0o170000) !== 0o100000 || leaf.uid !== 0 || leaf.gid !== 0 || (leaf.mode & 0o7777) !== original.mode ||
      previous.size !== original.size || imageFileDigest(fs, path, previous) !== original.sha256) {
      throw new Error(`Existing original companion conflicts with selected package content: ${path}`);
    }
    return;
  }
  fs.registerLazyFile(path, uri, original.size, original.mode, original.sha256);
}

export function registerResolvedProgramOriginal(
  fs: KandeloImageFs,
  resolverPath: string,
  dependency: string,
  executablePath: string,
  vfsPath: string,
  resolveOriginal?: ProgramOriginalResolver,
): Uint8Array {
  const program = readFileSync(executablePath);
  registerProgramOriginal(fs, { resolverPath, dependency, executablePath, program, vfsPath, resolveOriginal });
  return program;
}
