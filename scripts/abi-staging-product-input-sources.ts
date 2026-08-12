import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";
import type {
  ProductInputContent,
  ProductInputObjectSource,
} from "./abi-staging-collect-product-inputs";

const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_PACKAGES = 512;

export interface ProductInputSourceOptions {
  catalogPath: string;
  productId: string;
  packageRoots: Readonly<Record<string, string>>;
  programIndexPath: string;
  archiveFiles: Readonly<Record<string, string>>;
  runtimeRoot: string;
}

interface ProgramIndexMember {
  kind: "output" | "runtime-file";
  outputName?: string;
  sourceArtifact: string;
}

/**
 * Project manifest-selected logical inputs onto normal resolver/runtime
 * outputs. Exceptional legacy outputs and package-owned source roles have one
 * fixed convention below the resolved package root; this function cannot add
 * a package, selector, archive, or toolchain component of its own.
 */
export function deriveProductInputObjectSources(
  options: ProductInputSourceOptions,
): ProductInputObjectSource[] {
  stableId(options.productId, "product ID");
  const catalog = loadVfsProductCatalog(options.catalogPath);
  const manifest = catalog.productById(options.productId) as any;
  const packageNames = [...new Set<string>(
    manifest.software.package.map((claim: any) => claim.name as string) as string[],
  )].sort(compareText);
  exactKeys(options.packageRoots, packageNames, "resolved package roots");
  if (packageNames.length > MAX_PACKAGES) {
    throw new Error("selected product has too many package roots");
  }
  const packageRoots = new Map(
    packageNames.map((name) => [
      name,
      realDirectory(options.packageRoots[name]!, `${name} package root`),
    ]),
  );
  const programIndex = loadProgramIndex(options.programIndexPath);
  const archiveIds = manifest.software.archive
    .map((archive: any) => archive.id as string)
    .sort(compareText);
  exactKeys(options.archiveFiles, archiveIds, "source archive files");
  const runtimeRoot = realDirectory(options.runtimeRoot, "exact runtime root");
  const result: ProductInputObjectSource[] = [];

  for (const claim of manifest.software.package) {
    const packageName = claim.name as string;
    const root = packageRoots.get(packageName)!;
    for (const selector of claim.outputs as string[]) {
      const content = resolvePackageOutput(
        programIndex,
        root,
        packageName,
        selector,
        manifest.architecture,
      );
      result.push({
        kind: "package-output",
        package: packageName,
        selectorKind: "output",
        selector,
        content,
      });
    }
    for (const selector of claim.source_roles as string[]) {
      const path = join(root, ".kandelo-vfs-source-roles", selector);
      result.push({
        kind: "package-output",
        package: packageName,
        selectorKind: "source-role",
        selector,
        content: exactContent(
          root,
          path,
          "directory",
          `${packageName} source role ${selector}`,
        ),
      });
    }
  }
  for (const archive of manifest.software.archive) {
    result.push({
      kind: "source-archive",
      id: archive.id,
      content: exactContent(
        realDirectoryParent(options.archiveFiles[archive.id], `${archive.id} archive parent`),
        options.archiveFiles[archive.id],
        "file",
        `${archive.id} source archive`,
      ),
    });
  }
  for (const toolchain of manifest.software.toolchain) {
    const path = join(runtimeRoot, "toolchain", toolchain.component);
    result.push({
      kind: "toolchain-output",
      id: toolchain.id,
      content: exactContent(
        runtimeRoot,
        path,
        "directory",
        `${toolchain.id} toolchain component`,
      ),
    });
  }
  return result;
}

