import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { loadVfsProductCatalog } from "../../../scripts/vfs-product-catalog.mjs";
import {
  parseHomebrewOriginalBottleTreeDescriptor,
  registerHomebrewDeferredTreeCollection,
  type HomebrewOriginalBottleTreeDescriptorV1,
} from "../../../host/src/homebrew-runtime-layer-consumer";
import {
  MemoryFileSystem,
  type DeferredTreeMaterializationHandle,
} from "../../../host/src/vfs/memory-fs";
import {
  parsePackageDeferredZipTreeDescriptor,
  registerPackageDeferredZipTree,
} from "../../../host/src/vfs/package-deferred-tree";
import { ENOENT, SFSError } from "../../../host/src/vfs/sharedfs-vendor";
import {
  KANDELO_DEMO_CONFIG_PATH,
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import {
  KANDELO_SHELL_CONFIG_PATH,
  parseKandeloShellConfig,
} from "../../../web-libs/kandelo-session/src/shell-config";
import {
  installHomebrewBootstrapConsumerState,
  prepareHomebrewBootstrapConsumerNamespace,
  readHomebrewBootstrapEnvironment,
} from "./build-homebrew-vfs-image";
import {
  ensureDirRecursive,
  saveImage,
  sourceDateEpochMilliseconds,
  writeVfsBinary,
} from "./vfs-image-helpers";
import { openVfsProductBuild } from "./vfs-product-builder-contract";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 100_000;
const STAGING_FLAGS = new Map([
  ["--vfs-product-manifest", "manifestPath"],
  ["--vfs-product-inputs", "resolvedInputsPath"],
  ["--vfs-product-report", "builderReportPath"],
  ["--vfs-product-output", "outputPath"],
] as const);

export interface StagedProductInvocation {
  manifestPath: string;
  resolvedInputsPath: string;
  builderReportPath: string;
  outputPath: string;
}

export interface ExactSourceIdentity {
  repository: string;
  commit: string;
  tree: string;
}

export type RepositoryPathBundleEntry =
  | Readonly<{
      path: string;
      kind: "directory";
      mode: number;
    }>
  | Readonly<{
      path: string;
      kind: "file";
      mode: number;
      sha256: string;
      bytes: number;
      content_base64: string;
    }>
  | Readonly<{
      path: string;
      kind: "symlink";
      mode: number;
      target: string;
    }>;

export interface RepositoryPathBundle {
  readonly schema: 1;
  readonly kind: "kandelo-vfs-repository-path-bundle";
  readonly source: Readonly<ExactSourceIdentity>;
  readonly paths: readonly string[];
  readonly entries: readonly RepositoryPathBundleEntry[];
}

export async function buildStagedPlatformRootfs(
  invocation: StagedProductInvocation,
): Promise<void> {
  assertStagedProductEnvironment(process.env);
  const build = await openVfsProductBuild(
    invocation.resolvedInputsPath,
    invocation.builderReportPath,
  );
  const manifest = validateSelectedProductManifest(invocation.manifestPath, build);
  if (
    manifest.id !== "platform-rootfs" ||
    manifest.builder !== "packages/registry/rootfs/build-rootfs-package.sh"
  ) {
    throw new Error("platform rootfs staging selected a different product or builder");
  }
  const repositoryIds = build.inputIds("repository-path");
  if (
    repositoryIds.length !== 1 ||
    repositoryIds[0] !== "repository-rootfs-source"
  ) {
    throw new Error(
      "platform-rootfs requires exactly repository-rootfs-source",
    );
  }
  for (const kind of [
    "product-image",
    "homebrew-bottle",
    "source-archive",
    "toolchain-output",
  ] as const) {
    if (build.inputIds(kind).length !== 0) {
      throw new Error(`platform-rootfs does not declare ${kind} inputs`);
    }
  }

  const repository = build.requireRepositoryPath("repository-rootfs-source");
  if (repository.placement !== "embedded") {
    throw new Error("platform-rootfs source must be materialized as an exact bundle");
  }
  const bundle = readRepositoryPathBundle(repository.path, build.source);
  if (
    bundle.paths.length !== 2 ||
    bundle.paths[0] !== "MANIFEST" ||
    bundle.paths[1] !== "images/rootfs"
  ) {
    throw new Error("platform-rootfs source bundle differs from its canonical paths");
  }

  const temporaryRoot = realDirectory(
    process.env.TMPDIR ?? "",
    "staged product temporary root",
  );
  const work = mkdtempSync(join(temporaryRoot, "kandelo-platform-rootfs-"));
  try {
    const sourceRoot = join(work, "source");
    materializeRepositoryPathBundle(bundle, sourceRoot);
    const outputs = build.inputIds("package-output").map((id) => {
      const input = build.requirePackageOutput(id);
      return input.placement === "lazy-reference"
        ? {
            bytes: input.bytes,
            id,
            materialization: input.placement,
            reference: input.reference,
            sha256: input.sha256,
          }
        : {
            bytes: input.bytes,
            id,
            materialization: "embedded" as const,
            path: input.path,
            sha256: input.sha256,
          };
    });
    const outputMapPath = join(work, "resolved-package-outputs.json");
    writeFileSync(
      outputMapPath,
      canonicalJson({
        kind: "kandelo-rootfs-resolved-package-outputs",
        outputs,
        schema: 1,
      }),
      { flag: "wx", mode: 0o600 },
    );

    const packageManifestPath = join(work, "rootfs-packages.MANIFEST");
    const result = spawnSync(
      "bash",
      [join(REPOSITORY_ROOT, "scripts/build-rootfs.sh")],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          ROOTFS_ABI_SNAPSHOT_SHA256: build.targetAbi.snapshot_sha256,
          ROOTFS_ABI_VERSION: String(build.targetAbi.version),
          ROOTFS_MANIFEST: join(sourceRoot, "MANIFEST"),
          ROOTFS_OUT: invocation.outputPath,
          ROOTFS_PACKAGE_MANIFEST: packageManifestPath,
          ROOTFS_PACKAGES_CONFIG: join(sourceRoot, "images/rootfs/PACKAGES.toml"),
          ROOTFS_REPO_ROOT: sourceRoot,
          ROOTFS_RESOLVED_OUTPUT_MAP: outputMapPath,
          ROOTFS_SEALED_BUILD: "1",
          ROOTFS_SKIP_PACKAGE_RESOLVE: "1",
          ROOTFS_SOURCE_TREE: join(sourceRoot, "images/rootfs"),
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `platform-rootfs build failed with status ${String(result.status)}:\n` +
          boundedDiagnostics(result.stdout, result.stderr),
      );
    }
    await build.finish(invocation.outputPath);
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}

const HOMEBREW_PREFIX = "/opt/kandelo/homebrew";
const HOMEBREW_COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";

interface MainShellCompatibilityPolicy {
  mirror_link_manifest_bin: { targets: string[] };
  link_conflict_owners: Array<{
    target: string;
    package: string;
    reason: string;
  }>;
  aliases: Array<{
    package: string;
    source_kind: "link" | "keg";
    source: string;
    targets: string[];
  }>;
  runtime_state: Array<{
    requires_package: string;
    path: string;
    kind: "directory" | "empty_file" | "text_file";
    mode: number;
    uid: number;
    gid: number;
    reason: string;
    contents?: string;
  }>;
}

interface StagedBottleTree {
  inputId: string;
  formula: string;
  placement: "embedded" | "lazy-reference";
  bytes?: Uint8Array;
  descriptor: HomebrewOriginalBottleTreeDescriptorV1;
  handle?: DeferredTreeMaterializationHandle;
}

export async function buildStagedBrowserMainShell(
  invocation: StagedProductInvocation,
): Promise<void> {
  assertStagedProductEnvironment(process.env);
  const build = await openVfsProductBuild(
    invocation.resolvedInputsPath,
    invocation.builderReportPath,
  );
  const manifest = validateSelectedProductManifest(invocation.manifestPath, build);
  if (
    manifest.id !== "browser-main-shell" ||
    manifest.builder !== "scripts/build-homebrew-main-shell-product.sh"
  ) {
    throw new Error("main-shell staging selected a different product or builder");
  }
  const directRoots = new Set(
    manifest.software.homebrew.flatMap((group) => group.formulae),
  );
  const candidateNamespace =
    `homebrew-tap-core-abi-${build.targetAbi.version}-candidates/`;
  if (directRoots.size === 0 || !directRoots.has("bash")) {
    throw new Error("browser-main-shell must declare its Homebrew roots including bash");
  }
  for (const kind of ["source-archive", "toolchain-output"] as const) {
    if (build.inputIds(kind).length !== 0) {
      throw new Error(`browser-main-shell does not declare ${kind} inputs`);
    }
  }
  if (
    build.inputIds("product-image").length !== 1 ||
    build.inputIds("product-image")[0] !== "product-platform-rootfs"
  ) {
    throw new Error("browser-main-shell requires exactly product-platform-rootfs");
  }
  if (
    build.inputIds("repository-path").length !== 1 ||
    build.inputIds("repository-path")[0] !== "repository-main-shell-config"
  ) {
    throw new Error("browser-main-shell requires exactly repository-main-shell-config");
  }

  const expectedPackageIds = new Set([
    "package-homebrew-bootstrap-output-homebrew-bootstrap",
    "package-homebrew-bootstrap-output-homebrew-brew",
  ]);
  if (
    build.inputIds("package-output").length !== expectedPackageIds.size ||
    build.inputIds("package-output").some((id) => !expectedPackageIds.has(id))
  ) {
    throw new Error("browser-main-shell package inputs differ from Homebrew bootstrap outputs");
  }

  const base = build.requireProductImage("product-platform-rootfs");
  if (base.placement !== "embedded") {
    throw new Error("browser-main-shell base product must be embedded");
  }
  const baseBytes = new Uint8Array(readFileSync(base.path));
  const fs = MemoryFileSystem.fromImagePreservingCapacity(baseBytes);
  await fs.verifyImportedLazyAtomicGroupSeals();
  const baseMetadata = fs.getImageMetadata();
  if (
    baseMetadata?.kernelAbi !== build.targetAbi.version ||
    baseMetadata.abiSnapshotSha256 !== build.targetAbi.snapshot_sha256
  ) {
    throw new Error("browser-main-shell base product ABI differs from its target");
  }

  const repository = build.requireRepositoryPath("repository-main-shell-config");
  if (repository.placement !== "embedded") {
    throw new Error("browser-main-shell configuration must be embedded");
  }
  const bundle = readRepositoryPathBundle(repository.path, build.source);
  const expectedRepositoryPaths = [
    "homebrew/main-shell-brew-package-tree.json",
    "homebrew/main-shell-compatibility.json",
    "homebrew/main-shell-default.json",
    "homebrew/main-shell-demo.json",
  ];
  if (canonicalJson(bundle.paths) !== canonicalJson(expectedRepositoryPaths)) {
    throw new Error("browser-main-shell configuration bundle differs from canonical paths");
  }

  const temporaryRoot = realDirectory(
    process.env.TMPDIR ?? "",
    "staged product temporary root",
  );
  const work = mkdtempSync(join(temporaryRoot, "kandelo-browser-main-shell-"));
  try {
    const sourceRoot = join(work, "source");
    materializeRepositoryPathBundle(bundle, sourceRoot);
    const configPath = (name: string) => join(sourceRoot, "homebrew", name);
    const compatibility = parseMainShellCompatibilityPolicy(
      readCanonicalJson(configPath("main-shell-compatibility.json"), "main-shell compatibility"),
    );

    const bottleTrees: StagedBottleTree[] = [];
    for (const inputId of build.inputIds("homebrew-bottle")) {
      if (!inputId.startsWith("homebrew-") || inputId.length === "homebrew-".length) {
        throw new Error(`browser-main-shell Homebrew input ID is invalid: ${inputId}`);
      }
      const formula = inputId.slice("homebrew-".length);
      const input = build.requireHomebrewBottle(inputId);
      if (input.placement !== "embedded" && input.placement !== "lazy-reference") {
        throw new Error(`browser-main-shell ${inputId} has build-only placement`);
      }
      if (input.descriptor === undefined) {
        throw new Error(`browser-main-shell ${inputId} has no composition descriptor`);
      }
      if (!input.descriptor.reference.includes(candidateNamespace)) {
        throw new Error(
          `browser-main-shell ${inputId} descriptor is not in the exact target ABI candidate namespace`,
        );
      }
      const descriptor = parseHomebrewOriginalBottleTreeDescriptor(
        readCanonicalJson(input.descriptor.path, `${inputId} composition descriptor`),
        {
          architecture: build.product.architecture,
          tap: "kandelo-dev/homebrew-tap-core",
          formula,
          package: `kandelo-dev/tap-core/${formula}`,
          bottle: { sha256: input.sha256, bytes: input.bytes },
          allowedRoots: directRoots,
        },
      );
      const transport = descriptor.tree.transports[0]?.url;
      if (
        transport === undefined ||
        !transport.includes(candidateNamespace)
      ) {
        throw new Error(
          `browser-main-shell ${inputId} lazy transport leaves its candidate namespace`,
        );
      }
      bottleTrees.push({
        inputId,
        formula,
        placement: input.placement,
        ...(input.placement === "embedded"
          ? { bytes: new Uint8Array(readFileSync(input.path)) }
          : {}),
        descriptor,
      });
    }
    for (const root of directRoots) {
      if (!bottleTrees.some((item) => item.formula === root)) {
        throw new Error(`browser-main-shell omits declared Homebrew root ${root}`);
      }
    }
    if (
      bottleTrees.filter((item) => item.formula === "bash").length !== 1 ||
      bottleTrees.find((item) => item.formula === "bash")?.placement !== "embedded"
    ) {
      throw new Error("browser-main-shell requires one embedded Bash bottle");
    }

    ensureHomebrewPrefixAncestors(fs);
    const registered = registerHomebrewDeferredTreeCollection({
      fs,
      id: "browser-main-shell",
      schema: 5,
      trees: bottleTrees.map((item) => item.descriptor.tree),
    });
    const handleByPackage = new Map(
      registered.map((item) => [item.package, item.materialization]),
    );
    for (const item of bottleTrees) {
      item.handle = handleByPackage.get(item.descriptor.tree.package!);
      if (item.handle === undefined) {
        throw new Error(`browser-main-shell did not register ${item.formula}`);
      }
      if (item.placement === "embedded") {
        const changed = await fs.materializeRegisteredDeferredTree(
          item.handle,
          item.bytes!,
        );
        if (!changed) {
          throw new Error(`browser-main-shell ${item.formula} was already materialized`);
        }
      }
    }

    const compatibilityEvidence = applyMainShellCompatibility(
      fs,
      compatibility,
      bottleTrees,
    );

    const bootstrapArchive = build.requirePackageOutput(
      "package-homebrew-bootstrap-output-homebrew-bootstrap",
    );
    if (
      bootstrapArchive.placement !== "lazy-reference" ||
      bootstrapArchive.descriptor === undefined
    ) {
      throw new Error("Homebrew bootstrap source tree must be descriptor-backed lazy input");
    }
    const bootstrapTree = parsePackageDeferredZipTreeDescriptor(
      readCanonicalJson(
        bootstrapArchive.descriptor.path,
        "Homebrew bootstrap tree descriptor",
      ),
      {
        id: "homebrew-bootstrap/source-tree",
        package: {
          name: "homebrew-bootstrap",
          output: "homebrew-bootstrap.zip",
        },
        archive: {
          sha256: bootstrapArchive.sha256,
          bytes: bootstrapArchive.bytes,
          reference: bootstrapArchive.reference,
        },
      },
    );
    prepareHomebrewBootstrapConsumerNamespace(fs, bootstrapTree);
    registerPackageDeferredZipTree(fs, bootstrapTree);

    const bootstrapEnvironment = build.requirePackageOutput(
      "package-homebrew-bootstrap-output-homebrew-brew",
    );
    if (bootstrapEnvironment.placement !== "embedded") {
      throw new Error("Homebrew bootstrap environment must be embedded");
    }
    const environment = readHomebrewBootstrapEnvironment(
      bootstrapEnvironment.path,
      build.product.architecture,
    );
    const bootstrapState = installHomebrewBootstrapConsumerState(
      fs,
      bootstrapTree,
      environment,
    );
    const atomicGroup = bootstrapTree.descriptor.activation.atomicGroup;
    if (atomicGroup !== undefined) {
      await fs.sealLazyAtomicGroup(atomicGroup.id, [atomicGroup.member]);
    }

    installMainShellConfiguration(
      fs,
      configPath("main-shell-default.json"),
      configPath("main-shell-demo.json"),
    );
    writeVfsBinary(
      fs,
      HOMEBREW_COMPOSITION_PATH,
      new TextEncoder().encode(canonicalJson({
        schema: 1,
        kind: "kandelo-staged-homebrew-product",
        source: build.source,
        target_abi: build.targetAbi,
        packages: bottleTrees.map((item) => ({
          formula: item.formula,
          full_name: item.descriptor.tree.package,
          sha256: item.descriptor.tree.content.sha256,
          bytes: item.descriptor.tree.content.bytes,
          materialization: item.placement,
          tree_id: item.descriptor.tree.id,
          required_by: item.descriptor.required_by,
        })),
        compatibility: compatibilityEvidence,
        bootstrap: bootstrapState,
      })),
      0o644,
    );

    await saveImage(fs, invocation.outputPath, {
      normalizeTimestampsMs: sourceDateEpochMilliseconds(
        process.env.SOURCE_DATE_EPOCH,
      ),
      metadata: {
        ...(baseMetadata ?? { version: 1 }),
        version: 1,
        kernelAbi: build.targetAbi.version,
        abiSnapshotSha256: build.targetAbi.snapshot_sha256,
        createdBy: "images/vfs/scripts/staged-product-inputs.ts",
        baseImage: {
          sha256: base.sha256,
          bytes: base.bytes,
        },
        homebrewBootstrap: bootstrapState,
      },
    });
    await build.finish(invocation.outputPath);
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}

export function parseStagedProductInvocation(
  arguments_: readonly string[],
): StagedProductInvocation | null {
  if (arguments_.length === 0) return null;
  if (arguments_.length !== STAGING_FLAGS.size * 2) {
    throw new Error(
      "staging flags must be exactly --vfs-product-manifest, --vfs-product-inputs, --vfs-product-report, and --vfs-product-output",
    );
  }
  const values: Partial<StagedProductInvocation> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const field = STAGING_FLAGS.get(flag as keyof typeof STAGING_FLAGS);
    if (field === undefined) {
      throw new Error(`unknown staging flag ${JSON.stringify(flag)}`);
    }
    if (values[field] !== undefined) {
      throw new Error(`duplicate staging flag ${JSON.stringify(flag)}`);
    }
    const value = arguments_[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      !isAbsolute(value) ||
      resolve(value) !== value
    ) {
      throw new Error(`${flag} must name a normalized absolute path`);
    }
    values[field] = value;
  }
  for (const field of STAGING_FLAGS.values()) {
    if (values[field] === undefined) {
      throw new Error(`staging flags omit ${field}`);
    }
  }
  const invocation = values as StagedProductInvocation;
  if (new Set(Object.values(invocation)).size !== 4) {
    throw new Error("staging manifest, input, report, and output paths must be distinct");
  }
  return invocation;
}

/** Reject legacy discovery variables before an opt-in staged builder runs. */
export function assertStagedProductEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const forbidden = Object.keys(environment)
    .filter((name) => {
      const value = environment[name];
      if (value === undefined || value === "") return false;
      return (
        name === "BOTTLE_CACHE" ||
        name === "KANDELO_VFS_INPUT_ROOT" ||
        name === "ROOTFS_BINARIES_DIR" ||
        name === "ROOTFS_PACKAGE_MANIFEST" ||
        name === "ROOTFS_PACKAGES_CONFIG" ||
        name === "WASM_POSIX_BINARY_CACHE_ROOT" ||
        name === "WASM_POSIX_DEPS_REGISTRY" ||
        /^WASM_POSIX_DEP_[A-Z0-9_]+_DIR$/.test(name)
      );
    })
    .sort();
  if (forbidden.length > 0) {
    throw new Error(
      `staged VFS product rejects ambient input authority: ${forbidden.join(", ")}`,
    );
  }
}

