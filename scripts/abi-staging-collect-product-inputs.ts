import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, type Zippable } from "fflate";
import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";
import { createRepositoryPathBundle } from "../images/vfs/scripts/repository-path-bundle";
import { deriveProductInputObjectSources } from "./abi-staging-product-input-sources";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_OBJECTS = 4_096;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_DIRECTORY_BYTES = 512 * 1024 * 1024;
const ZIP_EPOCH = new Date("1980-01-02T00:00:00.000Z");

export type ProductInputObjectSource =
  | Readonly<{
      kind: "package-output";
      package: string;
      selectorKind: "output" | "source-role";
      selector: string;
      content: ProductInputContent;
    }>
  | Readonly<{
      kind: "source-archive";
      id: string;
      content: Readonly<{ kind: "file"; path: string }>;
    }>
  | Readonly<{
      kind: "toolchain-output";
      id: string;
      content: Readonly<{ kind: "directory"; path: string }>;
    }>;

export type ProductInputContent = Readonly<{
  kind: "file" | "directory";
  path: string;
}>;

export interface ProductInputCollectorOptions {
  catalogPath: string;
  productId: string;
  sourceRoot: string;
  source: Readonly<{ repository: string; commit: string; tree: string }>;
  targetAbi: Readonly<{ version: number; snapshotSha256: string }>;
  buildEnvironment: Readonly<{
    policySha256: string;
    devShellLockSha256: string;
  }>;
  sources: readonly ProductInputObjectSource[];
  outRoot: string;
}

export interface ResolvedProductInputCollectionOptions
  extends Omit<ProductInputCollectorOptions, "sources"> {
  packageRoots: Readonly<Record<string, string>>;
  programIndexPath: string;
  archiveFiles: Readonly<Record<string, string>>;
  runtimeRoot: string;
}

export interface ExactProductSourceIdentityOptions {
  root: string;
  commit: string;
  tree: string;
  devShellLockSha256: string;
}

export interface CollectedProductInputObject {
  id: string;
  kind:
    | "package-output"
    | "source-archive"
    | "toolchain-output"
    | "repository-path";
  role: "runtime" | "build";
  declared_materialization: "embedded" | "lazy" | "build-only";
  architecture: "wasm32" | "wasm64";
  adapter: string;
  path: string;
  sha256: string;
  bytes: number;
  package?: string;
  selector_kind?: "output" | "source-role";
  selector?: string;
  archive_id?: string;
  url?: string;
  toolchain_id?: string;
  provider?: "repository-dev-shell";
  component?: string;
  repository_id?: string;
  paths?: string[];
}

export interface CollectedProductInputInventory {
  schema: 1;
  kind: "kandelo-vfs-product-input-object-inventory";
  product: {
    id: string;
    manifest_path: string;
    manifest_sha256: string;
    architecture: "wasm32" | "wasm64";
  };
  source: { repository: string; commit: string; tree: string };
  target_abi: { version: number; snapshot_sha256: string };
  build_environment: {
    policy_sha256: string;
    dev_shell_lock_sha256: string;
  };
  objects: CollectedProductInputObject[];
  inventory_sha256: string;
}

interface ExpectedObject {
  id: string;
  kind: CollectedProductInputObject["kind"];
  role: "runtime" | "build";
  declared: "embedded" | "lazy" | "build-only";
  sourceKey?: string;
  package?: string;
  selectorKind?: "output" | "source-role";
  selector?: string;
  archiveId?: string;
  url?: string;
  sha256?: string;
  toolchainId?: string;
  provider?: "repository-dev-shell";
  component?: string;
  repositoryId?: string;
  paths?: string[];
}

