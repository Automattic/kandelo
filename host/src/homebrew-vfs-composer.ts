import { createHash } from "node:crypto";
import {
  applyHomebrewVfsConsumerState,
  writeHomebrewVfsComposition,
  type HomebrewVfsBuildReport,
  type HomebrewVfsCatalogCheckout,
  type HomebrewVfsCompatibilityPolicy,
  type HomebrewVfsMigrationLockBinding,
  type HomebrewVfsSelectionSource,
} from "./homebrew-vfs-builder";
import {
  buildHomebrewOriginalBottleCollection,
  type HomebrewDeferredTreeDescriptor,
  type HomebrewDeferredTreeDraftDescriptor,
  type HomebrewLazyLayerEntry,
  type HomebrewLazyLayerPayload,
} from "./homebrew-lazy-layer";
import {
  assertHomebrewVfsDeferredPackageCollection,
  selectHomebrewVfsMaterialization,
  type HomebrewVfsMaterializationSelection,
} from "./homebrew-vfs-materialization-policy";
import {
  registerHomebrewDeferredTreeCollection,
  type RegisteredHomebrewDeferredTree,
} from "./homebrew-runtime-layer-consumer";
import type {
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "./homebrew-vfs-planner";
import { MemoryFileSystem } from "./vfs/memory-fs";
import { writeVfsBinary } from "./vfs/image-helpers";
import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET as MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND as MIRROR_PLAN_KIND,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  projectHomebrewBottleMirrorPlan,
  type HomebrewBottleMirrorAsset,
  type HomebrewBottleMirrorPlan,
} from "./homebrew-bottle-mirror-plan";
export {
  encodeHomebrewBottleMirrorPlan,
  encodeHomebrewBottleMirrorCollectionIdentity,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  type HomebrewBottleMirrorAsset,
  type HomebrewBottleMirrorPlan,
} from "./homebrew-bottle-mirror-plan";

const MATERIALIZATION_POLICY_KIND =
  "kandelo-homebrew-vfs-materialization-policy" as const;
