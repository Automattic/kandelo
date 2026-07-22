import type {
  HomebrewDeferredTreeDescriptor,
  HomebrewDeferredTreeSourceEntry,
  HomebrewLazyLayerDescriptor,
  HomebrewLazyLayerEntry,
  HomebrewLazyLayerPackageRecord,
} from "./homebrew-lazy-layer-descriptor";
import {
  canonicalHomebrewRuntimeLayerBundleIdentityBytes,
  canonicalHomebrewRuntimeLayerDescriptorBytes,
  compareHomebrewCanonicalText,
} from "./homebrew-lazy-layer-descriptor";
import {
  MemoryFileSystem,
  type DeferredTreeMaterializationHandle,
  type LazyTreeGroup,
  type LazyTreeRegistrationEntry,
} from "./vfs/memory-fs";
import type { VfsDeferredTreeUsage } from "./vfs/deferred-tree-limits";
import { resolveHardlinkGraph } from "./vfs/hardlink-graph";
import {
  HOMEBREW_RUNTIME_LAYER_LIMITS,
  isHomebrewRuntimeLayerId,
} from "./homebrew-runtime-layer-limits";
export { HOMEBREW_RUNTIME_LAYER_LIMITS } from "./homebrew-runtime-layer-limits";

const HOMEBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";
const ACCEPTANCE_ASSET = "kandelo-homebrew.vfs.zst";
const ACCEPTANCE_DESCRIPTOR_ASSET = "kandelo-homebrew-vfs.json";
const ACCEPTANCE_REPORT_ASSET = "kandelo-homebrew-vfs-report.json";
const ACCEPTANCE_NODE_ASSET = "kandelo-homebrew-node-evidence.json";
const ACCEPTANCE_BROWSER_ASSET = "kandelo-homebrew-browser-evidence.json";
const RUNTIME_LAYER_TAG_PREFIX = "homebrew-runtime-layer-sha256-";
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const PACKAGE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RELEASE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

export interface HomebrewRuntimeLayerReference {
  id: string;
  descriptor: {
    url: string;
    sha256: string;
    bytes: number;
  };
}

export interface ComposeHomebrewRuntimeLayersOptions {
  /** Exact immutable package output that owns the composition transaction. */
  baseImageBytes: Uint8Array;
  /** Optional runtime growth ceiling for the newly restored composition FS. */
  maxByteLength?: number;
  arch: "wasm32" | "wasm64";
  kernelAbi: number;
  layers: readonly HomebrewRuntimeLayerReference[];
  /** Credential-free descriptor transport. */
  fetch?: (url: string) => Promise<Response>;
  /** Credential-free deferred-tree transport, including boot-prefetch trees. */
  archiveFetch?: (url: string) => Promise<Response>;
  /**
   * Observe a private staged filesystem that is abandoned before publication.
   * Browser callers use this to register the SharedArrayBuffer for WebKit
   * reclamation; the observer must not retain the buffer.
   */
  onStagedFileSystemDiscarded?: (buffer: SharedArrayBuffer) => void;
}

export interface RegisteredHomebrewRuntimeLayer {
  id: string;
  descriptor: HomebrewLazyLayerDescriptor;
  deferredTrees: LazyTreeGroup[];
}

export interface ComposedHomebrewRuntimeLayers {
  fs: MemoryFileSystem;
  layers: RegisteredHomebrewRuntimeLayer[];
}

interface RegisterHomebrewRuntimeLayersOptions extends ComposeHomebrewRuntimeLayersOptions {
  fs: MemoryFileSystem;
}

interface LoadedLayer {
  reference: HomebrewRuntimeLayerReference;
  descriptor: HomebrewLazyLayerDescriptor;
}

interface PlannedTree {
  descriptor: HomebrewDeferredTreeDescriptor;
  entries: LazyTreeRegistrationEntry[];
}

interface HomebrewDeferredTreeCollectionPlan {
  id: string;
  schema: 4 | 5;
  mountPrefix: string;
  trees: readonly HomebrewDeferredTreeDescriptor[];
}

interface PlannedTreeCollection extends Omit<HomebrewDeferredTreeCollectionPlan, "trees"> {
  trees: PlannedTree[];
  directories: HomebrewLazyLayerEntry[];
}

export interface RegisterHomebrewDeferredTreeCollectionOptions {
  fs: MemoryFileSystem;
  /** Human-readable identity used in collision diagnostics. */
  id: string;
  /** Schema 5 admits absent/equal mergeable directories. */
  schema: 4 | 5;
  mountPrefix?: string;
  /** Producer-verified closed trees with concrete immutable transport URLs. */
  trees: readonly HomebrewDeferredTreeDescriptor[];
}

export interface RegisteredHomebrewDeferredTree {
  id: string;
  package?: string;
  content: {
    sha256: string;
    bytes: number;
  };
  materialization: DeferredTreeMaterializationHandle;
}

/**
 * Restore one immutable shell image into a private filesystem, then fetch,
 * verify, preflight, and register independently selected Homebrew runtime
 * layers. The filesystem is published to the caller only after every selected
 * layer and boot-prefetch tree succeeds, so allocation, collision, and fetch
 * failures cannot expose a partial namespace. Descriptor bytes are eager and
 * bounded; first-use deferred-tree bytes remain lazy.
 */
export async function composeHomebrewRuntimeLayers(
  options: ComposeHomebrewRuntimeLayersOptions,
): Promise<ComposedHomebrewRuntimeLayers> {
  const fs = options.maxByteLength === undefined
    ? MemoryFileSystem.fromImagePreservingCapacity(options.baseImageBytes)
    : MemoryFileSystem.fromImage(options.baseImageBytes, {
      maxByteLength: options.maxByteLength,
    });
  try {
    if (options.archiveFetch !== undefined) fs.setLazyFetcher(options.archiveFetch);
    const layers = options.layers.length === 0
      ? []
      : await registerHomebrewRuntimeLayersOnStagedFileSystem({ ...options, fs });
    return { fs, layers };
  } catch (error) {
    // This filesystem was deliberately private until the composition
    // transaction completed, so a rejection gives the caller no other way to
    // observe its large SharedArrayBuffer. Reclamation observers are best
    // effort and must never replace the truthful composition failure.
    try {
      options.onStagedFileSystemDiscarded?.(fs.sharedBuffer);
    } catch {
      // Preserve the original composition error.
    }
    throw error;
  }
}

/**
 * Register one producer-verified tree collection on an exclusive composition
 * filesystem. All paths and aggregate resource limits are preflighted before
 * namespace mutation. Returned authorities are bound to the exact filesystem,
 * tree id, package identity, digest, and byte count reported beside them.
 */
export function registerHomebrewDeferredTreeCollection(
  options: RegisterHomebrewDeferredTreeCollectionOptions,
): RegisteredHomebrewDeferredTree[] {
  if (!isHomebrewRuntimeLayerId(options.id)) {
    throw new Error(`Homebrew deferred-tree collection id ${options.id} is invalid`);
  }
  const mountPrefix = options.mountPrefix ?? "/";
  const collection: HomebrewDeferredTreeCollectionPlan = {
    id: options.id,
    schema: options.schema,
    mountPrefix,
    trees: options.trees,
  };
  options.fs.assertCanAppendDeferredTreeUsage(deferredTreeUsage(options.trees));
  const [planned] = preflightDeferredTreeCollections(options.fs, [collection]);
  createDeferredTreeDirectories(options.fs, [planned]);
  return planned.trees.map((tree) => ({
    id: tree.descriptor.id,
    ...(tree.descriptor.package === undefined
      ? {}
      : { package: tree.descriptor.package }),
    content: {
      sha256: tree.descriptor.content.sha256,
      bytes: tree.descriptor.content.bytes,
    },
    materialization: registerPlannedDeferredTreeWithHandle(
      options.fs,
      tree,
      planned.mountPrefix,
    ),
  }));
}

async function registerHomebrewRuntimeLayersOnStagedFileSystem(
  options: RegisterHomebrewRuntimeLayersOptions,
): Promise<RegisteredHomebrewRuntimeLayer[]> {
  if (options.layers.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxLayers) {
    throw new Error(
      `Homebrew runtime layer count ${options.layers.length} exceeds ` +
        `${HOMEBREW_RUNTIME_LAYER_LIMITS.maxLayers}`,
    );
  }
  if (!Number.isSafeInteger(options.kernelAbi) || options.kernelAbi <= 0) {
    throw new Error("Homebrew runtime layer kernel ABI is invalid");
  }
  validateReferences(options.layers);
  const declaredAbi = options.fs.getImageMetadata()?.kernelAbi;
  if (declaredAbi !== options.kernelAbi) {
    throw new Error(
      `Homebrew runtime layer base VFS declares ABI ${String(declaredAbi)}, ` +
        `expected ${options.kernelAbi}`,
    );
  }

  const fetcher = options.fetch ?? ((url: string) => globalThis.fetch(url));
  const loaded = await Promise.all(options.layers.map(async (reference) => {
    const bytes = await fetchExactBytes(reference.descriptor, fetcher);
    const descriptor = parseHomebrewRuntimeLayerDescriptor(
      decodeJson(bytes, `Homebrew runtime layer ${reference.id} descriptor`),
    );
    const canonicalDescriptor = canonicalHomebrewRuntimeLayerDescriptorBytes(descriptor);
    if (
      canonicalDescriptor.byteLength !== bytes.byteLength ||
      canonicalDescriptor.some((byte, index) => byte !== bytes[index])
    ) {
      throw new Error(
        `Homebrew runtime layer ${reference.id} descriptor bytes are not canonical-json-v1`,
      );
    }
    const actualBundleSha = await sha256Hex(
      canonicalHomebrewRuntimeLayerBundleIdentityBytes(descriptor),
    );
    if (
      descriptor.bundle.sha256 !== actualBundleSha ||
      descriptor.release.tag !== `${RUNTIME_LAYER_TAG_PREFIX}${actualBundleSha}`
    ) {
      throw new Error(
        `Homebrew runtime layer ${reference.id} bundle identity does not match its descriptor`,
      );
    }
    return { reference, descriptor };
  }));

  const actualBase = {
    bytes: options.baseImageBytes.byteLength,
    sha256: await sha256Hex(options.baseImageBytes),
  };
  const compositionBytes = readBoundedFile(
    options.fs,
    COMPOSITION_PATH,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxDescriptorBytes,
  );
  const compositionSha = await sha256Hex(compositionBytes);
  const composition = parseBaseComposition(compositionBytes);
  composition.packageSetSha256 = await sha256Hex(
    new TextEncoder().encode(JSON.stringify(composition.packageValues)),
  );

  for (const layer of loaded) {
    validateLayerBinding(
      layer,
      options.arch,
      options.kernelAbi,
      actualBase,
      compositionBytes.byteLength,
      compositionSha,
      composition,
    );
  }
  validatePackageOwnership(loaded);
  const pendingBaseUsage = options.fs.pendingDeferredTreeUsage();
  const selectedUsage = selectedDeferredTreeUsage(loaded);
  validateAggregateLayerCounts(pendingBaseUsage, selectedUsage, loaded);
  options.fs.assertCanAppendDeferredTreeUsage(selectedUsage);
  const planned = preflightDeferredTreeCollections(
    options.fs,
    loaded.map((layer) => ({
      id: layer.reference.id,
      schema: layer.descriptor.schema,
      mountPrefix: layer.descriptor.mount_prefix,
      trees: layer.descriptor.deferred_trees,
    })),
  );
  createDeferredTreeDirectories(options.fs, planned);

  const registered = planned.map((collection, index) => {
    const layer = loaded[index]!;
    const deferredTrees = collection.trees.map((tree) =>
      registerPlannedDeferredTree(options.fs, tree, collection.mountPrefix)
    );
    return {
      id: layer.reference.id,
      descriptor: layer.descriptor,
      deferredTrees,
    };
  });
  await options.fs.prepareBootDeferredTrees();
  return registered;
}