export function collectProductInputObjects(
  options: ProductInputCollectorOptions,
): CollectedProductInputInventory {
  validateOptions(options);
  const catalog = loadVfsProductCatalog(options.catalogPath);
  const manifest = catalog.productById(options.productId) as any;
  const expected = expectedObjects(manifest);
  const provided = validatedSources(options.sources);
  const sourceKeys = [...provided.keys()].sort(compareText);
  const expectedSourceKeys = expected
    .flatMap((item) => item.sourceKey === undefined ? [] : [item.sourceKey])
    .sort(compareText);
  if (canonicalJson(sourceKeys) !== canonicalJson(expectedSourceKeys)) {
    throw new Error(
      `${options.productId} input source inventory differs from its product manifest`,
    );
  }

  const outputRoot = prepareOutputRoot(options.outRoot);
  const objectDirectory = join(outputRoot, "inputs/objects");
  mkdirSync(objectDirectory, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(tmpdir(), "kandelo-product-input-object-"));
  const objects: CollectedProductInputObject[] = [];
  try {
    for (const item of expected) {
      let body: Uint8Array;
      let adapter: string;
      if (item.kind === "repository-path") {
        const bundlePath = join(temporary, `${item.id}.json`);
        createRepositoryPathBundle({
          repositoryRoot: realDirectory(options.sourceRoot, "exact source root"),
          paths: item.paths!,
          source: options.source,
          outputPath: bundlePath,
        });
        body = new Uint8Array(readFileSync(bundlePath));
        adapter = "repository-path-bundle-v1";
      } else {
        const source = provided.get(item.sourceKey!);
        if (source === undefined) {
          throw new Error(`${options.productId} is missing input source ${item.sourceKey}`);
        }
        if (item.kind === "source-archive") {
          body = readExactFile(source.content.path, `${item.id} source archive`);
          if (sha256(body) !== item.sha256) {
            throw new Error(`${item.id} source archive differs from its manifest SHA-256`);
          }
          adapter = "source-archive-v1";
        } else if (source.content.kind === "file") {
          body = readExactFile(source.content.path, `${item.id} package output`);
          adapter = "package-output-file-v1";
        } else {
          const archiveRoot = item.kind === "toolchain-output"
            ? item.toolchainId!
            : item.selector!;
          body = archiveExactDirectory(
            source.content.path,
            archiveRoot,
            `${item.id} directory input`,
          );
          adapter = item.kind === "toolchain-output"
            ? "toolchain-directory-zip-v1"
            : item.selectorKind === "source-role"
              ? "package-source-role-zip-v1"
              : "package-output-directory-zip-v1";
        }
      }
      if (body.byteLength === 0) throw new Error(`${item.id} input object is empty`);
      const digest = sha256(body);
      const relativePath = `inputs/objects/${item.id}-sha256-${digest}`;
      writeFileSync(join(outputRoot, relativePath), body, { flag: "wx", mode: 0o600 });
      objects.push({
        id: item.id,
        kind: item.kind,
        role: item.role,
        declared_materialization: item.declared,
        architecture: manifest.architecture,
        adapter,
        path: relativePath,
        sha256: digest,
        bytes: body.byteLength,
        ...(item.package === undefined ? {} : { package: item.package }),
        ...(item.selectorKind === undefined
          ? {}
          : { selector_kind: item.selectorKind }),
        ...(item.selector === undefined ? {} : { selector: item.selector }),
        ...(item.archiveId === undefined ? {} : { archive_id: item.archiveId }),
        ...(item.url === undefined ? {} : { url: item.url }),
        ...(item.toolchainId === undefined
          ? {}
          : { toolchain_id: item.toolchainId }),
        ...(item.provider === undefined ? {} : { provider: item.provider }),
        ...(item.component === undefined ? {} : { component: item.component }),
        ...(item.repositoryId === undefined
          ? {}
          : { repository_id: item.repositoryId }),
        ...(item.paths === undefined ? {} : { paths: [...item.paths] }),
      });
    }
  } catch (error) {
    rmSync(outputRoot, { force: true, recursive: true });
    throw error;
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }

  objects.sort((left, right) => compareText(left.id, right.id));
  const stored = {
    schema: 1 as const,
    kind: "kandelo-vfs-product-input-object-inventory" as const,
    product: {
      id: manifest.id,
      manifest_path: `images/vfs/products/${manifest.id}.toml`,
      manifest_sha256: sha256(canonicalJsonBytes(manifest)),
      architecture: manifest.architecture as "wasm32" | "wasm64",
    },
    source: { ...options.source },
    target_abi: {
      version: options.targetAbi.version,
      snapshot_sha256: options.targetAbi.snapshotSha256,
    },
    build_environment: {
      policy_sha256: options.buildEnvironment.policySha256,
      dev_shell_lock_sha256: options.buildEnvironment.devShellLockSha256,
    },
    objects,
  };
  const storedBytes = canonicalJsonBytes(stored);
  writeFileSync(join(outputRoot, "inputs/artifacts.json"), storedBytes, {
    flag: "wx",
    mode: 0o600,
  });
  return { ...stored, inventory_sha256: sha256(storedBytes) };
}