const REPOSITORY_COMPONENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export interface HomebrewBottleMirrorPayload {
  id: string;
  package: string;
  asset: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface HomebrewBottleMirrorPlanAsset {
  asset: typeof MIRROR_PLAN_ASSET;
  sha256: string;
  bytes: Uint8Array;
}

export interface BuildHomebrewMaterializedVfsOptions {
  /** Exclusive output filesystem containing the platform-only lower image. */
  fs: MemoryFileSystem;
  /** Fresh scratch filesystem used to compute the complete global pour once. */
  collectionFs: MemoryFileSystem;
  policy: unknown;
  /** Public repository that will carry exact mirrors for deferred bottles. */
  mirrorRepository: string;
  loadBottleBytes: (
    pkg: HomebrewVfsPackagePlan,
  ) => Uint8Array | Promise<Uint8Array>;
  compatibilityPolicy?: HomebrewVfsCompatibilityPolicy;
  selectionSource?: HomebrewVfsSelectionSource;
  catalogCheckout?: HomebrewVfsCatalogCheckout;
  migrationLock?: HomebrewVfsMigrationLockBinding;
  writeProfile?: boolean;
  createdBy?: string;
}

interface MaterializedEntryEvidence {
  path: string;
  type: HomebrewLazyLayerEntry["type"];
  mode: number;
  size: number;
  sha256?: string;
  target?: string;
}

export interface HomebrewVfsMaterializationEvidence {
  embedded: Array<{
    package: string;
    treeId: string;
    sha256: string;
    bytes: number;
  }>;
  deferred: Array<{
    package: string;
    treeId: string;
    sha256: string;
    bytes: number;
    url: string;
  }>;
  mirrorPlan: {
    path: typeof HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH;
    sha256: string;
    bytes: number;
  };
  embeddedEntries: MaterializedEntryEvidence[];
}

export interface HomebrewMaterializedVfsBuildResult {
  fs: MemoryFileSystem;
  report: HomebrewVfsBuildReport;
  selection: HomebrewVfsMaterializationSelection;
  mirrorPlan: HomebrewBottleMirrorPlan;
  mirrorPayloads: HomebrewBottleMirrorPayload[];
  mirrorPlanAsset: HomebrewBottleMirrorPlanAsset;
  evidence: HomebrewVfsMaterializationEvidence;
}

/**
 * Build global ownership from the complete plan, partition only afterward,
 * then materialize the reviewed embedded groups through their exact opaque
 * registration handles. Every other original bottle remains independently
 * first-use deferred.
 */
export async function buildHomebrewMaterializedVfs(
  plan: HomebrewVfsPlan,
  options: BuildHomebrewMaterializedVfsOptions,
): Promise<HomebrewMaterializedVfsBuildResult> {
  if (options.fs === options.collectionFs) {
    throw new Error("Homebrew materialized VFS requires a separate collection filesystem");
  }
  const selection = selectHomebrewVfsMaterialization(plan, options.policy);
  const collection = await buildHomebrewOriginalBottleCollection(plan, {
    fs: options.collectionFs,
    baseFs: options.fs,
    loadBottleBytes: options.loadBottleBytes,
    compatibilityPolicy: options.compatibilityPolicy,
    selectionSource: options.selectionSource,
    catalogCheckout: options.catalogCheckout,
    migrationLock: options.migrationLock,
    createdBy: options.createdBy ?? "host/src/homebrew-vfs-composer.ts",
  });
  const bindings = bindCollection(plan, collection.deferredTrees, collection.payloads);
  const deferredSet = new Set(selection.deferredPackages.map((pkg) => pkg.fullName));
  const deferredBindings = bindings.filter((binding) => deferredSet.has(binding.package));
  assertHomebrewVfsDeferredPackageCollection(
    selection,
    selection.deferredPackages.map((pkg) => pkg.fullName),
    deferredBindings.map((binding) => binding.package),
  );

  const mirrorPlan = createHomebrewBottleMirrorPlan(
    options.mirrorRepository,
    deferredBindings,
  );
  const mirrorPayloads = createHomebrewBottleMirrorPayloads(deferredBindings);
  const mirrorPlanBytes = encodeHomebrewBottleMirrorPlan(mirrorPlan);
  const mirrorPlanAsset: HomebrewBottleMirrorPlanAsset = {
    asset: MIRROR_PLAN_ASSET,
    sha256: digest(mirrorPlanBytes),
    bytes: mirrorPlanBytes,
  };
  assertHomebrewBottleMirrorBundle(mirrorPlan, mirrorPayloads, mirrorPlanAsset);
  const mirrorByPackage = new Map(
    mirrorPlan.assets.map((asset) => [asset.package, asset]),
  );
  const embeddedSet = new Set(selection.embeddedPackages.map((pkg) => pkg.fullName));
  const closedTrees = bindings.map((binding) => closeCollectionTree(
    binding,
    embeddedSet.has(binding.package),
    mirrorByPackage.get(binding.package),
  ));
  createHomebrewPrefixAncestors(options.fs, plan);
  const registered = registerHomebrewDeferredTreeCollection({
    fs: options.fs,
    id: "main-shell",
    schema: 5,
    trees: closedTrees,
  });
  const registeredByPackage = bindRegisteredTrees(registered, bindings);

  for (const pkg of selection.embeddedPackages) {
    const binding = bindings.find((candidate) => candidate.package === pkg.fullName)!;
    const registeredTree = registeredByPackage.get(pkg.fullName)!;
    assertRegisteredBinding(binding, registeredTree);
    const changed = await options.fs.materializeRegisteredDeferredTree(
      registeredTree.materialization,
      binding.payload.bytes,
    );
    if (!changed) {
      throw new Error(`Homebrew embedded tree ${binding.tree.id} was already materialized`);
    }
  }

  writeHomebrewBottleMirrorPlan(options.fs, mirrorPlanAsset);

  const consumer = applyHomebrewVfsConsumerState(plan, {
    fs: options.fs,
    compatibilityPolicy: options.compatibilityPolicy,
    writeProfile: options.writeProfile,
  });
  if (
    JSON.stringify(consumer.linkConflicts) !==
      JSON.stringify(collection.report.link_conflicts ?? [])
  ) {
    throw new Error("Homebrew consumer conflict ownership differs from the global collection");
  }
  const report: HomebrewVfsBuildReport = {
    ...collection.report,
    ...(consumer.compatibilityLinks === undefined ? {} : {
      compatibility_links: consumer.compatibilityLinks,
    }),
    ...(consumer.runtimeState.length === 0 ? {} : {
      runtime_state: consumer.runtimeState,
    }),
    materialization: {
      policy: MATERIALIZATION_POLICY_KIND,
      embedded_package_order: selection.embeddedPackages.map((pkg) => pkg.fullName),
      deferred_package_order: selection.deferredPackages.map((pkg) => pkg.fullName),
      embedded_tree_count: selection.embeddedPackages.length,
      deferred_tree_count: selection.deferredPackages.length,
      bottle_mirror: {
        repository: mirrorPlan.repository,
        tag: mirrorPlan.tag,
        collection_sha256: mirrorPlan.collection_sha256,
        asset_count: mirrorPlan.assets.length,
        manifest_path: HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
        manifest_sha256: mirrorPlanAsset.sha256,
        manifest_bytes: mirrorPlanAsset.bytes.byteLength,
      },
    },
  };
  writeHomebrewVfsComposition(
    options.fs,
    plan,
    report,
    options.createdBy ?? "host/src/homebrew-vfs-composer.ts",
  );

  const evidence = createMaterializationEvidence(
    selection,
    bindings,
    options.collectionFs,
    mirrorPlanAsset,
    mirrorPlan,
  );
  assertHomebrewVfsMaterialization(options.fs, evidence);
  return {
    fs: options.fs,
    report,
    selection,
    mirrorPlan,
    mirrorPayloads,
    mirrorPlanAsset,
    evidence,
  };
}

/**
 * Recompute the manifest-derived tag and bind every planned asset to exact
 * caller-owned bytes without relying on collection array positions.
 */
export function assertHomebrewBottleMirrorBundle(
  plan: HomebrewBottleMirrorPlan,
  payloads: readonly HomebrewBottleMirrorPayload[],
  manifest: HomebrewBottleMirrorPlanAsset,
): void {
  assertHomebrewBottleMirrorPlan(plan);
  const payloadByPackage = new Map(payloads.map((payload) => [payload.package, payload]));
  if (payloadByPackage.size !== payloads.length || payloads.length !== plan.assets.length) {
    throw new Error("Homebrew bottle mirror payload ownership is not one-to-one");
  }
  for (const asset of plan.assets) {
    const payload = payloadByPackage.get(asset.package);
    if (
      payload === undefined ||
      payload.id !== asset.id ||
      payload.asset !== asset.asset ||
      payload.sha256 !== asset.sha256 ||
      payload.bytes.byteLength !== asset.bytes ||
      digest(payload.bytes) !== asset.sha256
    ) {
      throw new Error(`Homebrew bottle mirror payload differs for ${asset.package}`);
    }
  }
  const expectedManifest = encodeHomebrewBottleMirrorPlan(plan);
  if (
    manifest.asset !== MIRROR_PLAN_ASSET ||
    manifest.bytes.byteLength !== expectedManifest.byteLength ||
    !manifest.bytes.every((byte, index) => byte === expectedManifest[index]) ||
    manifest.sha256 !== digest(expectedManifest)
  ) {
    throw new Error("Homebrew bottle mirror manifest bytes are not canonical");
  }
}

/** Validate the complete derived identity without requiring payload bytes. */
export function assertHomebrewBottleMirrorPlan(
  plan: HomebrewBottleMirrorPlan,
): void {
  const normalized = projectHomebrewBottleMirrorPlan(plan);
  const repository = normalized.repository;
  const identities = normalized.assets;
  const collectionSha = mirrorCollectionDigest(repository, identities);
  const tag = `homebrew-shell-bottles-sha256-${collectionSha}`;
  const releaseRoot = `https://github.com/${repository}/releases/download/${tag}`;
  if (
    normalized.collection_sha256 !== collectionSha ||
    normalized.tag !== tag ||
    normalized.release_root !== releaseRoot ||
    normalized.assets.some((asset) => asset.url !== `${releaseRoot}/${asset.asset}`)
  ) {
    throw new Error("Homebrew bottle mirror plan has inconsistent derived identity");
  }
}

/** Prove the exact embedded/deferred split on a live or restored filesystem. */
export function assertHomebrewVfsMaterialization(
  fs: MemoryFileSystem,
  evidence: HomebrewVfsMaterializationEvidence,
): void {
  const mirrorPlanStat = fs.lstat(evidence.mirrorPlan.path);
  if (
    fs.getLazyEntry(evidence.mirrorPlan.path) !== null ||
    (mirrorPlanStat.mode & S_IFMT) !== S_IFREG ||
    (mirrorPlanStat.mode & 0o7777) !== 0o644 ||
    mirrorPlanStat.size !== evidence.mirrorPlan.bytes ||
    digest(readVfsFile(fs, evidence.mirrorPlan.path)) !== evidence.mirrorPlan.sha256
  ) {
    throw new Error("Homebrew embedded bottle mirror plan changed identity");
  }
  const pending = fs.exportLazyArchiveEntries().filter(
    (entry) => entry.content !== undefined,
  );
  const pendingIdentities = pending.map((entry) => {
    const url = entry.content!.transports[0];
    if (url === undefined) {
      throw new Error(`Homebrew pending deferred tree ${entry.mountPrefix} has no transport`);
    }
    return {
      url,
      sha256: entry.content!.sha256,
      bytes: entry.content!.bytes,
    };
  }).sort((left, right) => compareText(left.url, right.url));
  const expectedDeferred = evidence.deferred.map((tree) =>
    ({ url: tree.url, sha256: tree.sha256, bytes: tree.bytes })
  ).sort((left, right) => compareText(left.url, right.url));
  if (JSON.stringify(pendingIdentities) !== JSON.stringify(expectedDeferred)) {
    throw new Error(
      "Homebrew pending deferred trees differ from the selected package partition",
    );
  }
  for (const entry of evidence.embeddedEntries) {
    const path = `/${entry.path}`;
    if (fs.getLazyEntry(path) !== null) {
      throw new Error(`Homebrew embedded path ${path} remains lazy`);
    }
    const stat = fs.lstat(path);
    if ((stat.mode & S_IFMT) !== entryTypeMode(entry.type)) {
      throw new Error(`Homebrew embedded path ${path} changed type`);
    }
    const sizeChanged = entry.type !== "directory" && stat.size !== entry.size;
    if ((stat.mode & 0o7777) !== entry.mode || sizeChanged) {
      throw new Error(
        `Homebrew embedded path ${path} changed mode or size ` +
          `(expected ${entry.mode.toString(8)}/${entry.size}, got ` +
          `${(stat.mode & 0o7777).toString(8)}/${stat.size})`,
      );
    }
    if (entry.type === "symlink") {
      if (fs.readlink(path) !== entry.target) {
        throw new Error(`Homebrew embedded symlink ${path} changed target`);
      }
    } else if (entry.type === "file" || entry.type === "hardlink") {
      if (digest(readVfsFile(fs, path)) !== entry.sha256) {
        throw new Error(`Homebrew embedded regular bytes changed at ${path}`);
      }
      if (entry.type === "hardlink") {
        const target = fs.lstat(`/${entry.target}`);
        if (target.ino !== stat.ino) {
          throw new Error(`Homebrew embedded hardlink ${path} changed identity`);
        }
      }
    }
  }
}

interface BoundCollectionTree {
  package: string;
  tree: HomebrewDeferredTreeDraftDescriptor;
  payload: HomebrewLazyLayerPayload;
}

function bindCollection(
  plan: HomebrewVfsPlan,
  trees: readonly HomebrewDeferredTreeDraftDescriptor[],
  payloads: readonly HomebrewLazyLayerPayload[],
): BoundCollectionTree[] {
  if (trees.length !== plan.packages.length || payloads.length !== trees.length) {
    throw new Error("Homebrew original-bottle collection is not one tree per package");
  }
  const packageNames = new Set(plan.packages.map((pkg) => pkg.fullName));
  const payloadById = new Map(payloads.map((payload) => [payload.id, payload]));
  if (payloadById.size !== payloads.length) {
    throw new Error("Homebrew original-bottle collection duplicates a payload id");
  }
  const packages = new Set<string>();
  const bindings = trees.map((tree): BoundCollectionTree => {
    const packageName = tree.package;
    if (
      packageName === undefined ||
      !packageNames.has(packageName) ||
      packages.has(packageName)
    ) {
      throw new Error("Homebrew original-bottle tree has invalid package ownership");
    }
    packages.add(packageName);
    const payload = payloadById.get(tree.id);
    if (
      payload === undefined ||
      digest(payload.bytes) !== tree.content.sha256 ||
      payload.bytes.byteLength !== tree.content.bytes
    ) {
      throw new Error(`Homebrew original-bottle tree ${tree.id} differs from its payload`);
    }
    const release = tree.transports.filter((transport) =>
      transport.kind === "bundle-release"
    );
    if (release.length !== 1 || release[0]!.asset !== payload.asset) {
      throw new Error(`Homebrew original-bottle tree ${tree.id} has no exact payload asset`);
    }
    return {
      package: packageName,
      tree,
      payload,
    };
  });
  if (packages.size !== packageNames.size) {
    throw new Error("Homebrew original-bottle collection omits a planned package");
  }
  return bindings;
}

function createHomebrewBottleMirrorPlan(
  repository: string,
  bindings: readonly BoundCollectionTree[],
): HomebrewBottleMirrorPlan {
  repository = canonicalGitHubRepository(repository);
  const identities = bindings.map((binding) => ({
    id: binding.tree.id,
    package: binding.package,
    asset: binding.payload.asset,
    sha256: binding.tree.content.sha256,
    bytes: binding.tree.content.bytes,
  })).sort((left, right) => compareText(left.id, right.id));
  const collectionSha = mirrorCollectionDigest(repository, identities);
  const tag = `homebrew-shell-bottles-sha256-${collectionSha}`;
  const releaseRoot = `https://github.com/${repository}/releases/download/${tag}`;
  return {
    schema: 1,
    kind: MIRROR_PLAN_KIND,
    repository,
    collection_sha256: collectionSha,
    tag,
    release_root: releaseRoot,
    manifest_asset: MIRROR_PLAN_ASSET,
    assets: identities.map((identity) => ({
      ...identity,
      url: `${releaseRoot}/${identity.asset}`,
    })),
  };
}

function createHomebrewBottleMirrorPayloads(
  bindings: readonly BoundCollectionTree[],
): HomebrewBottleMirrorPayload[] {
  return [...bindings]
    .sort((left, right) => compareText(left.tree.id, right.tree.id))
    .map((binding) => {
      const bytes = new Uint8Array(binding.payload.bytes.byteLength);
      bytes.set(binding.payload.bytes);
      return {
        id: binding.tree.id,
        package: binding.package,
        asset: binding.payload.asset,
        sha256: binding.tree.content.sha256,
        bytes,
      };
    });
}

function mirrorCollectionDigest(
  repository: string,
  identities: ReadonlyArray<{
    id: string;
    package: string;
    asset: string;
    sha256: string;
    bytes: number;
  }>,
): string {
  const canonical = [...identities].sort((left, right) => compareText(left.id, right.id));
  return digest(encodeHomebrewBottleMirrorCollectionIdentity(repository, canonical));
}

function canonicalGitHubRepository(repository: string): string {
  if (typeof repository !== "string") {
    throw new Error(`Homebrew bottle mirror repository is invalid`);
  }
  const components = repository.split("/");
  if (
    components.length !== 2 ||
    components.some((component) =>
      component === "." ||
      component === ".." ||
      !REPOSITORY_COMPONENT_RE.test(component)
    )
  ) {
    throw new Error(`Homebrew bottle mirror repository ${repository} is invalid`);
  }
  return components.map((component) => component.toLowerCase()).join("/");
}

/**
 * Bottle inventories own the Homebrew prefix itself, but intentionally do not
 * claim host-layout directories above it. Match an eager pour's structural
 * setup without weakening deferred-tree collision checks: create only missing
 * ancestors, and reject every existing non-directory.
 */
function createHomebrewPrefixAncestors(
  fs: MemoryFileSystem,
  plan: HomebrewVfsPlan,
): void {
  const prefixes = new Set(plan.packages.map((pkg) => pkg.prefix));
  for (const prefix of prefixes) {
    const components = prefix.split("/");
    if (
      components[0] !== "" ||
      components.length < 2 ||
      components.at(-1) === "" ||
      components.slice(1).some((component) =>
        component === "" || component === "." || component === ".."
      )
    ) {
      throw new Error(`Homebrew package prefix ${prefix} is not canonical`);
    }
    for (let length = 1; length < components.length - 1; length += 1) {
      const ancestor = `/${components.slice(1, length + 1).join("/")}`;
      const existing = lstatOrNull(fs, ancestor);
      if (existing === null) {
        fs.mkdir(ancestor, 0o755);
        fs.chmod(ancestor, 0o755);
      } else if ((existing.mode & S_IFMT) !== S_IFDIR) {
        throw new Error(
          `Homebrew package prefix ${prefix} descends through non-directory ${ancestor}`,
        );
      }
    }
  }
}

function closeCollectionTree(
  binding: BoundCollectionTree,
  embedded: boolean,
  mirror: HomebrewBottleMirrorAsset | undefined,
): HomebrewDeferredTreeDescriptor {
  const external = binding.tree.transports.filter(
    (transport): transport is { kind: "external-https"; url: string } =>
      transport.kind === "external-https",
  );
  if (embedded) {
    return {
      ...binding.tree,
      // This exclusive build-only registration is consumed immediately by
      // its opaque exact-byte handle and must never reach serialization.
      transports: [],
    };
  }
  if (
    mirror === undefined ||
    mirror.package !== binding.package ||
    mirror.id !== binding.tree.id ||
    mirror.sha256 !== binding.tree.content.sha256 ||
    mirror.bytes !== binding.tree.content.bytes ||
    mirror.asset !== binding.payload.asset
  ) {
    throw new Error(`Homebrew deferred tree ${binding.tree.id} has no exact public mirror`);
  }
  return {
    ...binding.tree,
    transports: [
      { kind: "bundle-release", asset: mirror.asset, url: mirror.url },
      ...external,
    ],
  };
}

function bindRegisteredTrees(
  registered: readonly RegisteredHomebrewDeferredTree[],
  bindings: readonly BoundCollectionTree[],
): Map<string, RegisteredHomebrewDeferredTree> {
  if (registered.length !== bindings.length) {
    throw new Error("Homebrew registered tree count differs from its collection");
  }
  const byPackage = new Map<string, RegisteredHomebrewDeferredTree>();
  for (const tree of registered) {
    if (tree.package === undefined || byPackage.has(tree.package)) {
      throw new Error("Homebrew registered tree has invalid package ownership");
    }
    const binding = bindings.find((candidate) => candidate.package === tree.package);
    if (binding === undefined) {
      throw new Error(`Homebrew registered tree owns unexpected package ${tree.package}`);
    }
    assertRegisteredBinding(binding, tree);
    byPackage.set(tree.package, tree);
  }
  return byPackage;
}

function assertRegisteredBinding(
  binding: BoundCollectionTree,
  registered: RegisteredHomebrewDeferredTree,
): void {
  if (
    registered.package !== binding.package ||
    registered.id !== binding.tree.id ||
    registered.content.sha256 !== binding.tree.content.sha256 ||
    registered.content.bytes !== binding.tree.content.bytes
  ) {
    throw new Error(`Homebrew registered tree differs from ${binding.package}`);
  }
}

function createMaterializationEvidence(
  selection: HomebrewVfsMaterializationSelection,
  bindings: readonly BoundCollectionTree[],
  collectionFs: MemoryFileSystem,
  mirrorPlanAsset: HomebrewBottleMirrorPlanAsset,
  mirrorPlan: HomebrewBottleMirrorPlan,
): HomebrewVfsMaterializationEvidence {
  const mirrorByPackage = new Map(
    mirrorPlan.assets.map((asset) => [asset.package, asset]),
  );
  const toIdentity = (pkg: HomebrewVfsPackagePlan) => {
    const binding = bindings.find((candidate) => candidate.package === pkg.fullName)!;
    return {
      package: binding.package,
      treeId: binding.tree.id,
      sha256: binding.tree.content.sha256,
      bytes: binding.tree.content.bytes,
    };
  };
  const embeddedSet = new Set(selection.embeddedPackages.map((pkg) => pkg.fullName));
  const embeddedEntries = bindings
    .filter((binding) => embeddedSet.has(binding.package))
    .flatMap((binding) => binding.tree.inventory.entries)
    .map((entry): MaterializedEntryEvidence => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      ...(entry.target === undefined ? {} : { target: entry.target }),
      ...(entry.type === "file" || entry.type === "hardlink"
        ? { sha256: digest(readVfsFile(collectionFs, `/${entry.path}`)) }
        : {}),
    }));
  return {
    embedded: selection.embeddedPackages.map(toIdentity),
    deferred: selection.deferredPackages.map((pkg) => {
      const identity = toIdentity(pkg);
      const mirror = mirrorByPackage.get(pkg.fullName);
      if (mirror === undefined) {
        throw new Error(`Homebrew materialization evidence omits mirror for ${pkg.fullName}`);
      }
      return { ...identity, url: mirror.url };
    }),
    mirrorPlan: {
      path: HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
      sha256: mirrorPlanAsset.sha256,
      bytes: mirrorPlanAsset.bytes.byteLength,
    },
    embeddedEntries,
  };
}