function validateAggregateLayerCounts(
  pendingBaseUsage: VfsDeferredTreeUsage,
  selectedUsage: VfsDeferredTreeUsage,
  loaded: readonly LoadedLayer[],
): void {
  const selectedPackages = loaded.reduce(
    (count, layer) => count + layer.descriptor.packages.layer.length,
    0,
  );
  if (selectedPackages > HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages) {
    throw new Error(
      `Selected Homebrew runtime layers contain ${selectedPackages} layer-owned ` +
        `packages; maximum is ${HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages}`,
    );
  }

  const pendingBaseTrees = pendingBaseUsage.groups;
  const selectedTrees = selectedUsage.groups;
  const aggregateTrees = pendingBaseTrees + selectedTrees;
  if (aggregateTrees > HOMEBREW_RUNTIME_LAYER_LIMITS.maxTrees) {
    throw new Error(
      `Homebrew runtime composition would contain ${aggregateTrees} deferred ` +
        `trees (${pendingBaseTrees} pending in the base and ${selectedTrees} selected); ` +
        `maximum is ${HOMEBREW_RUNTIME_LAYER_LIMITS.maxTrees}`,
    );
  }
}

function selectedDeferredTreeUsage(
  loaded: readonly LoadedLayer[],
): VfsDeferredTreeUsage {
  return deferredTreeUsage(
    loaded.flatMap((layer) => layer.descriptor.deferred_trees),
  );
}

function deferredTreeUsage(
  trees: readonly HomebrewDeferredTreeDescriptor[],
): VfsDeferredTreeUsage {
  const usage: VfsDeferredTreeUsage = {
    groups: 0,
    archiveBytes: 0,
    expandedBytes: 0,
    payloadBytes: 0,
    entries: 0,
  };
  for (const tree of trees) {
    usage.groups += 1;
    usage.archiveBytes += tree.content.bytes;
    usage.expandedBytes += tree.inventory.expanded_bytes;
    usage.payloadBytes += tree.inventory.payload_bytes;
    usage.entries += tree.inventory.entries.length +
      (tree.inventory.source?.entries.length ?? 0);
  }
  return usage;
}

/** Parse a closed legacy schema-4 or original-bottle schema-5 descriptor. */
export function parseHomebrewRuntimeLayerDescriptor(
  value: unknown,
): HomebrewLazyLayerDescriptor {
  const root = exactRecord(value, [
    "schema",
    "kind",
    "arch",
    "mount_prefix",
    "tap",
    "tap_lock",
    "kandelo",
    "bottle_release_tag",
    "selection",
    "packages",
    "base_vfs",
    "bundle",
    "release",
    "acceptance_vfs",
    "acceptance_evidence",
    "deferred_trees",
  ], "Homebrew runtime layer descriptor");
  if (
    (root.schema !== 4 && root.schema !== 5) ||
    root.kind !== "kandelo-homebrew-deferred-layer"
  ) {
    throw new Error("Homebrew runtime layer descriptor has an unsupported identity");
  }
  const arch = requireArch(root.arch, "Homebrew runtime layer architecture");
  if (root.mount_prefix !== "/") {
    throw new Error("Homebrew runtime layer mount prefix must be /");
  }

  const tap = exactRecord(
    root.tap,
    ["repository", "name", "commit"],
    "Homebrew runtime layer tap",
  );
  const tapRepository = requireRepository(
    tap.repository,
    "Homebrew runtime layer tap repository",
  );
  const tapName = requireRepository(tap.name, "Homebrew runtime layer tap name");
  const tapCommit = requireGitSha(tap.commit, "Homebrew runtime layer tap commit");

  const kandelo = exactRecord(
    root.kandelo,
    ["repository", "commit", "abi"],
    "Homebrew runtime layer Kandelo source",
  );
  const kandeloRepository = requireRepository(
    kandelo.repository,
    "Homebrew runtime layer Kandelo repository",
  );
  const kandeloCommit = requireGitSha(
    kandelo.commit,
    "Homebrew runtime layer Kandelo commit",
  );
  const kandeloAbi = requireInteger(
    kandelo.abi,
    "Homebrew runtime layer Kandelo ABI",
    1,
  );
  const bottleReleaseTag = requireReleaseTag(
    root.bottle_release_tag,
    "Homebrew runtime layer bottle release tag",
  );

  const tapLock = requireArray(
    root.tap_lock,
    "Homebrew runtime layer tap lock",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxTapLocks,
  );
  const tapNames: string[] = [];
  const taps = new Map<string, Record<string, unknown>>();
  const tapRepositories = new Set<string>();
  for (const [index, value] of tapLock.entries()) {
    const locked = exactRecord(value, [
      "repository",
      "name",
      "commit",
      "kandelo_repository",
      "kandelo_commit",
      "kandelo_abi",
      "bottle_release_tag",
    ], `Homebrew runtime layer tap lock ${index}`);
    const repository = requireRepository(
      locked.repository,
      `Homebrew runtime layer tap lock ${index} repository`,
    );
    const name = requireRepository(
      locked.name,
      `Homebrew runtime layer tap lock ${index} name`,
    );
    requireGitSha(locked.commit, `Homebrew runtime layer tap lock ${index} commit`);
    requireRepository(
      locked.kandelo_repository,
      `Homebrew runtime layer tap lock ${index} Kandelo repository`,
    );
    requireGitSha(
      locked.kandelo_commit,
      `Homebrew runtime layer tap lock ${index} Kandelo commit`,
    );
    if (locked.kandelo_abi !== kandeloAbi) {
      throw new Error(`Homebrew runtime layer tap lock ${index} ABI differs from Kandelo`);
    }
    requireReleaseTag(
      locked.bottle_release_tag,
      `Homebrew runtime layer tap lock ${index} release tag`,
    );
    const repositoryKey = repository.toLowerCase();
    if (taps.has(name) || tapRepositories.has(repositoryKey)) {
      throw new Error("Homebrew runtime layer tap lock has a duplicate identity");
    }
    taps.set(name, locked);
    tapRepositories.add(repositoryKey);
    tapNames.push(name);
  }
  if (!arraysEqual(tapNames, [...tapNames].sort(compareHomebrewCanonicalText))) {
    throw new Error("Homebrew runtime layer tap lock is not in canonical order");
  }
  const rootTap = taps.get(tapName);
  if (
    rootTap === undefined ||
    rootTap.repository !== tapRepository ||
    rootTap.commit !== tapCommit ||
    rootTap.kandelo_repository !== kandeloRepository ||
    rootTap.kandelo_commit !== kandeloCommit ||
    rootTap.bottle_release_tag !== bottleReleaseTag
  ) {
    throw new Error("Homebrew runtime layer root tap lock does not match its source");
  }

  const selection = exactRecord(root.selection, [
    "requested_packages",
    "package_order",
    "base_package_order",
    "layer_package_order",
  ], "Homebrew runtime layer selection");
  const requestedPackages = requirePackageNameArray(
    selection.requested_packages,
    "Homebrew runtime layer requested packages",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxRequestedPackages,
  );
  const packageOrder = requireFullPackageArray(
    selection.package_order,
    "Homebrew runtime layer package order",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages,
  );
  const baseOrder = requireFullPackageArray(
    selection.base_package_order,
    "Homebrew runtime layer base package order",
    0,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages,
  );
  const layerOrder = requireFullPackageArray(
    selection.layer_package_order,
    "Homebrew runtime layer layer package order",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages,
  );
  const baseSet = new Set(baseOrder);
  const layerSet = new Set(layerOrder);
  if (
    baseOrder.some((name) => layerSet.has(name)) ||
    packageOrder.length !== baseOrder.length + layerOrder.length ||
    packageOrder.some((name) => !baseSet.has(name) && !layerSet.has(name)) ||
    !arraysEqual(baseOrder, packageOrder.filter((name) => baseSet.has(name))) ||
    !arraysEqual(layerOrder, packageOrder.filter((name) => layerSet.has(name)))
  ) {
    throw new Error("Homebrew runtime layer package ownership is inconsistent");
  }

  const packages = exactRecord(
    root.packages,
    ["base", "layer"],
    "Homebrew runtime layer packages",
  );
  const basePackages = requireArray(
    packages.base,
    "Homebrew runtime layer base packages",
    0,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages,
  ).map((item, index) => validatePackageRecord(
    item,
    `Homebrew runtime layer base package ${index}`,
    arch,
    taps,
  ));
  const layerPackages = requireArray(
    packages.layer,
    "Homebrew runtime layer layer packages",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages,
  ).map((item, index) => validatePackageRecord(
    item,
    `Homebrew runtime layer package ${index}`,
    arch,
    taps,
  ));
  if (
    !arraysEqual(basePackages.map((pkg) => pkg.full_name), baseOrder) ||
    !arraysEqual(layerPackages.map((pkg) => pkg.full_name), layerOrder) ||
    new Set([...baseOrder, ...layerOrder]).size !== packageOrder.length
  ) {
    throw new Error("Homebrew runtime layer package records differ from selection order");
  }

  const baseVfs = validateBaseVfs(root.base_vfs, arch, kandeloAbi, baseOrder);

  const bundle = exactRecord(
    root.bundle,
    ["schema", "kind", "algorithm", "descriptor_encoding", "sha256", "assets"],
    "Homebrew runtime layer bundle",
  );
  if (
    bundle.schema !== 1 ||
    bundle.kind !== "kandelo-homebrew-runtime-layer-bundle" ||
    bundle.algorithm !== "sha256-canonical-json-v1" ||
    bundle.descriptor_encoding !== "canonical-json-v1"
  ) {
    throw new Error("Homebrew runtime layer bundle identity is unsupported");
  }
  const bundleSha = requireSha256(
    bundle.sha256,
    "Homebrew runtime layer bundle digest",
  );
  const bundleAssets = exactRecord(bundle.assets, [
    "acceptance_vfs",
    "acceptance_descriptor",
    "acceptance_report",
    "acceptance_node_evidence",
    "acceptance_browser_evidence",
    "deferred_trees",
  ], "Homebrew runtime layer bundle assets");
  const bundleAcceptance = validateAssetIdentity(
    bundleAssets.acceptance_vfs,
    "Homebrew runtime layer bundled acceptance VFS",
    ACCEPTANCE_ASSET,
    2 * 1024 * 1024 * 1024,
  );
  const bundleDescriptor = validateAssetIdentity(
    bundleAssets.acceptance_descriptor,
    "Homebrew runtime layer bundled acceptance descriptor",
    ACCEPTANCE_DESCRIPTOR_ASSET,
  );
  const bundleReport = validateAssetIdentity(
    bundleAssets.acceptance_report,
    "Homebrew runtime layer bundled acceptance report",
    ACCEPTANCE_REPORT_ASSET,
  );
  const bundleNode = validateAssetIdentity(
    bundleAssets.acceptance_node_evidence,
    "Homebrew runtime layer bundled Node evidence",
    ACCEPTANCE_NODE_ASSET,
  );
  const bundleBrowser = validateAssetIdentity(
    bundleAssets.acceptance_browser_evidence,
    "Homebrew runtime layer bundled browser evidence",
    ACCEPTANCE_BROWSER_ASSET,
  );
  const bundledTrees = requireArray(
    bundleAssets.deferred_trees,
    "Homebrew runtime layer bundled deferred trees",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxTrees,
  ).map((value, index) => {
    const item = exactRecord(
      value,
      ["id", "asset", "sha256", "bytes"],
      `Homebrew runtime layer bundled deferred tree ${index}`,
    );
    return {
      id: requireRuntimeLayerId(
        item.id,
        `Homebrew runtime layer bundled deferred tree ${index} id`,
      ),
      ...validateAssetIdentity(
        { asset: item.asset, sha256: item.sha256, bytes: item.bytes },
        `Homebrew runtime layer bundled deferred tree ${index}`,
        undefined,
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxArchiveBytes,
      ),
    };
  });
  if (
    new Set(bundledTrees.map((tree) => tree.id)).size !== bundledTrees.length ||
    !arraysEqual(
      bundledTrees.map((tree) => tree.id),
      [...bundledTrees.map((tree) => tree.id)].sort(compareHomebrewCanonicalText),
    )
  ) {
    throw new Error("Homebrew runtime layer bundled deferred trees are not canonical");
  }

  const release = exactRecord(
    root.release,
    ["repository", "tag"],
    "Homebrew runtime layer release",
  );
  const releaseRepository = requireRepository(
    release.repository,
    "Homebrew runtime layer release repository",
  );
  const releaseTag = requireReleaseTag(
    release.tag,
    "Homebrew runtime layer release tag",
  );
  if (releaseRepository !== tapRepository) {
    throw new Error("Homebrew runtime layer release repository differs from its tap");
  }
  if (releaseTag !== `${RUNTIME_LAYER_TAG_PREFIX}${bundleSha}`) {
    throw new Error("Homebrew runtime layer release tag differs from its bundle identity");
  }
  const releaseRoot =
    `https://github.com/${releaseRepository}/releases/download/${releaseTag}`;

  const acceptance = exactRecord(root.acceptance_vfs, [
    "asset",
    "url",
    "sha256",
    "bytes",
  ], "Homebrew runtime layer acceptance VFS");
  if (acceptance.asset !== ACCEPTANCE_ASSET) {
    throw new Error("Homebrew runtime layer acceptance VFS asset is unsupported");
  }
  const acceptanceSha = requireSha256(
    acceptance.sha256,
    "Homebrew runtime layer acceptance VFS digest",
  );
  requireInteger(
    acceptance.bytes,
    "Homebrew runtime layer acceptance VFS bytes",
    1,
    2 * 1024 * 1024 * 1024,
  );
  const acceptanceRoot =
    `https://github.com/${tapRepository}/releases/download/` +
    `homebrew-vfs-sha256-${acceptanceSha}`;
  if (
    requireHttpsUrl(acceptance.url, "Homebrew runtime layer acceptance VFS URL") !==
      `${acceptanceRoot}/${ACCEPTANCE_ASSET}` ||
    !sameAssetIdentity(acceptance, bundleAcceptance)
  ) {
    throw new Error("Homebrew runtime layer acceptance VFS does not bind its independent release");
  }

  const acceptanceEvidence = exactRecord(root.acceptance_evidence, [
    "descriptor",
    "report",
    "node",
    "browser",
  ], "Homebrew runtime layer acceptance evidence");
  const evidencePairs = [
    ["descriptor", ACCEPTANCE_DESCRIPTOR_ASSET, bundleDescriptor],
    ["report", ACCEPTANCE_REPORT_ASSET, bundleReport],
    ["node", ACCEPTANCE_NODE_ASSET, bundleNode],
    ["browser", ACCEPTANCE_BROWSER_ASSET, bundleBrowser],
  ] as const;
  for (const [name, asset, bundled] of evidencePairs) {
    const evidence = validateReleaseAsset(
      acceptanceEvidence[name],
      `Homebrew runtime layer acceptance ${name}`,
      asset,
      acceptanceRoot,
    );
    if (!sameAssetIdentity(evidence, bundled)) {
      throw new Error(`Homebrew runtime layer acceptance ${name} differs from its bundle`);
    }
  }

  const deferredTrees = validateDeferredTrees(
    root.deferred_trees,
    releaseRoot,
    bundledTrees,
    root.schema,
  );
  const entries = deferredTrees.flatMap((tree) => tree.inventory.entries);
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("Homebrew runtime layer deferred trees duplicate a VFS path");
  }
  if (root.schema === 5) {
    validateCompleteDirectBottleDirectories(entries);
  }
  validateDirectBottleBindings(layerPackages, deferredTrees);
  validateLayerPackageEntries(layerPackages, entries);
  void requestedPackages;
  void baseVfs;
  return root as unknown as HomebrewLazyLayerDescriptor;
}