/**
 * Production adapter from normal package/runtime outputs into the canonical
 * private object inventory. The selected product manifest remains the only
 * authority for which logical package selectors, archives, toolchain
 * components, and repository paths are admitted.
 */
export function collectProductInputObjectsFromResolvedSources(
  options: ResolvedProductInputCollectionOptions,
): CollectedProductInputInventory {
  const sources = deriveProductInputObjectSources({
    archiveFiles: options.archiveFiles,
    catalogPath: options.catalogPath,
    packageRoots: options.packageRoots,
    productId: options.productId,
    programIndexPath: options.programIndexPath,
    runtimeRoot: options.runtimeRoot,
  });
  return collectProductInputObjects({
    buildEnvironment: options.buildEnvironment,
    catalogPath: options.catalogPath,
    outRoot: options.outRoot,
    productId: options.productId,
    source: options.source,
    sourceRoot: options.sourceRoot,
    sources,
    targetAbi: options.targetAbi,
  });
}

/** Re-observe exact source and lock identity before the production adapter runs. */
export function verifyExactProductSourceIdentity(
  options: ExactProductSourceIdentityOptions,
): void {
  const root = realDirectory(options.root, "exact source root");
  if (!GIT_SHA.test(options.commit) || !GIT_SHA.test(options.tree)) {
    throw new Error("exact source commit/tree must be full Git SHAs");
  }
  if (!SHA256.test(options.devShellLockSha256)) {
    throw new Error("exact source dev-shell lock digest is invalid");
  }
  const commit = gitOutput(root, ["rev-parse", "--verify", "HEAD"]);
  const tree = gitOutput(root, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (commit !== options.commit || tree !== options.tree) {
    throw new Error("exact source Git identity differs from the protected request");
  }
  const status = gitOutput(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ], true);
  if (status !== "") {
    throw new Error("exact source is not clean before product input collection");
  }
  const lockPath = join(root, "flake.lock");
  const metadata = lstatSync(lockPath);
  if (
    metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
    metadata.size < 1 || metadata.size > 4 * 1024 * 1024
  ) {
    throw new Error("exact source dev-shell lock is not one bounded regular file");
  }
  if (sha256(new Uint8Array(readFileSync(lockPath))) !== options.devShellLockSha256) {
    throw new Error("exact source dev-shell lock differs from the protected runtime");
  }
}

function gitOutput(root: string, args: readonly string[], permitEmpty = false): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(
      `cannot observe exact source Git identity: ${result.stderr.trim()}`,
    );
  }
  const value = result.stdout.trim();
  if (!permitEmpty && value.length === 0) {
    throw new Error("exact source Git identity is empty");
  }
  return value;
}