export function createRepositoryPathBundle(options: {
  repositoryRoot: string;
  paths: readonly string[];
  source: Readonly<ExactSourceIdentity>;
  outputPath: string;
}): void {
  const repositoryRoot = realDirectory(options.repositoryRoot, "repository root");
  const source = sourceIdentity(options.source, "repository bundle source");
  const paths = normalizedRoots(options.paths);
  const entries: RepositoryPathBundleEntry[] = [];
  const seen = new Set<string>();

  const visit = (relativePath: string): void => {
    if (seen.has(relativePath)) return;
    const absolutePath = within(repositoryRoot, relativePath, "repository path");
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(absolutePath);
    } catch (error) {
      throw new Error(
        `repository path ${JSON.stringify(relativePath)} is missing: ${describeError(error)}`,
      );
    }
    seen.add(relativePath);
    const mode = metadata.mode & 0o7777;
    if (metadata.isDirectory()) {
      entries.push({ kind: "directory", mode, path: relativePath });
      const children = readdirSync(absolutePath).sort(compareText);
      for (const child of children) {
        visit(`${relativePath}/${child}`);
      }
      return;
    }
    if (metadata.isSymbolicLink()) {
      const target = readlinkSync(absolutePath);
      validateSymlinkTarget(relativePath, target);
      const resolvedTarget = resolve(dirname(absolutePath), target);
      assertBelow(repositoryRoot, resolvedTarget, `repository symlink ${relativePath}`);
      entries.push({ kind: "symlink", mode, path: relativePath, target });
      return;
    }
    if (!metadata.isFile()) {
      throw new Error(
        `repository path ${JSON.stringify(relativePath)} is not a regular file, directory, or symlink`,
      );
    }
    const contents = readFileSync(absolutePath);
    entries.push({
      bytes: contents.byteLength,
      content_base64: contents.toString("base64"),
      kind: "file",
      mode,
      path: relativePath,
      sha256: digest(contents),
    });
  };

  for (const path of paths) visit(path);
  entries.sort((left, right) => compareText(left.path, right.path));
  if (entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error(`repository bundle exceeds ${MAX_BUNDLE_ENTRIES} entries`);
  }
  const body = canonicalJson({
    entries,
    kind: "kandelo-vfs-repository-path-bundle",
    paths,
    schema: 1,
    source,
  });
  if (Buffer.byteLength(body) > MAX_BUNDLE_BYTES) {
    throw new Error(`repository bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  }
  assertNewRegularParent(options.outputPath, "repository bundle output");
  writeFileSync(options.outputPath, body, { flag: "wx", mode: 0o600 });
}

export function readRepositoryPathBundle(
  path: string,
  expectedSource: Readonly<ExactSourceIdentity>,
): RepositoryPathBundle {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("repository bundle must be a regular nonsymlink file");
  }
  if (metadata.size > MAX_BUNDLE_BYTES) {
    throw new Error(`repository bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  }
  const text = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`repository bundle is invalid JSON: ${describeError(error)}`);
  }
  if (canonicalJson(value) !== text) {
    throw new Error("repository bundle is not canonical JSON");
  }
  const root = exactRecord(
    value,
    ["entries", "kind", "paths", "schema", "source"],
    "repository bundle",
  );
  if (
    root.schema !== 1 ||
    root.kind !== "kandelo-vfs-repository-path-bundle"
  ) {
    throw new Error("repository bundle protocol is unsupported");
  }
  const source = sourceIdentity(root.source, "repository bundle source");
  if (canonicalJson(source) !== canonicalJson(sourceIdentity(expectedSource, "expected source"))) {
    throw new Error("repository bundle source differs from the resolved exact source");
  }
  if (!Array.isArray(root.paths)) {
    throw new Error("repository bundle paths must be an array");
  }
  const paths = normalizedRoots(root.paths);
  if (!Array.isArray(root.entries) || root.entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error("repository bundle entries exceed their bound");
  }
  const seen = new Set<string>();
  let previous = "";
  const entries = root.entries.map((raw, index): RepositoryPathBundleEntry => {
    const entry = recordValue(raw, `repository bundle entry ${index}`);
    const kind = entry.kind;
    const keys = kind === "file"
      ? ["bytes", "content_base64", "kind", "mode", "path", "sha256"]
      : kind === "directory"
      ? ["kind", "mode", "path"]
      : kind === "symlink"
      ? ["kind", "mode", "path", "target"]
      : [];
    if (keys.length === 0) {
      throw new Error(`repository bundle entry ${index} kind is unsupported`);
    }
    exactRecord(entry, keys, `repository bundle entry ${index}`);
    const entryPath = normalizedRelativePath(
      entry.path,
      `repository bundle entry ${index} path`,
    );
    if (
      entryPath <= previous ||
      seen.has(entryPath) ||
      !paths.some((rootPath) => isAtOrBelow(rootPath, entryPath))
    ) {
      throw new Error("repository bundle entry paths are not sorted, unique, and selected");
    }
    previous = entryPath;
    seen.add(entryPath);
    const mode = fileMode(entry.mode, `repository bundle entry ${index} mode`);
    if (kind === "directory") return { kind, mode, path: entryPath };
    if (kind === "symlink") {
      const target = textValue(entry.target, `repository bundle entry ${index} target`, 4096);
      validateSymlinkTarget(entryPath, target);
      return { kind, mode, path: entryPath, target };
    }
    const bytes = nonnegativeInteger(
      entry.bytes,
      `repository bundle entry ${index} bytes`,
    );
    const sha256 = sha(entry.sha256, `repository bundle entry ${index} SHA-256`);
    const contentBase64 = entry.content_base64;
    if (
      typeof contentBase64 !== "string" ||
      contentBase64.includes("\0") ||
      Buffer.byteLength(contentBase64) > MAX_BUNDLE_BYTES * 2
    ) {
      throw new Error(`repository bundle entry ${index} base64 must be bounded text`);
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
      throw new Error(`repository bundle entry ${index} content is not canonical base64`);
    }
    const contents = Buffer.from(contentBase64, "base64");
    if (contents.toString("base64") !== contentBase64) {
      throw new Error(`repository bundle entry ${index} content is not canonical base64`);
    }
    if (contents.byteLength !== bytes) {
      throw new Error(`repository bundle entry ${index} byte count does not match`);
    }
    if (digest(contents) !== sha256) {
      throw new Error(`repository bundle entry ${index} SHA-256 does not match`);
    }
    return {
      bytes,
      content_base64: contentBase64,
      kind,
      mode,
      path: entryPath,
      sha256,
    };
  });
  for (const rootPath of paths) {
    if (!entries.some((entry) => isAtOrBelow(rootPath, entry.path))) {
      throw new Error(`repository bundle omits selected root ${JSON.stringify(rootPath)}`);
    }
  }
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    const resolvedTarget = normalizeRelativeTarget(entry.path, entry.target);
    if (!seen.has(resolvedTarget)) {
      throw new Error(
        `repository bundle symlink ${JSON.stringify(entry.path)} targets unselected path ${JSON.stringify(resolvedTarget)}`,
      );
    }
  }
  return Object.freeze({
    schema: 1,
    kind: "kandelo-vfs-repository-path-bundle",
    source: Object.freeze(source),
    paths: Object.freeze(paths),
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
}

export function materializeRepositoryPathBundle(
  bundle: RepositoryPathBundle,
  destination: string,
): void {
  try {
    lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    const directories = bundle.entries
      .filter((entry) => entry.kind === "directory")
      .sort((left, right) => {
        const depth = left.path.split("/").length - right.path.split("/").length;
        return depth || compareText(left.path, right.path);
      });
    for (const entry of directories) {
      const target = within(destination, entry.path, "repository bundle directory");
      mkdirSync(target, { recursive: true, mode: entry.mode });
      chmodSync(target, entry.mode);
    }
    for (const entry of bundle.entries) {
      if (entry.kind === "directory") continue;
      const target = within(destination, entry.path, "repository bundle entry");
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      if (entry.kind === "symlink") {
        symlinkSync(entry.target, target);
      } else {
        const contents = Buffer.from(entry.content_base64, "base64");
        writeFileSync(target, contents, { flag: "wx", mode: entry.mode });
        chmodSync(target, entry.mode);
      }
    }
    return;
  }
  throw new Error(`repository bundle destination already exists: ${destination}`);
}

function readCanonicalJson(path: string, label: string): unknown {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 16 * 1024 * 1024) {
    throw new Error(`${label} must be a bounded regular nonsymlink file`);
  }
  const source = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${describeError(error)}`);
  }
  // Product descriptors are machine-authored identities. Human-authored
  // repository JSON remains readable and need not use the compact encoding.
  if (label.includes("descriptor") && canonicalJson(value) !== source) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
}

function ensureHomebrewPrefixAncestors(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/opt");
  ensureDirRecursive(fs, "/opt/kandelo");
}

function parseMainShellCompatibilityPolicy(
  value: unknown,
): MainShellCompatibilityPolicy {
  const root = exactRecord(value, [
    "aliases",
    "kind",
    "link_conflict_owners",
    "mirror_link_manifest_bin",
    "runtime_state",
    "schema",
  ], "main-shell compatibility policy");
  if (
    root.schema !== 1 ||
    root.kind !== "kandelo-homebrew-product-compatibility"
  ) {
    throw new Error("main-shell compatibility policy identity is unsupported");
  }
  const mirror = exactRecord(
    root.mirror_link_manifest_bin,
    ["targets"],
    "main-shell mirror policy",
  );
  const targets = stringArray(
    mirror.targets,
    "main-shell mirror targets",
    1,
    16,
  ).map((path) => canonicalAbsolutePath(path, "main-shell mirror target"));
  assertUnique(targets, "main-shell mirror targets");

  const conflicts = arrayValue(
    root.link_conflict_owners,
    "main-shell conflict owners",
    0,
    256,
  ).map((value, index) => {
    const item = exactRecord(
      value,
      ["package", "reason", "target"],
      `main-shell conflict owner ${index}`,
    );
    return {
      package: fullHomebrewName(item.package, `main-shell conflict owner ${index} package`),
      reason: textValue(item.reason, `main-shell conflict owner ${index} reason`, 1024),
      target: normalizedRelativePath(item.target, `main-shell conflict owner ${index} target`),
    };
  });
  assertUnique(conflicts.map((item) => item.target), "main-shell conflict targets");

  const aliases = arrayValue(root.aliases, "main-shell aliases", 0, 256)
    .map((value, index) => {
      const item = exactRecord(
        value,
        ["package", "source", "source_kind", "targets"],
        `main-shell alias ${index}`,
      );
      if (item.source_kind !== "link" && item.source_kind !== "keg") {
        throw new Error(`main-shell alias ${index} source kind is unsupported`);
      }
      const aliasTargets = stringArray(
        item.targets,
        `main-shell alias ${index} targets`,
        1,
        32,
      ).map((path) => canonicalAbsolutePath(path, `main-shell alias ${index} target`));
      assertUnique(aliasTargets, `main-shell alias ${index} targets`);
      return {
        package: fullHomebrewName(item.package, `main-shell alias ${index} package`),
        source_kind: item.source_kind,
        source: normalizedRelativePath(item.source, `main-shell alias ${index} source`),
        targets: aliasTargets,
      };
    });
  assertUnique(
    aliases.flatMap((item) => item.targets),
    "main-shell alias destinations",
  );

  const runtimeState = arrayValue(
    root.runtime_state,
    "main-shell runtime state",
    0,
    256,
  ).map((value, index) => {
    const initial = recordValue(value, `main-shell runtime state ${index}`);
    const kind = initial.kind;
    if (kind !== "directory" && kind !== "empty_file" && kind !== "text_file") {
      throw new Error(`main-shell runtime state ${index} kind is unsupported`);
    }
    const item = exactRecord(
      value,
      [
        "gid",
        "kind",
        "mode",
        "path",
        "reason",
        "requires_package",
        "uid",
        ...(kind === "text_file" ? ["contents"] : []),
      ],
      `main-shell runtime state ${index}`,
    );
    const contents = kind === "text_file"
      ? textValue(item.contents, `main-shell runtime state ${index} contents`, 64 * 1024)
      : undefined;
    return {
      requires_package: fullHomebrewName(
        item.requires_package,
        `main-shell runtime state ${index} package`,
      ),
      path: canonicalAbsolutePath(item.path, `main-shell runtime state ${index} path`),
      kind,
      mode: fileMode(item.mode, `main-shell runtime state ${index} mode`),
      uid: nonnegativeInteger(item.uid, `main-shell runtime state ${index} uid`),
      gid: nonnegativeInteger(item.gid, `main-shell runtime state ${index} gid`),
      reason: textValue(item.reason, `main-shell runtime state ${index} reason`, 1024),
      ...(contents === undefined ? {} : { contents }),
    };
  });
  assertUnique(runtimeState.map((item) => item.path), "main-shell runtime-state paths");
  return {
    mirror_link_manifest_bin: { targets },
    link_conflict_owners: conflicts,
    aliases,
    runtime_state: runtimeState,
  };
}

function applyMainShellCompatibility(
  fs: MemoryFileSystem,
  policy: MainShellCompatibilityPolicy,
  bottles: readonly StagedBottleTree[],
): unknown {
  const byPackage = new Map(
    bottles.map((item) => [item.descriptor.tree.package!, item]),
  );
  const links: Array<{ path: string; target: string; package: string }> = [];
  const destinations = new Set<string>();
  const install = (source: string, target: string, pkg: string): void => {
    if (destinations.has(target)) {
      throw new Error(`main-shell compatibility assigns ${target} more than once`);
    }
    destinations.add(target);
    installHomebrewCompatibilityLink(fs, source, target);
    links.push({ package: pkg, path: target, target: source });
  };

  for (const targetDirectory of policy.mirror_link_manifest_bin.targets) {
    for (const bottle of bottles) {
      const packageName = bottle.descriptor.tree.package!;
      for (const entry of bottle.descriptor.tree.inventory.entries) {
        const prefix = `${HOMEBREW_PREFIX.slice(1)}/bin/`;
        if (
          !entry.path.startsWith(prefix) ||
          entry.path.slice(prefix.length).includes("/") ||
          entry.type === "directory"
        ) continue;
        const target = `${targetDirectory}/${entry.path.slice(prefix.length)}`
          .replace(/\/+/g, "/");
        install(`/${entry.path}`, target, packageName);
      }
    }
  }

  for (const alias of policy.aliases) {
    const bottle = byPackage.get(alias.package);
    if (bottle === undefined) continue;
    const source = alias.source_kind === "link"
      ? `${HOMEBREW_PREFIX}/${alias.source}`
      : `${bottle.descriptor.tree.activation.roots[0]}/${alias.source}`;
    for (const target of alias.targets) install(source, target, alias.package);
  }

  for (const conflict of policy.link_conflict_owners) {
    const bottle = byPackage.get(conflict.package);
    if (bottle === undefined) continue;
    const owned = bottle.descriptor.tree.inventory.entries.filter(
      (entry) => entry.path === `${HOMEBREW_PREFIX.slice(1)}/${conflict.target}`,
    );
    if (owned.length !== 1) {
      throw new Error(
        `main-shell conflict owner ${conflict.package} does not own ${conflict.target}`,
      );
    }
  }

  const runtimeState: Array<Record<string, unknown>> = [];
  for (const declaration of policy.runtime_state) {
    if (!byPackage.has(declaration.requires_package)) continue;
    const existing = tryVfsLstat(fs, declaration.path);
    if (existing !== null) {
      if (
        declaration.kind !== "directory" ||
        (existing.mode & 0xf000) !== 0x4000 ||
        (existing.mode & 0o7777) !== declaration.mode ||
        existing.uid !== declaration.uid ||
        existing.gid !== declaration.gid
      ) {
        throw new Error(
          `main-shell runtime state collides with ${declaration.path}`,
        );
      }
    } else if (declaration.kind === "directory") {
      ensureDirRecursive(fs, dirname(declaration.path));
      fs.mkdirWithOwner(
        declaration.path,
        declaration.mode,
        declaration.uid,
        declaration.gid,
      );
    } else {
      ensureDirRecursive(fs, dirname(declaration.path));
      fs.createFileWithOwner(
        declaration.path,
        declaration.mode,
        declaration.uid,
        declaration.gid,
        new TextEncoder().encode(declaration.contents ?? ""),
      );
    }
    runtimeState.push({ ...declaration });
  }
  return { links, runtime_state: runtimeState };
}

function installHomebrewCompatibilityLink(
  fs: MemoryFileSystem,
  source: string,
  target: string,
): void {
  const sourceStat = fs.stat(source);
  if (
    (sourceStat.mode & 0xf000) !== 0x8000 ||
    (sourceStat.mode & 0o111) === 0
  ) {
    throw new Error(`main-shell compatibility source is not executable: ${source}`);
  }
  const existing = tryVfsLstat(fs, target);
  if (existing !== null) {
    if (
      (existing.mode & 0xf000) === 0xa000 &&
      fs.readlink(target) === source
    ) return;
    if (!fs.isPathDeferred(target)) {
      throw new Error(`main-shell compatibility target already exists: ${target}`);
    }
    fs.unlink(target);
  }
  ensureDirRecursive(fs, dirname(target));
  fs.symlinkWithOwner(source, target, 0, 0);
}

function installMainShellConfiguration(
  fs: MemoryFileSystem,
  shellConfigPath: string,
  demoConfigPath: string,
): void {
  const shellBytes = boundedRegularBytes(shellConfigPath, 64 * 1024, "main-shell config");
  const shellSource = new TextDecoder("utf-8", { fatal: true }).decode(shellBytes);
  const shell = parseKandeloShellConfig(shellSource);
  if (shell === null) throw new Error("main-shell config has an unsupported version");
  const shellStat = fs.stat(shell.path);
  if (
    (shellStat.mode & 0xf000) !== 0x8000 ||
    (shellStat.mode & 0o111) === 0 ||
    fs.isPathDeferred(shell.path)
  ) {
    throw new Error("main-shell default executable is not embedded and executable");
  }
  if (tryVfsLstat(fs, KANDELO_SHELL_CONFIG_PATH) !== null) {
    throw new Error("main-shell config destination already exists");
  }
  ensureDirRecursive(fs, dirname(KANDELO_SHELL_CONFIG_PATH));
  writeVfsBinary(fs, KANDELO_SHELL_CONFIG_PATH, shellBytes, 0o644);

  const demoBytes = boundedRegularBytes(demoConfigPath, 1024 * 1024, "main-shell demo config");
  const demoSource = new TextDecoder("utf-8", { fatal: true }).decode(demoBytes);
  const demo = parseKandeloDemoConfig(demoSource);
  if (demo === null) throw new Error("main-shell demo config has an unsupported version");
  validateKandeloDemoConfig(demo);
  if (tryVfsLstat(fs, KANDELO_DEMO_CONFIG_PATH) !== null) {
    throw new Error("main-shell demo config destination already exists");
  }
  writeVfsBinary(fs, KANDELO_DEMO_CONFIG_PATH, demoBytes, 0o644);
}

function boundedRegularBytes(path: string, maximum: number, label: string): Uint8Array {
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > maximum
  ) {
    throw new Error(`${label} must be a bounded regular nonsymlink file`);
  }
  return new Uint8Array(readFileSync(path));
}

function tryVfsLstat(fs: MemoryFileSystem, path: string) {
  try {
    return fs.lstat(path);
  } catch (error) {
    if (error instanceof SFSError && error.code === ENOENT) return null;
    throw error;
  }
}

function arrayValue(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} through ${maximum} entries`);
  }
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string[] {
  return arrayValue(value, label, minimum, maximum).map((item, index) =>
    textValue(item, `${label} ${index}`, 4096)
  );
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} are not unique`);
  }
}

function canonicalAbsolutePath(value: unknown, label: string): string {
  const path = textValue(value, label, 4096);
  if (
    path === "/" ||
    !path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.split("/").slice(1).some((part) =>
      part === "" || part === "." || part === ".."
    )
  ) {
    throw new Error(`${label} is not a normalized absolute path`);
  }
  return path;
}

function fullHomebrewName(value: unknown, label: string): string {
  const name = textValue(value, label, 512);
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(`${label} is not a full Homebrew package name`);
  }
  return name;
}

function normalizedRoots(value: readonly unknown[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error("repository bundle paths must contain 1..256 entries");
  }
  const paths = value.map((path, index) =>
    normalizedRelativePath(path, `repository bundle path ${index}`)
  );
  const sorted = [...new Set(paths)].sort(compareText);
  if (
    sorted.length !== paths.length ||
    sorted.some((path, index) => path !== paths[index]) ||
    sorted.some((path, index) =>
      sorted.some((other, otherIndex) =>
        index !== otherIndex && isAtOrBelow(other, path)
      )
    )
  ) {
    throw new Error("repository bundle paths must be sorted, unique, and nonoverlapping");
  }
  return sorted;
}

function sourceIdentity(value: unknown, label: string): ExactSourceIdentity {
  const source = exactRecord(value, ["commit", "repository", "tree"], label);
  const repository = textValue(source.repository, `${label} repository`, 255);
  if (!REPOSITORY.test(repository)) throw new Error(`${label} repository is invalid`);
  return {
    repository,
    commit: gitSha(source.commit, `${label} commit`),
    tree: gitSha(source.tree, `${label} tree`),
  };
}

function normalizedRelativePath(value: unknown, label: string): string {
  const path = textValue(value, label, 4096);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path !== path.normalize("NFC") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a normalized relative POSIX path`);
  }
  return path;
}