function validateCompleteDirectBottleDirectories(
  entries: readonly HomebrewLazyLayerEntry[],
): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const prefix = HOMEBREW_PREFIX.slice(1);
  const prefixDepth = prefix.split("/").length;
  for (const entry of entries) {
    const components = entry.path.split("/");
    for (let length = prefixDepth; length < components.length; length += 1) {
      const ancestorPath = components.slice(0, length).join("/");
      if (byPath.get(ancestorPath)?.type !== "directory") {
        throw new Error(
          `Homebrew runtime layer original-bottle inventory omits directory /${ancestorPath}`,
        );
      }
    }
  }
}

function validateDirectBottleBindings(
  packages: readonly HomebrewLazyLayerPackageRecord[],
  trees: readonly HomebrewDeferredTreeDescriptor[],
): void {
  const direct = trees.filter((tree) => tree.package !== undefined);
  if (direct.length === 0) return;
  if (direct.length !== trees.length || direct.length !== packages.length) {
    throw new Error(
      "Homebrew runtime layer original bottles differ from its deferred package set",
    );
  }
  const byPackage = new Map(packages.map((pkg) => [pkg.full_name, pkg]));
  const seen = new Set<string>();
  for (const tree of direct) {
    const fullName = tree.package!;
    if (seen.has(fullName)) {
      throw new Error(`Homebrew runtime layer duplicates bottle package ${fullName}`);
    }
    seen.add(fullName);
    const pkg = byPackage.get(fullName);
    if (
      pkg === undefined || tree.content.decoder !== "homebrew-bottle-tar-gzip-v1" ||
      tree.content.sha256 !== pkg.sha256 || tree.content.bytes !== pkg.bytes
    ) {
      throw new Error(`Homebrew runtime layer bottle tree differs from package ${fullName}`);
    }
    if (
      tree.activation.roots.length !== 1 ||
      tree.activation.roots[0] !== pkg.keg
    ) {
      throw new Error(`Homebrew runtime layer bottle ${fullName} activation differs from its keg`);
    }
    const kegPath = pkg.keg.slice(1);
    const optPath = `${pkg.prefix}/${pkg.opt_link.path}`.replace(/^\//, "");
    const keg = tree.inventory.entries.find((entry) => entry.path === kegPath);
    const opt = tree.inventory.entries.find((entry) => entry.path === optPath);
    if (
      keg?.type !== "directory" || keg.ownership !== "layer" ||
      opt?.type !== "symlink" || opt.ownership !== "layer" ||
      opt.target !== pkg.opt_link.target
    ) {
      throw new Error(`Homebrew runtime layer bottle ${fullName} does not own its keg and opt link`);
    }
    for (const entry of tree.inventory.entries) {
      if (entry.type === "directory") {
        const expectedOwnership =
          entry.path === kegPath || entry.path.startsWith(`${kegPath}/`)
            ? "layer"
            : "mergeable-directory";
        if (entry.ownership !== expectedOwnership) {
          throw new Error(
            `Homebrew runtime layer bottle ${fullName} directory /${entry.path} ` +
              `must have ${expectedOwnership} ownership`,
          );
        }
      }
      if (
        entry.materialization === "archive" &&
        entry.path !== kegPath && !entry.path.startsWith(`${kegPath}/`)
      ) {
        throw new Error(
          `Homebrew runtime layer bottle ${fullName} maps an archive member outside its keg`,
        );
      }
      if (entry.materialization === "archive" && entry.type === "symlink") {
        validateArchiveSymlinkTarget(entry.path, entry.target!, kegPath, fullName);
      }
    }
    const external = tree.transports.filter((transport) => transport.kind === "external-https");
    if (external.length > 1) {
      throw new Error(`Homebrew runtime layer bottle ${fullName} has multiple canonical transports`);
    }
  }
  if (seen.size !== byPackage.size) {
    throw new Error("Homebrew runtime layer bottle package binding is incomplete");
  }
}

function validateArchiveSymlinkTarget(
  guestPath: string,
  target: string,
  kegPath: string,
  packageName: string,
): void {
  if (
    target.length === 0 ||
    target.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
  ) {
    throw new Error(
      `Homebrew runtime layer bottle ${packageName} archive symlink ${guestPath} ` +
        "target must be relative",
    );
  }
  const components = guestPath.split("/").slice(0, -1);
  for (const component of target.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (components.length === 0) {
        throw new Error(
          `Homebrew runtime layer bottle ${packageName} archive symlink ${guestPath} ` +
            "escapes its keg",
        );
      }
      components.pop();
    } else {
      components.push(component);
    }
  }
  const resolved = components.join("/");
  if (resolved !== kegPath && !resolved.startsWith(`${kegPath}/`)) {
    throw new Error(
      `Homebrew runtime layer bottle ${packageName} archive symlink ${guestPath} ` +
        "escapes its keg",
    );
  }
}

function validateReferences(references: readonly HomebrewRuntimeLayerReference[]): void {
  const ids = new Set<string>();
  const urls = new Set<string>();
  const digests = new Set<string>();
  let totalDescriptorBytes = 0;
  for (const [index, reference] of references.entries()) {
    const value = exactRecord(
      reference,
      ["id", "descriptor"],
      `Homebrew runtime layer reference ${index}`,
    );
    const id = requireRuntimeLayerId(
      value.id,
      `Homebrew runtime layer reference ${index} id`,
    );
    const descriptor = exactRecord(
      value.descriptor,
      ["url", "sha256", "bytes"],
      `Homebrew runtime layer reference ${index} descriptor`,
    );
    const url = requireHttpsUrl(
      descriptor.url,
      `Homebrew runtime layer reference ${index} URL`,
    );
    const digest = requireSha256(
      descriptor.sha256,
      `Homebrew runtime layer reference ${index} digest`,
    );
    const descriptorBytes = requireInteger(
      descriptor.bytes,
      `Homebrew runtime layer reference ${index} bytes`,
      1,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxDescriptorBytes,
    );
    totalDescriptorBytes += descriptorBytes;
    if (totalDescriptorBytes > HOMEBREW_RUNTIME_LAYER_LIMITS.maxDescriptorBytes) {
      throw new Error(
        `Selected Homebrew runtime layer descriptors exceed ` +
          `${HOMEBREW_RUNTIME_LAYER_LIMITS.maxDescriptorBytes} bytes`,
      );
    }
    if (ids.has(id) || urls.has(url) || digests.has(digest)) {
      throw new Error(`Homebrew runtime layer reference ${index} is duplicated`);
    }
    ids.add(id);
    urls.add(url);
    digests.add(digest);
  }
}