function resolvePackageOutput(
  index: Map<string, { arches: string[]; members: ProgramIndexMember[] }>,
  root: string,
  packageName: string,
  selector: string,
  architecture: "wasm32" | "wasm64",
): ProductInputContent {
  const projected = index.get(packageName);
  if (projected !== undefined) {
    if (!projected.arches.includes(architecture)) {
      throw new Error(
        `${packageName} package projection lacks architecture ${architecture}`,
      );
    }
    const matches = projected.members.filter(
      (member) => member.kind === "output" && member.outputName === selector,
    );
    if (matches.length > 1) {
      throw new Error(`${packageName} output ${selector} is ambiguous`);
    }
    if (matches.length === 1) {
      const member = matches[0]!;
      const relativePath = normalizedRelativePath(
        member.sourceArtifact,
        `${packageName} output ${selector} artifact`,
      );
      return exactContent(
        root,
        join(root, ...relativePath.split("/")),
        "file",
        `${packageName} output ${selector}`,
      );
    }
  }
  const adapterPath = join(root, ".kandelo-vfs-product-outputs", selector);
  try {
    return detectedContent(root, adapterPath, `${packageName} output ${selector}`);
  } catch (error) {
    if (selector === packageName && projected === undefined) {
      return { kind: "directory", path: root };
    }
    throw error;
  }
}

function loadProgramIndex(
  path: string,
): Map<string, { arches: string[]; members: ProgramIndexMember[] }> {
  const body = readFileSync(exactFile(path, "program package index"));
  let value: any;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new Error("program package index is invalid JSON", { cause: error });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.packages === null ||
    typeof value.packages !== "object" ||
    Array.isArray(value.packages)
  ) {
    throw new Error("program package index has an unsupported shape");
  }
  const result = new Map<string, { arches: string[]; members: ProgramIndexMember[] }>();
  for (const [name, entry] of Object.entries(value.packages) as Array<[string, any]>) {
    stableId(name, "program package name");
    if (!Array.isArray(entry.arches) || !Array.isArray(entry.members)) {
      throw new Error(`program package ${name} has an unsupported projection`);
    }
    const members: ProgramIndexMember[] = entry.members.map(
      (member: any, index: number) => {
        if (
          member === null ||
          typeof member !== "object" ||
          Array.isArray(member) ||
          (member.kind !== "output" && member.kind !== "runtime-file") ||
          typeof member.sourceArtifact !== "string"
        ) {
          throw new Error(`program package ${name} member ${index} is invalid`);
        }
        normalizedRelativePath(
          member.sourceArtifact,
          `program package ${name} member ${index} artifact`,
        );
        if (member.kind === "output") {
          stableId(member.outputName, `program package ${name} output name`);
        }
        return {
          kind: member.kind,
          sourceArtifact: member.sourceArtifact,
          ...(member.outputName === undefined
            ? {}
            : { outputName: member.outputName }),
        };
      },
    );
    result.set(name, { arches: [...entry.arches], members });
  }
  return result;
}

function exactKeys(
  value: Readonly<Record<string, string>>,
  expected: string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  const actual = Object.keys(value).sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} differ from the selected product manifest`);
  }
}

function detectedContent(root: string, path: string, label: string): ProductInputContent {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (metadata.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (metadata.isFile() && metadata.nlink === 1 && metadata.size > 0) {
    return exactContent(root, path, "file", label);
  }
  if (metadata.isDirectory()) return exactContent(root, path, "directory", label);
  throw new Error(`${label} is not one supported package artifact`);
}

function exactContent<K extends "file" | "directory">(
  root: string,
  path: string,
  kind: K,
  label: string,
): Readonly<{ kind: K; path: string }> {
  const absolute = resolve(path);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(absolute);
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (metadata.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  const canonical = realpathSync(absolute);
  assertBelow(root, canonical, label, canonical === root);
  if (kind === "file") {
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1) {
      throw new Error(`${label} is not one nonempty regular file`);
    }
  } else if (!metadata.isDirectory()) {
    throw new Error(`${label} is not a real directory`);
  }
  return { kind, path: canonical };
}

function exactFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error(`${label} must be one regular non-symlink file`);
  }
  return absolute;
}

function realDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(absolute);
}

function realDirectoryParent(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  return realDirectory(resolve(path, ".."), label);
}

function assertBelow(
  root: string,
  target: string,
  label: string,
  allowRoot = false,
): void {
  const fromRoot = relative(root, target);
  if (
    (!allowRoot && fromRoot === "") ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} escapes its declared root`);
  }
}

function normalizedRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value !== value.normalize("NFC") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a normalized relative path`);
  }
  return value;
}

function stableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new Error(`${label} is not a stable identifier`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