function writeHomebrewBottleMirrorPlan(
  fs: MemoryFileSystem,
  asset: HomebrewBottleMirrorPlanAsset,
): void {
  if (lstatOrNull(fs, HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH) !== null) {
    throw new Error(
      `refusing to replace existing Homebrew bottle mirror plan: ` +
        HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
    );
  }
  ensureStrictDirectory(fs, "/etc");
  ensureStrictDirectory(fs, "/etc/kandelo");
  writeVfsBinary(fs, HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH, asset.bytes, 0o644);
}

function ensureStrictDirectory(fs: MemoryFileSystem, path: string): void {
  const existing = lstatOrNull(fs, path);
  if (existing === null) {
    fs.mkdir(path, 0o755);
    return;
  }
  if ((existing.mode & S_IFMT) !== S_IFDIR) {
    throw new Error(`Homebrew bottle mirror plan parent is not a directory: ${path}`);
  }
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  if ((stat.mode & S_IFMT) !== S_IFREG) {
    throw new Error(`Homebrew materialization evidence expected a regular file: ${path}`);
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
      if (count <= 0) throw new Error(`short read while verifying ${path}`);
      offset += count;
    }
  } finally {
    fs.close(descriptor);
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

function entryTypeMode(type: HomebrewLazyLayerEntry["type"]): number {
  if (type === "directory") return S_IFDIR;
  if (type === "symlink") return S_IFLNK;
  return S_IFREG;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