async function fetchExactBytes(
  identity: { url: string; sha256: string; bytes: number },
  fetcher: (url: string) => Promise<Response>,
): Promise<Uint8Array> {
  const response = await fetcher(identity.url);
  if (!response.ok) {
    throw new Error(`Homebrew runtime layer descriptor fetch failed: HTTP ${response.status}`);
  }
  const contentEncoding = response.headers?.get("content-encoding")
    ?.trim().toLowerCase();
  const contentLength = contentEncoding && contentEncoding !== "identity"
    ? null
    : response.headers?.get("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed !== identity.bytes) {
      throw new Error(
        `Homebrew runtime layer descriptor Content-Length ${contentLength} ` +
          `does not match expected ${identity.bytes}`,
      );
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > identity.bytes) {
          await reader.cancel();
          throw new Error(
            `Homebrew runtime layer descriptor exceeds expected ${identity.bytes} bytes`,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    if (contentLength === null || contentLength === undefined) {
      throw new Error(
        "Homebrew runtime layer descriptor response has neither a stream nor Content-Length",
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    total = bytes.byteLength;
    chunks.push(bytes);
  }
  if (total !== identity.bytes) {
    throw new Error(
      `Homebrew runtime layer descriptor byte count ${total} does not match ` +
        `expected ${identity.bytes}`,
    );
  }
  const bytes = concatBytes(chunks, total);
  const actual = await sha256Hex(bytes);
  if (actual !== identity.sha256) {
    throw new Error(
      `Homebrew runtime layer descriptor SHA-256 ${actual} does not match ` +
        `expected ${identity.sha256}`,
    );
  }
  return bytes;
}

function validateLayerBinding(
  layer: LoadedLayer,
  expectedArch: "wasm32" | "wasm64",
  expectedAbi: number,
  actualBase: { sha256: string; bytes: number },
  compositionBytes: number,
  compositionSha: string,
  composition: ParsedBaseComposition,
): void {
  const { reference, descriptor } = layer;
  const descriptorAsset = `kandelo-homebrew-${reference.id}-layer.json`;
  const descriptorRoot =
    `https://github.com/${descriptor.release.repository}/releases/download/` +
    descriptor.release.tag;
  if (reference.descriptor.url !== `${descriptorRoot}/${descriptorAsset}`) {
    throw new Error(
      `Homebrew runtime layer ${reference.id} descriptor URL differs from its bundle release`,
    );
  }
  if (descriptor.arch !== expectedArch) {
    throw new Error(
      `Homebrew runtime layer ${reference.id} architecture ${descriptor.arch} ` +
        `does not match ${expectedArch}`,
    );
  }
  if (
    descriptor.kandelo.abi !== expectedAbi ||
    descriptor.base_vfs.kernel_abi !== expectedAbi ||
    descriptor.base_vfs.package_source.index.abi !== expectedAbi
  ) {
    throw new Error(`Homebrew runtime layer ${reference.id} ABI does not match the kernel`);
  }
  if (
    descriptor.base_vfs.sha256 !== actualBase.sha256 ||
    descriptor.base_vfs.bytes !== actualBase.bytes ||
    descriptor.base_vfs.package_source.output.sha256 !== actualBase.sha256 ||
    descriptor.base_vfs.package_source.output.bytes !== actualBase.bytes
  ) {
    throw new Error(
      `Homebrew runtime layer ${reference.id} does not bind the loaded shell image`,
    );
  }
  const descriptorComposition = descriptor.base_vfs.composition;
  if (
    descriptorComposition.path !== COMPOSITION_PATH ||
    descriptorComposition.bytes !== compositionBytes ||
    descriptorComposition.sha256 !== compositionSha ||
    descriptorComposition.package_count !== composition.packageOrder.length ||
    !arraysEqual(descriptorComposition.package_order, composition.packageOrder) ||
    descriptorComposition.requested_packages_sha256 !==
      composition.requestedPackagesSha256 ||
    descriptorComposition.package_set_sha256 !== composition.packageSetSha256
  ) {
    throw new Error(
      `Homebrew runtime layer ${reference.id} does not bind the shell composition`,
    );
  }
  if (
    descriptor.selection.base_package_order.some(
      (name) => !composition.packageNames.has(name),
    )
  ) {
    throw new Error(
      `Homebrew runtime layer ${reference.id} reuses a package absent from the shell`,
    );
  }
  for (const pkg of descriptor.packages.base) {
    const basePackage = composition.packageRecords.get(pkg.full_name);
    if (
      basePackage === undefined ||
      JSON.stringify(packageArtifactIdentity(pkg, `layer base package ${pkg.full_name}`)) !==
        JSON.stringify(packageArtifactIdentity(
          basePackage,
          `shell composition package ${pkg.full_name}`,
        ))
    ) {
      throw new Error(
        `Homebrew runtime layer ${reference.id} base package ${pkg.full_name} ` +
          `differs from the shell composition`,
      );
    }
  }
  if (
    descriptor.selection.requested_packages.length !== 1 ||
    descriptor.selection.requested_packages[0] !== reference.id ||
    !descriptor.packages.layer.some((pkg) =>
      pkg.name === reference.id && pkg.full_name.endsWith(`/${reference.id}`)
    )
  ) {
    throw new Error(
      `Homebrew runtime layer ${reference.id} descriptor names a different runtime root`,
    );
  }
  const rootPackage = descriptor.packages.layer.find((pkg) =>
    pkg.name === reference.id && pkg.full_name.endsWith(`/${reference.id}`)
  );
  const directTrees = descriptor.deferred_trees.filter((tree) => tree.package !== undefined);
  if (
    directTrees.length > 0 &&
    !directTrees.some((tree) =>
      tree.id === reference.id && tree.package === rootPackage?.full_name
    )
  ) {
    throw new Error(
      `Homebrew runtime layer ${reference.id} root tree differs from its selected package`,
    );
  }
}

function validatePackageOwnership(layers: readonly LoadedLayer[]): void {
  const owner = new Map<string, string>();
  const transportUrls = new Set<string>();
  const contentDigests = new Set<string>();
  for (const layer of layers) {
    for (const tree of layer.descriptor.deferred_trees) {
      if (contentDigests.has(tree.content.sha256)) {
        throw new Error(
          `Homebrew runtime layer ${layer.reference.id} reuses another deferred tree`,
        );
      }
      contentDigests.add(tree.content.sha256);
      for (const transport of tree.transports) {
        if (transportUrls.has(transport.url)) {
          throw new Error(
            `Homebrew runtime layer ${layer.reference.id} reuses another tree transport`,
          );
        }
        transportUrls.add(transport.url);
      }
    }
    for (const pkg of layer.descriptor.packages.layer) {
      const previous = owner.get(pkg.full_name);
      if (previous !== undefined) {
        throw new Error(
          `Homebrew runtime layers ${previous} and ${layer.reference.id} both own ` +
            `package ${pkg.full_name}`,
        );
      }
      owner.set(pkg.full_name, layer.reference.id);
    }
  }
}

function preflightDeferredTreeCollections(
  fs: MemoryFileSystem,
  collections: readonly HomebrewDeferredTreeCollectionPlan[],
): PlannedTreeCollection[] {
  const ownership = new Map<string, {
    id: string;
    type: HomebrewLazyLayerEntry["type"];
    ownership: HomebrewLazyLayerEntry["ownership"];
    mode: number;
  }>();
  const planned: PlannedTreeCollection[] = [];

  for (const collection of collections) {
    const directories: HomebrewLazyLayerEntry[] = [];
    const trees: PlannedTree[] = [];
    for (const tree of collection.trees) {
      const registrationEntries: LazyTreeRegistrationEntry[] = [];
      for (const entry of tree.inventory.entries) {
        const vfsPath = `/${entry.path}`;
        const base = lstatOrNull(fs, vfsPath);
        if (entry.ownership === "mergeable-directory") {
          if (
            collection.schema !== 5 ||
            base !== null && (base.mode & S_IFMT) !== S_IFDIR
          ) {
            throw new Error(
              `Homebrew runtime layer ${collection.id} cannot merge directory ${vfsPath}`,
            );
          }
          if (base !== null && (base.mode & 0o7777) !== entry.mode) {
            throw new Error(
              `Homebrew runtime layer ${collection.id} cannot merge directory ` +
                `${vfsPath}: base mode differs from the descriptor`,
            );
          }
        } else if (entry.ownership === "shared-base-directory") {
          if (base === null || (base.mode & S_IFMT) !== S_IFDIR) {
            throw new Error(
              `Homebrew runtime layer ${collection.id} does not share an ` +
                `existing base directory at ${vfsPath}`,
            );
          }
        } else if (base !== null) {
          throw new Error(
            `Homebrew runtime layer ${collection.id} collides with the base at ${vfsPath}`,
          );
        }

        const previous = ownership.get(entry.path);
        if (previous !== undefined) {
          const jointlySharedDirectory =
            previous.type === "directory" &&
            entry.type === "directory" &&
            previous.ownership === "shared-base-directory" &&
            entry.ownership === "shared-base-directory";
          const jointlyMergeableDirectory =
            previous.type === "directory" &&
            entry.type === "directory" &&
            previous.ownership === "mergeable-directory" &&
            entry.ownership === "mergeable-directory" &&
            previous.mode === entry.mode;
          if (!jointlySharedDirectory && !jointlyMergeableDirectory) {
            throw new Error(
              `Homebrew runtime layers ${previous.id} and ${collection.id} ` +
                `conflict at ${vfsPath}`,
            );
          }
        } else {
          ownership.set(entry.path, {
            id: collection.id,
            type: entry.type,
            ownership: entry.ownership,
            mode: entry.mode,
          });
        }

        if (
          entry.type === "directory" &&
          (
            entry.ownership === "layer" ||
            entry.ownership === "mergeable-directory" && base === null && previous === undefined
          )
        ) {
          directories.push(entry);
        }
        registrationEntries.push({
          vfsPath,
          sourcePath: entry.source_path,
          ...(entry.materialization === undefined
            ? {}
            : { materialization: entry.materialization }),
          type: entry.type,
          mode: entry.mode,
          size: entry.size,
          ...(entry.target === undefined
            ? {}
            : { target: entry.type === "hardlink" ? `/${entry.target}` : entry.target }),
          ...(entry.inode_group === undefined ? {} : { inodeGroup: entry.inode_group }),
        });
      }
      trees.push({ descriptor: tree, entries: registrationEntries });
    }
    directories.sort((left, right) =>
      pathDepth(left.path) - pathDepth(right.path) ||
        compareHomebrewCanonicalText(left.path, right.path)
    );
    planned.push({ ...collection, trees, directories });
  }

  for (const [path, entry] of ownership) {
    const components = path.split("/");
    for (let length = 1; length < components.length; length += 1) {
      const ancestorPath = components.slice(0, length).join("/");
      const ancestor = ownership.get(ancestorPath);
      if (ancestor !== undefined && ancestor.type !== "directory") {
        throw new Error(
          `Homebrew runtime layer path /${path} descends through ` +
            `non-directory /${ancestorPath}`,
        );
      }
      if (
        ancestor !== undefined &&
        ancestor.ownership === "layer" &&
        ancestor.id !== entry.id
      ) {
        throw new Error(
          `Homebrew runtime layer ${entry.id} path /${path} descends through ` +
            `${ancestor.id}-owned directory /${ancestorPath}`,
        );
      }
      if (ancestor === undefined) {
        const baseAncestor = lstatOrNull(fs, `/${ancestorPath}`);
        if (baseAncestor === null || (baseAncestor.mode & S_IFMT) !== S_IFDIR) {
          throw new Error(
            `Homebrew runtime layer path /${path} has missing or non-directory ` +
              `ancestor /${ancestorPath}`,
          );
        }
      }
    }
  }
  return planned;
}

function createDeferredTreeDirectories(
  fs: MemoryFileSystem,
  collections: readonly PlannedTreeCollection[],
): void {
  for (const collection of collections) {
    for (const directory of collection.directories) {
      const path = `/${directory.path}`;
      const existing = lstatOrNull(fs, path);
      if (existing === null) {
        fs.mkdir(path, directory.mode);
        fs.chmod(path, directory.mode);
      } else if ((existing.mode & S_IFMT) !== S_IFDIR) {
        throw new Error(`Homebrew runtime layer directory collides at ${path}`);
      }
    }
  }
}

function registerPlannedDeferredTree(
  fs: MemoryFileSystem,
  tree: PlannedTree,
  mountPrefix: string,
): LazyTreeGroup {
  return fs.registerLazyTree(
    plannedDeferredTreeContent(tree),
    tree.entries,
    mountPrefix,
    plannedDeferredTreeActivation(tree),
  );
}

function registerPlannedDeferredTreeWithHandle(
  fs: MemoryFileSystem,
  tree: PlannedTree,
  mountPrefix: string,
): DeferredTreeMaterializationHandle {
  return fs.registerLazyTreeWithMaterializationHandle(
    plannedDeferredTreeContent(tree),
    tree.entries,
    mountPrefix,
    plannedDeferredTreeActivation(tree),
  );
}

function plannedDeferredTreeContent(tree: PlannedTree) {
  return {
    decoder: tree.descriptor.content.decoder,
    mediaType: tree.descriptor.content.media_type,
    sha256: tree.descriptor.content.sha256,
    bytes: tree.descriptor.content.bytes,
    expandedBytes: tree.descriptor.inventory.expanded_bytes,
    sourceEntryCount: tree.descriptor.inventory.source_entry_count,
    transports: tree.descriptor.transports.map((transport) => transport.url),
    ...(tree.descriptor.inventory.source === undefined ? {} : {
      source: {
        schema: 1 as const,
        kind: "homebrew-bottle-tar-gzip-v1" as const,
        entries: tree.descriptor.inventory.source.entries.map((entry) => ({
          sourcePath: entry.path,
          type: entry.type,
          mode: entry.mode,
          size: entry.size,
          ...(entry.target === undefined ? {} : { target: entry.target }),
        })),
      },
    }),
  };
}

function plannedDeferredTreeActivation(tree: PlannedTree) {
  return {
    mode: tree.descriptor.activation.mode,
    capabilities: [...tree.descriptor.activation.capabilities],
    roots: [...tree.descriptor.activation.roots],
  };
}

function validateBaseVfs(
  value: unknown,
  arch: "wasm32" | "wasm64",
  abi: number,
  baseOrder: readonly string[],
): Record<string, unknown> {
  const base = exactRecord(value, [
    "sha256",
    "bytes",
    "kernel_abi",
    "package_source",
    "composition",
  ], "Homebrew runtime layer base VFS");
  const baseSha = requireSha256(base.sha256, "Homebrew runtime layer base VFS digest");
  const baseBytes = requireInteger(
    base.bytes,
    "Homebrew runtime layer base VFS bytes",
    1,
    2 * 1024 * 1024 * 1024,
  );
  if (base.kernel_abi !== abi) {
    throw new Error("Homebrew runtime layer base VFS ABI differs from Kandelo");
  }
  const source = exactRecord(base.package_source, [
    "schema",
    "kind",
    "index",
    "package",
    "archive",
    "output",
  ], "Homebrew runtime layer base package source");
  if (source.schema !== 1 || source.kind !== "kandelo-package-output") {
    throw new Error("Homebrew runtime layer base package source identity is unsupported");
  }
  const index = exactRecord(
    source.index,
    ["url", "sha256", "bytes", "abi"],
    "Homebrew runtime layer base package index",
  );
  requireHttpsUrl(index.url, "Homebrew runtime layer base package index URL");
  requireSha256(index.sha256, "Homebrew runtime layer base package index digest");
  requireInteger(index.bytes, "Homebrew runtime layer base package index bytes", 1);
  if (index.abi !== abi) {
    throw new Error("Homebrew runtime layer base package index ABI differs from Kandelo");
  }
  const pkg = exactRecord(
    source.package,
    ["name", "version", "revision", "arch", "cache_key_sha"],
    "Homebrew runtime layer base package",
  );
  if (pkg.name !== "shell" || pkg.arch !== arch) {
    throw new Error("Homebrew runtime layer base package is not the canonical shell");
  }
  requireString(pkg.version, "Homebrew runtime layer base package version", 256);
  requireInteger(pkg.revision, "Homebrew runtime layer base package revision", 1);
  requireSha256(pkg.cache_key_sha, "Homebrew runtime layer base package cache key");
  const archive = exactRecord(
    source.archive,
    ["format", "url", "sha256", "bytes"],
    "Homebrew runtime layer base package archive",
  );
  if (archive.format !== "kandelo-package-tar-zstd-v2") {
    throw new Error("Homebrew runtime layer base package archive format is unsupported");
  }
  requireHttpsUrl(archive.url, "Homebrew runtime layer base package archive URL");
  requireSha256(archive.sha256, "Homebrew runtime layer base package archive digest");
  requireInteger(archive.bytes, "Homebrew runtime layer base package archive bytes", 1);
  const output = exactRecord(
    source.output,
    ["name", "path", "sha256", "bytes"],
    "Homebrew runtime layer base package output",
  );
  if (
    output.name !== "shell" ||
    output.path !== "shell.vfs.zst" ||
    output.sha256 !== baseSha ||
    output.bytes !== baseBytes
  ) {
    throw new Error("Homebrew runtime layer base package output differs from its VFS");
  }

  const composition = exactRecord(base.composition, [
    "path",
    "sha256",
    "bytes",
    "requested_packages_sha256",
    "package_set_sha256",
    "package_count",
    "package_order",
  ], "Homebrew runtime layer base composition");
  if (composition.path !== COMPOSITION_PATH) {
    throw new Error("Homebrew runtime layer base composition path is unsupported");
  }
  requireSha256(composition.sha256, "Homebrew runtime layer base composition digest");
  requireInteger(
    composition.bytes,
    "Homebrew runtime layer base composition bytes",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxDescriptorBytes,
  );
  requireSha256(
    composition.requested_packages_sha256,
    "Homebrew runtime layer base requested package digest",
  );
  requireSha256(
    composition.package_set_sha256,
    "Homebrew runtime layer base package set digest",
  );
  const order = requireFullPackageArray(
    composition.package_order,
    "Homebrew runtime layer base composition order",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages,
  );
  if (
    composition.package_count !== order.length ||
    baseOrder.some((name) => !order.includes(name))
  ) {
    throw new Error("Homebrew runtime layer base composition package order is inconsistent");
  }
  return base;
}

function validatePackageRecord(
  value: unknown,
  label: string,
  arch: "wasm32" | "wasm64",
  taps: ReadonlyMap<string, Record<string, unknown>>,
): HomebrewLazyLayerPackageRecord {
  const record = recordWithOptional(value, [
    "name",
    "full_name",
    "tap_repository",
    "tap_name",
    "tap_commit",
    "version",
    "formula_revision",
    "bottle_rebuild",
    "arch",
    "source_status",
    "metadata_status",
    "url",
    "sha256",
    "bytes",
    "cache_key_sha",
    "link_manifest",
    "prefix",
    "keg",
    "opt_link",
  ], ["built_from"], label);
  const name = requirePackageName(record.name, `${label} name`);
  const tapName = requireRepository(record.tap_name, `${label} tap name`);
  const tapRepository = requireRepository(
    record.tap_repository,
    `${label} tap repository`,
  );
  if (record.full_name !== `${tapName}/${name}`) {
    throw new Error(`${label} full name differs from its tap and package name`);
  }
  const tapCommit = requireGitSha(record.tap_commit, `${label} tap commit`);
  requireString(record.version, `${label} version`, 256);
  requireInteger(record.formula_revision, `${label} Formula revision`, 0);
  requireInteger(record.bottle_rebuild, `${label} bottle rebuild`, 0);
  if (record.arch !== arch) throw new Error(`${label} architecture differs from its layer`);
  if (record.source_status !== "success" && record.source_status !== "fallback") {
    throw new Error(`${label} source status is invalid`);
  }
  requireString(record.metadata_status, `${label} metadata status`, 256);
  requireHttpsUrl(record.url, `${label} URL`);
  requireSha256(record.sha256, `${label} digest`);
  requireInteger(record.bytes, `${label} bytes`, 1, 2 * 1024 * 1024 * 1024);
  requireSha256(record.cache_key_sha, `${label} cache key`);
  requireSafeRelativePath(record.link_manifest, `${label} link manifest`);
  if (record.prefix !== HOMEBREW_PREFIX) {
    throw new Error(`${label} prefix is unsupported`);
  }
  const keg = requireCanonicalAbsolutePath(record.keg, `${label} keg`, 4096);
  const kegRoot = `${HOMEBREW_PREFIX}/Cellar/${name}/`;
  if (!keg.startsWith(kegRoot) || keg.slice(kegRoot.length).includes("/")) {
    throw new Error(`${label} keg escapes its package Cellar path`);
  }
  const opt = exactRecord(record.opt_link, ["path", "target"], `${label} opt link`);
  if (
    opt.path !== `opt/${name}` ||
    opt.target !== `../${keg.slice(HOMEBREW_PREFIX.length + 1)}`
  ) {
    throw new Error(`${label} opt link is inconsistent`);
  }
  const locked = taps.get(tapName);
  if (locked === undefined || locked.repository !== tapRepository) {
    throw new Error(`${label} is absent from its tap lock`);
  }
  if (record.built_from === undefined) {
    if (locked.commit !== tapCommit) {
      throw new Error(`${label} tap commit differs from its lock`);
    }
  } else {
    const built = exactRecord(record.built_from, [
      "tap_repository",
      "tap_commit",
      "kandelo_repository",
      "kandelo_commit",
      "formula_sha256",
    ], `${label} built_from`);
    if (
      requireRepository(built.tap_repository, `${label} built_from tap repository`) !==
        tapRepository ||
      requireGitSha(built.tap_commit, `${label} built_from tap commit`) !== tapCommit
    ) {
      throw new Error(`${label} bottle build provenance differs from its package`);
    }
    const kandeloRepository = requireRepository(
      built.kandelo_repository,
      `${label} built_from Kandelo repository`,
    );
    if (
      kandeloRepository.toLowerCase() !==
        String(locked.kandelo_repository).toLowerCase()
    ) {
      throw new Error(`${label} bottle build provenance differs from its tap lock`);
    }
    requireGitSha(built.kandelo_commit, `${label} built_from Kandelo commit`);
    requireSha256(built.formula_sha256, `${label} built_from Formula digest`);
  }
  return record as unknown as HomebrewLazyLayerPackageRecord;
}

function validateDeferredTrees(
  value: unknown,
  releaseRoot: string,
  bundledTrees: ReadonlyArray<{
    id: string;
    asset: string;
    sha256: string;
    bytes: number;
  }>,
  descriptorSchema: 4 | 5,
): HomebrewDeferredTreeDescriptor[] {
  const values = requireArray(
    value,
    "Homebrew runtime layer deferred trees",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxTrees,
  );
  const ids = new Set<string>();
  const digests = new Set<string>();
  const urls = new Set<string>();
  const trees = values.map((item, index) => {
    const directBottle = descriptorSchema === 5;
    const tree = exactRecord(
      item,
      [
        "id",
        ...(directBottle ? ["package"] : []),
        "activation",
        "content",
        "transports",
        "inventory",
      ],
      `Homebrew runtime layer deferred tree ${index}`,
    );
    const id = requireRuntimeLayerId(
      tree.id,
      `Homebrew runtime layer deferred tree ${index} id`,
    );
    if (ids.has(id)) throw new Error(`Homebrew runtime layer duplicates tree ${id}`);
    ids.add(id);
    const packageName = directBottle
      ? requireFullPackageName(
        tree.package,
        `Homebrew runtime layer deferred tree ${id} package`,
      )
      : undefined;

    const activation = exactRecord(
      tree.activation,
      ["mode", "capabilities", "roots"],
      `Homebrew runtime layer deferred tree ${id} activation`,
    );
    if (activation.mode !== "boot-prefetch" && activation.mode !== "first-use") {
      throw new Error(`Homebrew runtime layer deferred tree ${id} activation is invalid`);
    }
    const capabilities = requireArray(
      activation.capabilities,
      `Homebrew runtime layer deferred tree ${id} capabilities`,
      1,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationCapabilities,
    ).map((capability, capabilityIndex) => {
      const text = requireString(
        capability,
        `Homebrew runtime layer deferred tree ${id} capability ${capabilityIndex}`,
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationCapabilityBytes,
      );
      if (!/^[a-z0-9][a-z0-9:._-]*$/.test(text)) {
        throw new Error(`Homebrew runtime layer deferred tree ${id} capability is invalid`);
      }
      return text;
    });
    if (
      new Set(capabilities).size !== capabilities.length ||
      !arraysEqual(capabilities, [...capabilities].sort(compareHomebrewCanonicalText))
    ) {
      throw new Error(`Homebrew runtime layer deferred tree ${id} capabilities are not canonical`);
    }
    const roots = requireArray(
      activation.roots,
      `Homebrew runtime layer deferred tree ${id} roots`,
      1,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationRoots,
    ).map((root, rootIndex) =>
      requireCanonicalAbsolutePath(
        root,
        `Homebrew runtime layer deferred tree ${id} root ${rootIndex}`,
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes,
      )
    );
    if (
      new Set(roots).size !== roots.length ||
      !arraysEqual(roots, [...roots].sort(compareHomebrewCanonicalText))
    ) {
      throw new Error(`Homebrew runtime layer deferred tree ${id} roots are not canonical`);
    }

    const content = exactRecord(
      tree.content,
      ["media_type", "decoder", "sha256", "bytes"],
      `Homebrew runtime layer deferred tree ${id} content`,
    );
    const validDecoder = descriptorSchema === 4
      ? content.decoder === "zip-v1" && content.media_type === "application/zip"
      : content.decoder === "homebrew-bottle-tar-gzip-v1" &&
        content.media_type === "application/vnd.oci.image.layer.v1.tar+gzip";
    if (!validDecoder) {
      throw new Error(`Homebrew runtime layer deferred tree ${id} decoder is unsupported`);
    }
    const digest = requireSha256(
      content.sha256,
      `Homebrew runtime layer deferred tree ${id} digest`,
    );
    requireInteger(
      content.bytes,
      `Homebrew runtime layer deferred tree ${id} bytes`,
      1,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxArchiveBytes,
    );
    if (digests.has(digest)) {
      throw new Error(`Homebrew runtime layer deferred tree ${id} reuses content identity`);
    }
    digests.add(digest);

    const transports = requireArray(
      tree.transports,
      `Homebrew runtime layer deferred tree ${id} transports`,
      1,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxTransportsPerTree,
    );
    const bundled = bundledTrees[index];
    if (
      bundled === undefined ||
      bundled.id !== id ||
      bundled.sha256 !== digest ||
      bundled.bytes !== content.bytes
    ) {
      throw new Error(`Homebrew runtime layer deferred tree ${id} differs from its bundle`);
    }
    let releaseTransportCount = 0;
    for (const [transportIndex, transportValue] of transports.entries()) {
      const transportLabel =
        `Homebrew runtime layer deferred tree ${id} transport ${transportIndex}`;
      const transportRecord = requireRecord(transportValue, transportLabel);
      const kind = requireString(transportRecord.kind, `${transportLabel} kind`, 64);
      let url: string;
      if (kind === "bundle-release") {
        const transport = exactRecord(
          transportValue,
          ["kind", "asset", "url"],
          transportLabel,
        );
        const asset = requireAssetName(transport.asset, `${transportLabel} asset`);
        url = requireHttpsUrl(transport.url, `${transportLabel} URL`);
        if (asset !== bundled.asset || url !== `${releaseRoot}/${asset}`) {
          throw new Error(
            `Homebrew runtime layer deferred tree ${id} release transport differs from its bundle`,
          );
        }
        releaseTransportCount += 1;
      } else if (kind === "external-https") {
        const transport = exactRecord(
          transportValue,
          ["kind", "url"],
          transportLabel,
        );
        url = requireHttpsUrl(transport.url, `${transportLabel} URL`);
      } else {
        throw new Error(`${transportLabel} kind is unsupported`);
      }
      if (urls.has(url)) {
        throw new Error(`Homebrew runtime layer deferred tree ${id} reuses a transport`);
      }
      urls.add(url);
    }
    if (releaseTransportCount !== 1) {
      throw new Error(
        `Homebrew runtime layer deferred tree ${id} must have one bundle release transport`,
      );
    }

    const initialInventory = requireRecord(
      tree.inventory,
      `Homebrew runtime layer deferred tree ${id} inventory`,
    );
    const hasSource = initialInventory.source !== undefined;
    if (directBottle !== hasSource) {
      throw new Error(
        `Homebrew runtime layer schema ${descriptorSchema} tree ${id} has incompatible bottle metadata`,
      );
    }
    if (directBottle && content.decoder !== "homebrew-bottle-tar-gzip-v1") {
      throw new Error(`Homebrew runtime layer deferred tree ${id} bottle decoder is invalid`);
    }
    const inventory = exactRecord(
      tree.inventory,
      [
        "entry_count",
        "source_entry_count",
        "regular_inode_count",
        "layer_entry_count",
        ...(hasSource ? ["mergeable_directory_count"] : ["shared_base_directory_count"]),
        "expanded_bytes",
        "payload_bytes",
        ...(hasSource ? ["source"] : []),
        "entries",
      ],
      `Homebrew runtime layer deferred tree ${id} inventory`,
    );
    const source = hasSource
      ? validateSourceInventory(inventory.source, id)
      : undefined;
    const entries = validateEntries(
      inventory.entries,
      inventory,
      content.decoder,
      source,
    );
    for (const root of roots) {
      const relative = root.slice(1);
      if (!entries.some((entry) =>
        entry.path === relative || entry.path.startsWith(`${relative}/`)
      )) {
        throw new Error(`Homebrew runtime layer deferred tree ${id} root ${root} is unowned`);
      }
    }
    void packageName;
    return tree as unknown as HomebrewDeferredTreeDescriptor;
  });
  if (
    !arraysEqual(
      trees.map((tree) => tree.id),
      [...trees.map((tree) => tree.id)].sort(compareHomebrewCanonicalText),
    )
  ) {
    throw new Error("Homebrew runtime layer deferred trees are not in canonical order");
  }
  if (trees.length !== bundledTrees.length) {
    throw new Error("Homebrew runtime layer deferred trees differ from its bundle");
  }
  return trees;
}

function validateSourceInventory(
  value: unknown,
  treeId: string,
): {
  entries: HomebrewDeferredTreeSourceEntry[];
  canonicalByPath: Map<string, HomebrewDeferredTreeSourceEntry>;
} {
  const source = exactRecord(
    value,
    ["schema", "kind", "entries"],
    `Homebrew runtime layer deferred tree ${treeId} source inventory`,
  );
  if (source.schema !== 1 || source.kind !== "homebrew-bottle-tar-gzip-v1") {
    throw new Error(
      `Homebrew runtime layer deferred tree ${treeId} source inventory is unsupported`,
    );
  }
  const byPath = new Map<string, HomebrewDeferredTreeSourceEntry>();
  const entries = requireArray(
    source.entries,
    `Homebrew runtime layer deferred tree ${treeId} source entries`,
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxEntries,
  ).map((value, index) => {
    const initial = requireRecord(
      value,
      `Homebrew runtime layer deferred tree ${treeId} source entry ${index}`,
    );
    const type = initial.type;
    const keys = type === "directory" || type === "file"
      ? ["path", "type", "mode", "size"]
      : type === "symlink" || type === "hardlink"
        ? ["path", "type", "mode", "size", "target"]
        : null;
    if (keys === null) {
      throw new Error(
        `Homebrew runtime layer deferred tree ${treeId} source entry ${index} has invalid type`,
      );
    }
    const entry = exactRecord(value, keys, `Homebrew runtime layer source entry ${index}`);
    const path = requireSafeRelativePath(
      entry.path,
      `Homebrew runtime layer source entry ${index} path`,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes,
    );
    if (byPath.has(path)) throw new Error(`Homebrew runtime layer source duplicates ${path}`);
    const mode = requireInteger(
      entry.mode,
      `Homebrew runtime layer source ${path} mode`,
      0,
      0o7777,
    );
    if (type === "symlink" && mode !== 0o777) {
      throw new Error(
        `Homebrew runtime layer source ${path} symlink mode must be 0777`,
      );
    }
    const size = requireInteger(
      entry.size,
      `Homebrew runtime layer source ${path} size`,
      0,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxUncompressedBytes,
    );
    if (type !== "file" && size !== 0) {
      throw new Error(`Homebrew runtime layer source ${path} has nonzero link/directory size`);
    }
    let target: string | undefined;
    if (type === "symlink") {
      target = requireString(
        entry.target,
        `Homebrew runtime layer source ${path} symlink target`,
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxSymlinkTargetBytes,
      );
    } else if (type === "hardlink") {
      target = requireSafeRelativePath(
        entry.target,
        `Homebrew runtime layer source ${path} hardlink target`,
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes,
      );
    }
    const parsed: HomebrewDeferredTreeSourceEntry = {
      path,
      type: type as HomebrewDeferredTreeSourceEntry["type"],
      mode,
      size,
      ...(target === undefined ? {} : { target }),
    };
    byPath.set(path, parsed);
    return parsed;
  });
  const paths = entries.map((entry) => entry.path);
  if (!arraysEqual(paths, [...paths].sort(compareHomebrewCanonicalText))) {
    throw new Error("Homebrew runtime layer source inventory is not canonical");
  }
  const canonicalByPath = new Map<string, HomebrewDeferredTreeSourceEntry>();
  for (const start of entries) {
    if (start.type !== "hardlink" || canonicalByPath.has(start.path)) continue;
    const chain: HomebrewDeferredTreeSourceEntry[] = [];
    const seen = new Set<string>();
    let current = start;
    let canonical: HomebrewDeferredTreeSourceEntry | undefined;
    while (current.type === "hardlink") {
      canonical = canonicalByPath.get(current.path);
      if (canonical !== undefined) break;
      if (seen.has(current.path)) {
        throw new Error("Homebrew runtime layer source hardlink cycle");
      }
      seen.add(current.path);
      chain.push(current);
      const target = byPath.get(current.target!);
      if (target === undefined || (target.type !== "file" && target.type !== "hardlink")) {
        throw new Error(`Homebrew runtime layer source hardlink ${current.path} target is invalid`);
      }
      current = target;
    }
    if (canonical === undefined) canonical = current;
    for (const link of chain) canonicalByPath.set(link.path, canonical);
  }
  return { entries, canonicalByPath };
}

function validateEntries(
  value: unknown,
  inventory: Record<string, unknown>,
  decoder: unknown,
  sourceInventory?: {
    entries: HomebrewDeferredTreeSourceEntry[];
    canonicalByPath: Map<string, HomebrewDeferredTreeSourceEntry>;
  },
): HomebrewLazyLayerEntry[] {
  const values = requireArray(
    value,
    "Homebrew runtime layer entries",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxEntries,
  );
  const entries: HomebrewLazyLayerEntry[] = [];
  const entriesByPath = new Map<string, HomebrewLazyLayerEntry>();
  const sourceEntries = sourceInventory?.entries;
  const sourceByPath = sourceEntries === undefined
    ? undefined
    : new Map(sourceEntries.map((entry) => [entry.path, entry]));
  const paths = new Set<string>();
  let decodedPayload = 0;
  let payloadBytes = 0;
  let layerCount = 0;
  let nonLayerDirectoryCount = 0;
  let hasPayload = false;
  for (const [index, item] of values.entries()) {
    const initial = requireRecord(item, `Homebrew runtime layer entry ${index}`);
    const type = initial.type;
    if (
      type !== "directory" && type !== "file" && type !== "symlink" &&
      type !== "hardlink"
    ) {
      throw new Error(`Homebrew runtime layer entry ${index} has an invalid type`);
    }
    const record = exactRecord(
      item,
      type === "symlink"
        ? [
          "path", "source_path", "type", "ownership", "mode", "size", "target",
          ...(sourceByPath === undefined ? [] : ["materialization"]),
        ]
        : type === "file"
          ? [
            "path", "source_path", "type", "ownership", "mode", "size", "inode_group",
            ...(sourceByPath === undefined ? [] : ["materialization"]),
          ]
          : type === "hardlink"
            ? [
              "path", "source_path", "type", "ownership", "mode", "size",
              "target", "inode_group",
              ...(sourceByPath === undefined ? [] : ["materialization"]),
            ]
            : [
              "path", "source_path", "type", "ownership", "mode", "size",
              ...(sourceByPath === undefined ? [] : ["materialization"]),
            ],
      `Homebrew runtime layer entry ${index}`,
    );
    const nonLayerOwnership = sourceByPath === undefined
      ? "shared-base-directory"
      : "mergeable-directory";
    if (record.ownership !== "layer" && record.ownership !== nonLayerOwnership) {
      throw new Error(`Homebrew runtime layer entry ${index} has invalid ownership`);
    }
    if (record.ownership === nonLayerOwnership && type !== "directory") {
      throw new Error(`Homebrew runtime layer entry ${index} merges a non-directory`);
    }
    const path = requireSafeRelativePath(
      record.path,
      `Homebrew runtime layer entry ${index} path`,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes,
    );
    const sourcePath = requireSafeRelativePath(
      record.source_path,
      `Homebrew runtime layer entry ${index} source path`,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes,
    );
    const materialization = sourceByPath === undefined
      ? undefined
      : record.materialization;
    if (
      sourceByPath !== undefined && materialization !== "archive" &&
      materialization !== "archive-copy" &&
      materialization !== "archive-copy-mode" &&
      materialization !== "descriptor"
    ) {
      throw new Error(`Homebrew runtime layer entry ${index} materialization is invalid`);
    }
    if (
      path !== HOMEBREW_PREFIX.slice(1) &&
      !path.startsWith(`${HOMEBREW_PREFIX.slice(1)}/`)
    ) {
      throw new Error(`Homebrew runtime layer entry ${index} escapes the Homebrew prefix`);
    }
    if (paths.has(path)) {
      throw new Error(`Homebrew runtime layer entry ${index} duplicates ${path}`);
    }
    paths.add(path);
    const mode = requireInteger(
      record.mode,
      `Homebrew runtime layer entry ${index} mode`,
      0,
      0o7777,
    );
    const size = requireInteger(
      record.size,
      `Homebrew runtime layer entry ${index} size`,
      0,
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxUncompressedBytes,
    );
    if (type === "directory" && size !== 0) {
      throw new Error(`Homebrew runtime layer directory ${path} has nonzero size`);
    }
    let target: string | undefined;
    let inodeGroup: string | undefined;
    if (type === "symlink") {
      target = requireString(
        record.target,
        `Homebrew runtime layer entry ${index} target`,
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxSymlinkTargetBytes,
      );
      if (materialization === "archive" && mode !== 0o777) {
        throw new Error(`Homebrew runtime layer archive symlink ${path} mode must be 0777`);
      }
      if (new TextEncoder().encode(target).byteLength !== size) {
        throw new Error(`Homebrew runtime layer symlink ${path} size differs from its target`);
      }
    } else if (type === "file" || type === "hardlink") {
      inodeGroup = requireString(
        record.inode_group,
        `Homebrew runtime layer entry ${index} inode group`,
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes,
      );
      if (type === "hardlink") {
        target = requireSafeRelativePath(
          record.target,
          `Homebrew runtime layer entry ${index} hardlink target`,
          HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes,
        );
      }
    }
    if (type !== "hardlink") decodedPayload += size;
    if (type === "file") payloadBytes += size;
    if (
      decodedPayload > HOMEBREW_RUNTIME_LAYER_LIMITS.maxUncompressedBytes ||
      payloadBytes > HOMEBREW_RUNTIME_LAYER_LIMITS.maxUncompressedBytes
    ) {
      throw new Error("Homebrew runtime layer exceeds the uncompressed size cap");
    }
    if (record.ownership === "layer") {
      layerCount += 1;
      hasPayload ||= type !== "directory";
    } else {
      nonLayerDirectoryCount += 1;
    }
    const entry = {
      path,
      source_path: sourcePath,
      ...(materialization === undefined ? {} : { materialization }),
      type,
      ownership: record.ownership,
      mode,
      size,
      ...(target === undefined ? {} : { target }),
      ...(inodeGroup === undefined ? {} : { inode_group: inodeGroup }),
    } as HomebrewLazyLayerEntry;
    if (sourceByPath !== undefined) {
      const source = sourceByPath.get(sourcePath);
      if (materialization === "descriptor") {
        if (type !== "directory" && type !== "symlink") {
          throw new Error(`Homebrew runtime layer descriptor entry ${path} is not structural`);
        }
        if (source !== undefined) {
          throw new Error(`Homebrew runtime layer descriptor entry ${path} impersonates a source`);
        }
      } else if (source === undefined) {
        throw new Error(`Homebrew runtime layer entry ${path} source is absent`);
      } else if (
        materialization === "archive-copy" ||
        materialization === "archive-copy-mode"
      ) {
        if (
          type !== "file" || source.type !== "file" || source.size !== size ||
          (materialization === "archive-copy" && source.mode !== mode)
        ) {
          throw new Error(`Homebrew runtime layer archive copy ${path} differs from source`);
        }
      } else if (
        source.type !== type ||
        (type === "file" && source.size !== size) ||
        (type === "symlink" && source.target !== target) ||
        (type !== "hardlink" && source.mode !== mode)
      ) {
        throw new Error(`Homebrew runtime layer archive entry ${path} differs from source`);
      }
    }
    entries.push(entry);
    entriesByPath.set(path, entry);
  }
  const orderedPaths = entries.map((entry) => entry.path);
  if (!arraysEqual(orderedPaths, [...orderedPaths].sort(compareHomebrewCanonicalText))) {
    throw new Error("Homebrew runtime layer entries are not in canonical path order");
  }
  for (const entry of entries) {
    const components = entry.path.split("/");
    for (let length = 1; length < components.length; length += 1) {
      const ancestorPath = components.slice(0, length).join("/");
      const ancestor = entriesByPath.get(ancestorPath);
      if (ancestor !== undefined && ancestor.type !== "directory") {
        throw new Error(
          `Homebrew runtime layer entry ${entry.path} descends through ` +
            `non-directory ${ancestorPath}`,
        );
      }
    }
  }
  const { canonicalByGroup } = resolveHardlinkGraph(
    entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      target: entry.target,
      inodeGroup: entry.inode_group,
    })),
    "Homebrew runtime layer",
  );
  if (sourceByPath !== undefined) {
    for (const entry of entries) {
      if (entry.type !== "hardlink" || entry.materialization !== "archive") continue;
      const source = sourceByPath.get(entry.source_path)!;
      const target = entriesByPath.get(entry.target!);
      const regularSource = sourceInventory!.canonicalByPath.get(source.path);
      if (
        source.target !== target?.source_path ||
        regularSource?.type !== "file" ||
        regularSource.mode !== entry.mode ||
        target?.mode !== entry.mode
      ) {
        throw new Error(`Homebrew runtime layer hardlink ${entry.path} differs from source`);
      }
    }
  }
  if (!hasPayload) throw new Error("Homebrew runtime layer has no layer-owned payload");
  const sourceEntryCount = sourceEntries?.length ??
    new Set(entries.map((entry) => entry.source_path)).size;
  const expandedBytes = requireInteger(
    inventory.expanded_bytes,
    "Homebrew runtime layer expanded bytes",
    0,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxUncompressedBytes,
  );
  if (
    inventory.entry_count !== entries.length ||
    inventory.source_entry_count !== sourceEntryCount ||
    inventory.regular_inode_count !== canonicalByGroup.size ||
    inventory.layer_entry_count !== layerCount ||
    (sourceEntries === undefined
      ? inventory.shared_base_directory_count !== nonLayerDirectoryCount
      : inventory.mergeable_directory_count !== nonLayerDirectoryCount) ||
    inventory.payload_bytes !== payloadBytes ||
    (sourceEntries === undefined && expandedBytes < decodedPayload) ||
    (decoder === "zip-v1" && expandedBytes !== decodedPayload)
  ) {
    throw new Error("Homebrew runtime layer deferred-tree counts differ from its entries");
  }
  return entries;
}