function expectedObjects(manifest: any): ExpectedObject[] {
  const expected: ExpectedObject[] = [];
  const add = (item: ExpectedObject) => {
    if (expected.some((existing) => existing.id === item.id)) {
      throw new Error(`${manifest.id} product manifest has colliding input IDs`);
    }
    expected.push(item);
  };
  for (const claim of manifest.software.package) {
    const declared = declaredMaterialization(claim.role, claim.materialization);
    for (const selector of claim.outputs) {
      add({
        id: resolvedInputId("package", claim.name, "output", selector),
        kind: "package-output",
        role: claim.role,
        declared,
        sourceKey: sourceKey("package-output", claim.name, "output", selector),
        package: claim.name,
        selectorKind: "output",
        selector,
      });
    }
    for (const selector of claim.source_roles) {
      add({
        id: resolvedInputId("package", claim.name, "source-role", selector),
        kind: "package-output",
        role: claim.role,
        declared,
        sourceKey: sourceKey("package-output", claim.name, "source-role", selector),
        package: claim.name,
        selectorKind: "source-role",
        selector,
      });
    }
  }
  for (const archive of manifest.software.archive) {
    add({
      id: resolvedInputId("archive", archive.id),
      kind: "source-archive",
      role: archive.role,
      declared: declaredMaterialization(archive.role, archive.materialization),
      sourceKey: sourceKey("source-archive", archive.id),
      archiveId: archive.id,
      url: archive.url,
      sha256: archive.sha256,
    });
  }
  for (const toolchain of manifest.software.toolchain) {
    add({
      id: resolvedInputId("toolchain", toolchain.id),
      kind: "toolchain-output",
      role: toolchain.role,
      declared: declaredMaterialization(toolchain.role, toolchain.materialization),
      sourceKey: sourceKey("toolchain-output", toolchain.id),
      toolchainId: toolchain.id,
      provider: toolchain.provider,
      component: toolchain.component,
    });
  }
  for (const repository of manifest.composition.repository) {
    add({
      id: resolvedInputId("repository", repository.id),
      kind: "repository-path",
      role: repository.role,
      declared: declaredMaterialization(repository.role, repository.materialization),
      repositoryId: repository.id,
      paths: [...repository.paths],
    });
  }
  return expected.sort((left, right) => compareText(left.id, right.id));
}

function validatedSources(
  sources: readonly ProductInputObjectSource[],
): Map<string, ProductInputObjectSource> {
  if (!Array.isArray(sources) || sources.length > MAX_OBJECTS) {
    throw new Error("product input source inventory is outside its bound");
  }
  const result = new Map<string, ProductInputObjectSource>();
  for (const source of sources) {
    let key: string;
    if (source.kind === "package-output") {
      stableId(source.package, "package source package");
      stableId(source.selector, "package source selector");
      if (source.selectorKind !== "output" && source.selectorKind !== "source-role") {
        throw new Error("package source selector kind is invalid");
      }
      key = sourceKey(
        "package-output",
        source.package,
        source.selectorKind,
        source.selector,
      );
    } else {
      stableId(source.id, "input source ID");
      key = sourceKey(source.kind, source.id);
    }
    if (result.has(key)) throw new Error(`product input source repeats ${key}`);
    if (source.kind === "source-archive" && source.content.kind !== "file") {
      throw new Error(`${key} source archive must be one exact file`);
    }
    if (source.kind === "toolchain-output" && source.content.kind !== "directory") {
      throw new Error(`${key} toolchain input must be one exact directory`);
    }
    inspectContent(source.content, key);
    result.set(key, source);
  }
  return result;
}

function inspectContent(content: ProductInputContent, label: string): void {
  if (!isAbsolute(content.path)) throw new Error(`${label} source path must be absolute`);
  const metadata = lstatSync(content.path);
  if (metadata.isSymbolicLink()) throw new Error(`${label} source is a symlink`);
  if (content.kind === "file") {
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1) {
      throw new Error(`${label} source is not one nonempty regular file`);
    }
  } else if (!metadata.isDirectory()) {
    throw new Error(`${label} source is not a real directory`);
  }
}