function validateSymlinkTarget(path: string, target: string): void {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.length > 4096 ||
    target.includes("\0") ||
    target.includes("\\") ||
    target.startsWith("/") ||
    target !== target.normalize("NFC")
  ) {
    throw new Error(`repository symlink ${JSON.stringify(path)} has an unsafe target`);
  }
  normalizeRelativeTarget(path, target);
}

function normalizeRelativeTarget(path: string, target: string): string {
  const stack = path.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error(`repository symlink ${JSON.stringify(path)} escapes its bundle`);
      }
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  if (stack.length === 0) {
    throw new Error(`repository symlink ${JSON.stringify(path)} targets the bundle root`);
  }
  return stack.join("/");
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(absolute);
}

function within(root: string, path: string, label: string): string {
  const target = resolve(root, ...path.split("/"));
  assertBelow(root, target, label);
  return target;
}

function assertBelow(root: string, target: string, label: string): void {
  const fromRoot = relative(root, target);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} escapes its root`);
  }
}

function isAtOrBelow(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function assertNewRegularParent(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  const parent = lstatSync(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${label} parent must be a real directory`);
  }
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = recordValue(value, label);
  const actual = Object.keys(record).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return record;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maximum
  ) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function fileMode(value: unknown, label: string): number {
  const mode = nonnegativeInteger(value, label);
  if (mode > 0o7777) throw new Error(`${label} exceeds POSIX permission bits`);
  return mode;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is not lowercase SHA-256`);
  }
  return value;
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    throw new Error(`${label} is not a full lowercase Git SHA`);
  }
  return value;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SelectedProductManifest {
  id: string;
  architecture: "wasm32" | "wasm64";
  output: string;
  builder: string;
  software: {
    homebrew: Array<{
      tap: string;
      formulae: string[];
      materialization: "embedded" | "lazy";
    }>;
  };
}

function validateSelectedProductManifest(
  manifestPath: string,
  build: Awaited<ReturnType<typeof openVfsProductBuild>>,
): SelectedProductManifest {
  const expectedPath = resolve(REPOSITORY_ROOT, build.product.manifest_path);
  if (manifestPath !== expectedPath) {
    throw new Error("staged product manifest path differs from resolved inputs");
  }
  const metadata = lstatSync(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("staged product manifest must be a regular nonsymlink file");
  }
  const catalog = loadVfsProductCatalog(
    join(REPOSITORY_ROOT, "images/vfs/products/generated/catalog.json"),
  );
  const manifest = catalog.productById(build.product.id) as SelectedProductManifest;
  if (
    manifest.id !== build.product.id ||
    manifest.architecture !== build.product.architecture ||
    manifest.output !== build.product.output ||
    digest(Buffer.from(canonicalJson(manifest))) !== build.product.manifest_sha256
  ) {
    throw new Error("staged product manifest identity differs from resolved inputs");
  }
  return manifest;
}

function boundedDiagnostics(...values: readonly string[]): string {
  const joined = values.filter((value) => value.length > 0).join("\n");
  const maximum = 32 * 1024;
  return joined.length <= maximum
    ? joined
    : `${joined.slice(0, maximum)}\n[diagnostics truncated]`;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  const command = process.argv[2];
  Promise.resolve().then(async () => {
    if (command !== "platform-rootfs" && command !== "browser-main-shell") {
      throw new Error(
        "expected staged product command platform-rootfs or browser-main-shell",
      );
    }
    const invocation = parseStagedProductInvocation(process.argv.slice(3));
    if (invocation === null) {
      throw new Error(`${command} staging flags are required`);
    }
    if (command === "platform-rootfs") {
      await buildStagedPlatformRootfs(invocation);
    } else {
      await buildStagedBrowserMainShell(invocation);
    }
  }).catch((error) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