function validateLayerPackageEntries(
  packages: readonly HomebrewLazyLayerPackageRecord[],
  entries: readonly HomebrewLazyLayerEntry[],
): void {
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const pkg of packages) {
    const kegPath = pkg.keg.slice(1);
    const keg = entriesByPath.get(kegPath);
    if (
      keg === undefined ||
      keg.type !== "directory" ||
      keg.ownership !== "layer"
    ) {
      throw new Error(
        `Homebrew runtime layer package ${pkg.full_name} has no layer-owned keg entry`,
      );
    }

    const optPath = `${HOMEBREW_PREFIX.slice(1)}/${pkg.opt_link.path}`;
    const opt = entriesByPath.get(optPath);
    if (
      opt === undefined ||
      opt.type !== "symlink" ||
      opt.ownership !== "layer" ||
      opt.target !== pkg.opt_link.target
    ) {
      throw new Error(
        `Homebrew runtime layer package ${pkg.full_name} has no matching opt link entry`,
      );
    }
  }
}

interface ParsedBaseComposition {
  packageOrder: string[];
  packageNames: Set<string>;
  packageRecords: Map<string, Record<string, unknown>>;
  packageValues: unknown[];
  requestedPackagesSha256: string;
  packageSetSha256: string;
}

function parseBaseComposition(bytes: Uint8Array): ParsedBaseComposition {
  const root = requireRecord(
    decodeJson(bytes, "Homebrew shell composition"),
    "Homebrew shell composition",
  );
  if (root.schema !== 1) {
    throw new Error("Homebrew shell composition has an unsupported schema");
  }
  const selection = requireRecord(
    root.selection,
    "Homebrew shell composition selection",
  );
  const requestedPackagesSha256 = requireSha256(
    selection.requested_packages_sha256,
    "Homebrew shell composition requested package digest",
  );
  const packages = requireArray(
    root.packages,
    "Homebrew shell composition packages",
    1,
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages,
  );
  const packageRecords = new Map<string, Record<string, unknown>>();
  const packageOrder = packages.map((value, index) => {
    const record = requireRecord(value, `Homebrew shell composition package ${index}`);
    const fullName = requireFullPackageName(
      record.full_name,
      `Homebrew shell composition package ${index} full name`,
    );
    packageRecords.set(fullName, record);
    return fullName;
  });
  if (new Set(packageOrder).size !== packageOrder.length) {
    throw new Error("Homebrew shell composition duplicates a package identity");
  }
  return {
    packageOrder,
    packageNames: new Set(packageOrder),
    packageRecords,
    packageValues: packages,
    requestedPackagesSha256,
    packageSetSha256: "",
  };
}