function archiveExactDirectory(path: string, root: string, label: string): Uint8Array {
  stableId(root, `${label} archive root`);
  const directory = realDirectory(path, label);
  const entries: Array<{
    path: string;
    kind: "directory" | "file";
    mode: number;
    body?: Uint8Array;
  }> = [{ path: `${root}/`, kind: "directory", mode: 0o755 }];
  let totalBytes = 0;
  const visit = (current: string, prefix: string, depth: number) => {
    if (depth > 128) throw new Error(`${label} directory depth exceeds 128`);
    const children = readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => compareText(left.name, right.name),
    );
    for (const child of children) {
      if (child.name.includes("\0") || child.name.includes("/") || child.name === "." || child.name === "..") {
        throw new Error(`${label} has an invalid entry name`);
      }
      const childPath = join(current, child.name);
      const metadata = lstatSync(childPath);
      const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
      if (metadata.isDirectory()) {
        entries.push({
          path: `${root}/${relative}/`,
          kind: "directory",
          mode: metadata.mode & 0o7777,
        });
        visit(childPath, relative, depth + 1);
      } else if (metadata.isFile() && metadata.nlink === 1) {
        const body = new Uint8Array(readFileSync(childPath));
        totalBytes += body.byteLength;
        entries.push({
          path: `${root}/${relative}`,
          kind: "file",
          mode: metadata.mode & 0o7777,
          body,
        });
      } else {
        throw new Error(`${label} contains an unsupported or linked file`);
      }
      if (entries.length > MAX_DIRECTORY_ENTRIES || totalBytes > MAX_DIRECTORY_BYTES) {
        throw new Error(`${label} directory input exceeds its bound`);
      }
    }
  };
  visit(directory, "", 0);
  if (entries.length === 1) throw new Error(`${label} directory input is empty`);
  entries.sort((left, right) => compareText(left.path, right.path));
  const archive: Zippable = {};
  for (const entry of entries) {
    const type = entry.kind === "directory" ? 0o040000 : 0o100000;
    archive[entry.path] = [entry.body ?? new Uint8Array(), {
      attrs: (((type | entry.mode) << 16) >>> 0),
      mtime: ZIP_EPOCH,
      os: 3,
    }];
  }
  return zipSync(archive, { level: 9 });
}

function readExactFile(path: string, label: string): Uint8Array {
  inspectContent({ kind: "file", path }, label);
  return new Uint8Array(readFileSync(path));
}

function prepareOutputRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("product input output root must be absolute");
  const output = resolve(path);
  try {
    lstatSync(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(output, { mode: 0o700 });
    return output;
  }
  throw new Error("product input output root already exists");
}

function validateOptions(options: ProductInputCollectorOptions): void {
  stableId(options.productId, "product ID");
  if (!REPOSITORY.test(options.source.repository)) {
    throw new Error("product source repository must be owner/repository");
  }
  if (!GIT_SHA.test(options.source.commit) || !GIT_SHA.test(options.source.tree)) {
    throw new Error("product source commit/tree must be full Git SHAs");
  }
  if (!Number.isSafeInteger(options.targetAbi.version) || options.targetAbi.version < 0) {
    throw new Error("target ABI is invalid");
  }
  for (const [label, digest] of [
    ["ABI snapshot", options.targetAbi.snapshotSha256],
    ["build policy", options.buildEnvironment.policySha256],
    ["dev-shell lock", options.buildEnvironment.devShellLockSha256],
  ]) {
    if (!SHA256.test(digest)) throw new Error(`${label} digest is invalid`);
  }
  realDirectory(options.sourceRoot, "exact source root");
}

function realDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(path);
}

function declaredMaterialization(
  role: "runtime" | "build",
  materialization: "embedded" | "lazy" | undefined,
): "embedded" | "lazy" | "build-only" {
  if (role === "build") return "build-only";
  if (materialization !== "embedded" && materialization !== "lazy") {
    throw new Error("runtime product input omits its materialization");
  }
  return materialization;
}

function resolvedInputId(prefix: string, ...parts: string[]): string {
  for (const part of parts) stableId(part, "resolved input identity");
  const stem = [prefix, ...parts].join("-");
  if (Buffer.byteLength(stem) <= 128) return stem;
  const suffix = sha256(canonicalJsonBytes({
    kind: prefix === "package" ? "package-output"
      : prefix === "archive" ? "source-archive"
        : prefix === "toolchain" ? "toolchain-output"
          : "repository-path",
    parts,
  })).slice(0, 16);
  return `${stem.slice(0, 111).replace(/[-._]+$/, "")}-${suffix}`;
}

function sourceKey(kind: string, ...parts: string[]): string {
  return [kind, ...parts].join(":");
}