function packageArtifactIdentity(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const optLink = exactRecord(record.opt_link, ["path", "target"], `${label} opt link`);
  const builtFrom = record.built_from === undefined
    ? undefined
    : exactRecord(record.built_from, [
      "tap_repository",
      "tap_commit",
      "kandelo_repository",
      "kandelo_commit",
      "formula_sha256",
    ], `${label} built_from`);
  return {
    name: requirePackageName(record.name, `${label} name`),
    full_name: requireFullPackageName(record.full_name, `${label} full name`),
    tap_repository: requireRepository(record.tap_repository, `${label} tap repository`),
    tap_name: requireRepository(record.tap_name, `${label} tap name`),
    tap_commit: requireGitSha(record.tap_commit, `${label} tap commit`),
    version: requireString(record.version, `${label} version`, 256),
    arch: requireArch(record.arch, `${label} architecture`),
    source_status: requireString(record.source_status, `${label} source status`, 64),
    metadata_status: requireString(record.metadata_status, `${label} metadata status`, 256),
    url: requireHttpsUrl(record.url, `${label} URL`),
    sha256: requireSha256(record.sha256, `${label} digest`),
    bytes: requireInteger(record.bytes, `${label} bytes`, 1, 2 * 1024 * 1024 * 1024),
    cache_key_sha: requireSha256(record.cache_key_sha, `${label} cache key`),
    link_manifest: requireSafeRelativePath(record.link_manifest, `${label} link manifest`),
    prefix: requireString(record.prefix, `${label} prefix`, 4096),
    keg: requireCanonicalAbsolutePath(record.keg, `${label} keg`, 4096),
    opt_link: {
      path: requireSafeRelativePath(optLink.path, `${label} opt link path`),
      target: requireString(optLink.target, `${label} opt link target`, 4096),
    },
    ...(builtFrom === undefined ? {} : {
      built_from: {
        tap_repository: requireRepository(
          builtFrom.tap_repository,
          `${label} built_from tap repository`,
        ),
        tap_commit: requireGitSha(
          builtFrom.tap_commit,
          `${label} built_from tap commit`,
        ),
        kandelo_repository: requireRepository(
          builtFrom.kandelo_repository,
          `${label} built_from Kandelo repository`,
        ),
        kandelo_commit: requireGitSha(
          builtFrom.kandelo_commit,
          `${label} built_from Kandelo commit`,
        ),
        formula_sha256: requireSha256(
          builtFrom.formula_sha256,
          `${label} built_from Formula digest`,
        ),
      },
    }),
  };
}

function readBoundedFile(
  fs: MemoryFileSystem,
  path: string,
  maximum: number,
): Uint8Array {
  const stat = fs.stat(path);
  if (stat.size <= 0 || stat.size > maximum) {
    throw new Error(`${path} must contain 1 to ${maximum} bytes`);
  }
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.read(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (read <= 0) throw new Error(`short read from ${path}`);
      offset += read;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

function lstatOrNull(fs: MemoryFileSystem, path: string) {
  try {
    return fs.lstat(path);
  } catch {
    return null;
  }
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON: ${errorMessage(error)}`);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 verification is unavailable");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort(compareHomebrewCanonicalText);
  const expected = [...keys].sort(compareHomebrewCanonicalText);
  if (!arraysEqual(actual, expected)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return record;
}

function recordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const keys = new Set(Object.keys(record));
  if (
    required.some((key) => !keys.has(key)) ||
    [...keys].some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return record;
}

function requireArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} entries`);
  }
  return value;
}

function requireString(value: unknown, label: string, maximumBytes = 8192): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (hasLoneUnicodeSurrogate(value)) {
    throw new Error(`${label} must contain only Unicode scalar values`);
  }
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function hasLoneUnicodeSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (
      unit <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      index += 1;
      continue;
    }
    return true;
  }
  return false;
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256 digest`);
  }
  return value;
}

function requireAssetName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !ASSET_RE.test(value) ||
    value.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxReleaseAssetNameBytes
  ) {
    throw new Error(`${label} is not a safe release asset name`);
  }
  return value;
}

function validateAssetIdentity(
  value: unknown,
  label: string,
  expectedAsset?: string,
  maximumBytes = HOMEBREW_RUNTIME_LAYER_LIMITS.maxDescriptorBytes,
): { asset: string; sha256: string; bytes: number } {
  const record = exactRecord(value, ["asset", "sha256", "bytes"], label);
  const asset = requireAssetName(record.asset, `${label} asset`);
  if (expectedAsset !== undefined && asset !== expectedAsset) {
    throw new Error(`${label} names an unsupported asset`);
  }
  return {
    asset,
    sha256: requireSha256(record.sha256, `${label} digest`),
    bytes: requireInteger(record.bytes, `${label} bytes`, 1, maximumBytes),
  };
}

function validateReleaseAsset(
  value: unknown,
  label: string,
  expectedAsset: string,
  releaseRoot: string,
): { asset: string; url: string; sha256: string; bytes: number } {
  const record = exactRecord(value, ["asset", "url", "sha256", "bytes"], label);
  const identity = validateAssetIdentity(
    { asset: record.asset, sha256: record.sha256, bytes: record.bytes },
    label,
    expectedAsset,
  );
  const url = requireHttpsUrl(record.url, `${label} URL`);
  if (url !== `${releaseRoot}/${identity.asset}`) {
    throw new Error(`${label} URL differs from its independent release`);
  }
  return { ...identity, url };
}

function sameAssetIdentity(
  left: Record<string, unknown> | { asset: string; sha256: string; bytes: number },
  right: { asset: string; sha256: string; bytes: number },
): boolean {
  return left.asset === right.asset &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes;
}

function requireGitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA_RE.test(value)) {
    throw new Error(`${label} is not a lowercase Git commit`);
  }
  return value;
}

function requireArch(value: unknown, label: string): "wasm32" | "wasm64" {
  if (value !== "wasm32" && value !== "wasm64") {
    throw new Error(`${label} must be wasm32 or wasm64`);
  }
  return value;
}

function requireRepository(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength >
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxRepositoryBytes ||
    !REPOSITORY_RE.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireReleaseTag(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 256 || !RELEASE_TAG_RE.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requirePackageName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength >
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackageNameBytes ||
    !PACKAGE_RE.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireRuntimeLayerId(value: unknown, label: string): string {
  if (!isHomebrewRuntimeLayerId(value)) {
    throw new Error(`${label} is not a bounded Homebrew runtime-layer id`);
  }
  return value;
}

function requireFullPackageName(value: unknown, label: string): string {
  const name = requireString(value, label, 512);
  const components = name.split("/");
  if (
    components.length !== 3 ||
    components.some((component) => !PACKAGE_RE.test(component))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return name;
}

function requirePackageNameArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string[] {
  const result = requireArray(value, label, minimum, maximum).map((item, index) =>
    requirePackageName(item, `${label} ${index}`)
  );
  if (new Set(result).size !== result.length) throw new Error(`${label} has duplicates`);
  return result;
}

function requireFullPackageArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string[] {
  const result = requireArray(value, label, minimum, maximum).map((item, index) =>
    requireFullPackageName(item, `${label} ${index}`)
  );
  if (new Set(result).size !== result.length) throw new Error(`${label} has duplicates`);
  return result;
}

function requireHttpsUrl(value: unknown, label: string): string {
  const text = requireString(value, label, HOMEBREW_RUNTIME_LAYER_LIMITS.maxStringBytes);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${label} must be an unauthenticated HTTPS URL without a fragment`);
  }
  return text;
}

function requireSafeRelativePath(
  value: unknown,
  label: string,
  maximumBytes = 4096,
): string {
  const path = requireString(value, label, maximumBytes);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some(
      (component) => component === "" || component === "." || component === "..",
    )
  ) {
    throw new Error(`${label} must be a canonical relative POSIX path`);
  }
  return path;
}

function requireCanonicalAbsolutePath(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  const path = requireString(value, label, maximumBytes);
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    (path.length > 1 && path.endsWith("/")) ||
    path.slice(1).split("/").some(
      (component) => component === "" || component === "." || component === "..",
    )
  ) {
    throw new Error(`${label} must be a canonical absolute POSIX path`);
  }
  return path;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