function stableId(value: string, label: string): void {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new Error(`${label} is not a stable identifier`);
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return new TextDecoder().decode(canonicalJsonBytes(value));
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(sortJson(value))}\n`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const COLLECTION_FLAGS = [
  "--archive-files",
  "--catalog",
  "--dev-shell-lock-sha256",
  "--out",
  "--package-roots",
  "--policy-sha256",
  "--product-id",
  "--program-index",
  "--runtime-root",
  "--snapshot-sha256",
  "--source-commit",
  "--source-repository",
  "--source-root",
  "--source-tree",
  "--target-abi",
] as const;

export function runProductInputCollectionCli(args: readonly string[]): void {
  const flags = parseCollectionFlags(args);
  const targetAbi = Number(requiredCollectionFlag(flags, "--target-abi"));
  if (!Number.isSafeInteger(targetAbi) || targetAbi < 0) {
    throw new Error("--target-abi must be a nonnegative safe integer");
  }
  const sourceRoot = requiredCollectionFlag(flags, "--source-root");
  const sourceCommit = requiredCollectionFlag(flags, "--source-commit");
  const sourceTree = requiredCollectionFlag(flags, "--source-tree");
  const devShellLockSha256 = requiredCollectionFlag(
    flags,
    "--dev-shell-lock-sha256",
  );
  verifyExactProductSourceIdentity({
    root: sourceRoot,
    commit: sourceCommit,
    tree: sourceTree,
    devShellLockSha256,
  });
  const inventory = collectProductInputObjectsFromResolvedSources({
    archiveFiles: readPathRecord(
      requiredCollectionFlag(flags, "--archive-files"),
      "archive file map",
    ),
    buildEnvironment: {
      devShellLockSha256,
      policySha256: requiredCollectionFlag(flags, "--policy-sha256"),
    },
    catalogPath: requiredCollectionFlag(flags, "--catalog"),
    outRoot: requiredCollectionFlag(flags, "--out"),
    packageRoots: readPathRecord(
      requiredCollectionFlag(flags, "--package-roots"),
      "package root map",
    ),
    productId: requiredCollectionFlag(flags, "--product-id"),
    programIndexPath: requiredCollectionFlag(flags, "--program-index"),
    runtimeRoot: requiredCollectionFlag(flags, "--runtime-root"),
    source: {
      commit: sourceCommit,
      repository: requiredCollectionFlag(flags, "--source-repository"),
      tree: sourceTree,
    },
    sourceRoot,
    targetAbi: {
      snapshotSha256: requiredCollectionFlag(flags, "--snapshot-sha256"),
      version: targetAbi,
    },
  });
  process.stdout.write(canonicalJson(inventory));
}

function parseCollectionFlags(args: readonly string[]): Map<string, string> {
  if (args.length !== COLLECTION_FLAGS.length * 2) {
    throw new Error(
      "usage: abi-staging-collect-product-inputs.ts " +
        COLLECTION_FLAGS.map((flag) => `${flag} <value>`).join(" "),
    );
  }
  const allowed = new Set<string>(COLLECTION_FLAGS);
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1]!;
    if (!allowed.has(flag) || result.has(flag) || value.length === 0) {
      throw new Error(`product input collection flag is invalid: ${flag}`);
    }
    result.set(flag, value);
  }
  return result;
}

function requiredCollectionFlag(
  flags: ReadonlyMap<string, string>,
  name: typeof COLLECTION_FLAGS[number],
): string {
  const value = flags.get(name);
  if (value === undefined) throw new Error(`missing required flag ${name}`);
  return value;
}

function readPathRecord(path: string, label: string): Record<string, string> {
  const body = readFileSync(path);
  if (body.byteLength === 0 || body.byteLength > 1024 * 1024) {
    throw new Error(`${label} is outside its byte bound`);
  }
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    stableId(key, `${label} key`);
    if (typeof candidate !== "string" || !isAbsolute(candidate)) {
      throw new Error(`${label} ${key} must be an absolute path`);
    }
    result[key] = candidate;
  }
  return result;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runProductInputCollectionCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
