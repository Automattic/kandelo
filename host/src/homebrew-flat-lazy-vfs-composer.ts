import { createHash } from "node:crypto";

// @ts-ignore TS6059: this authoritative contract intentionally lives in web-libs.
import * as demoConfigContract from "../../web-libs/kandelo-session/src/demo-config";
// @ts-ignore TS6059: this authoritative contract intentionally lives in web-libs.
import * as shellConfigContract from "../../web-libs/kandelo-session/src/shell-config";

import { ABI_VERSION } from "./generated/abi";
import type {
  HomebrewBottleDescriptor,
} from "./homebrew-bottle-descriptor";
import {
  projectHomebrewBottleSelection,
} from "./homebrew-bottle-selection";
import {
  assertHomebrewBootstrapConsumerState,
  installHomebrewBootstrapConsumerState,
  prepareHomebrewBootstrapConsumerNamespace,
  type HomebrewBootstrapConsumerState,
} from "./homebrew-bootstrap-consumer";
import {
  assertHomebrewFlatVfsBaseClone,
  buildHomebrewVfsSelection,
  resolveHomebrewFlatLinkOwnership,
  type HomebrewFlatVfsBuildReport,
} from "./homebrew-vfs-builder";
import type { HomebrewFlatVfsPlan } from "./homebrew-vfs-planner";
import {
  projectHomebrewFlatOriginalBottleCollectionFromEagerProof,
} from "./homebrew-lazy-layer";
import {
  bindHomebrewOriginalBottleCollection,
  createHomebrewBottleMirrorBundle,
  createHomebrewPrefixAncestors,
  installBoundHomebrewOriginalBottleTrees,
  writeHomebrewBottleMirrorPlan,
  assertHomebrewBottleMirrorPlan,
  type BoundHomebrewOriginalBottleTree,
  type HomebrewBottleMirrorBundle,
} from "./homebrew-vfs-composer";
import { HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH } from "./homebrew-bottle-mirror-plan";
import {
  deriveFlatLazyCompositionPartition,
  parseHomebrewVfsMaterializationPolicy,
  type FlatLazyCompositionPartition,
} from "./homebrew-vfs-materialization-policy";
import {
  parseHomebrewRuntimeSupportPolicy,
  type HomebrewFlatRuntimeSupportPolicy,
} from "./homebrew-runtime-support";
import {
  assertSelectedHomebrewExtractionCommandAliases,
  installSelectedHomebrewExtractionCommandAliases,
  prepareHomebrewRuntimeSupport,
  selectHomebrewExtractionCommands,
  type PreparedHomebrewRuntimeSupport,
  type SelectedHomebrewExtractionCommand,
} from "./homebrew-runtime-support-materializer";
import {
  descriptorMaterializationPackage,
  prepareHomebrewKeg,
  releasePreparedHomebrewKegEntries,
} from "./homebrew-vfs-materializer";
import { resolveHomebrewVfsResourcePolicy } from "./homebrew-vfs-resource-policy";
import { populateShellRuntimeLayout } from "./shell-runtime-layout";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "./vfs/image-helpers";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "./vfs/memory-fs";
import type { VfsDeferredTreeUsage } from "./vfs/deferred-tree-limits";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
  registerPackageDeferredZipTree,
  type DerivedPackageDeferredZipTree,
} from "./vfs/package-deferred-tree";

const CREATED_BY = "host/src/homebrew-flat-lazy-vfs-composer.ts";
const HOMEBREW_FLAT_LAZY_KIND =
  "kandelo-homebrew-flat-selection-lazy-v1" as const;
const REPORT_KIND = "kandelo-homebrew-flat-lazy-vfs-report" as const;
const BOOTSTRAP_TREE_ID = "homebrew-bootstrap/source-tree";
const BOOTSTRAP_ARCHIVE = "homebrew-bootstrap.zip";
const SHELL_CONFIG_PATH = "/etc/kandelo/shell.json";
const DEMO_CONFIG_PATH = "/etc/kandelo/demo.json";
const HOMEBREW_PROFILE_PATH = "/etc/profile.d/kandelo-homebrew.sh";
const ABI = ABI_VERSION;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface HomebrewFlatLazyImageBinding {
  schema: 1;
  kind: typeof HOMEBREW_FLAT_LAZY_KIND;
  selection: {
    sha256: string;
    name: string;
    arch: "wasm32";
    kandeloAbi: number;
    requestedVfsFilename: "shell.vfs.zst";
    resourcePolicy: "kandelo-homebrew-vfs-main-shell-v1";
    linkPolicy: "kandelo-homebrew-link-ownership-v1";
    runtimeSupport: "kandelo-homebrew-bootstrap-v1";
  };
  materializationPolicySha256: string;
  runtimeSupportPolicySha256: string;
  mirror: {
    repository: string;
    tag: string;
    collectionSha256: string;
    planSha256: string;
    planBytes: number;
    assetCount: number;
  };
  partition: {
    embeddedPackageOrder: string[];
    deferredPackageOrder: string[];
    bootstrapPackage: string;
    runtimeCohortPackageOrder: string[];
  };
}

export interface HomebrewFlatLazyBaseImageBinding {
  sha256: string;
  bytes: number;
  kernelAbi: number;
}

export interface HomebrewFlatLazyShellConfigInput {
  config: { version: 1; path: string; argv: readonly string[] };
  source: Uint8Array;
}

export interface HomebrewFlatLazyDemoConfigInput {
  config: { version: 1; [key: string]: unknown };
  source: Uint8Array;
}

export interface ComposeHomebrewFlatLazyVfsOptions {
  materializationPolicyValue: unknown;
  materializationPolicyBytes: Uint8Array;
  runtimeSupportPolicyValue: unknown;
  runtimeSupportPolicyBytes: Uint8Array;
  /** Platform-only input authority; never mutated. */
  baseFs: MemoryFileSystem;
  /** Caller-owned clone of the platform base that receives the product. */
  outputFs: MemoryFileSystem;
  /** Fresh caller-owned namespace mutated by the complete eager proof. */
  scratchFs: MemoryFileSystem;
  baseImage: HomebrewFlatLazyBaseImageBinding;
  loadBottleBytes: (
    descriptor: HomebrewBottleDescriptor,
  ) => Uint8Array | Promise<Uint8Array>;
  bootstrapZipBytes: Uint8Array;
  bootstrapEnvironmentBytes: Uint8Array;
  mirrorRepository: string;
  shellConfig: HomebrewFlatLazyShellConfigInput;
  demoConfig: HomebrewFlatLazyDemoConfigInput;
  normalizeTimestampsMs: number;
}

export interface HomebrewFlatLazyTreeEvidence {
  package: string;
  id: string;
  sha256: string;
  bytes: number;
  transports: string[];
  inventorySha256: string;
  sourceInventorySha256: string;
  atomicGroup?: string;
}

export interface HomebrewFlatLazyEmbeddedEntryEvidence {
  path: string;
  type: "directory" | "file" | "symlink" | "hardlink";
  mode: number;
  size: number;
  sha256?: string;
  target?: string;
}

export interface HomebrewFlatLazyVfsReport {
  schema: 1;
  kind: typeof REPORT_KIND;
  selection: HomebrewFlatLazyImageBinding["selection"];
  policies: {
    materialization: { sha256: string; bytes: number };
    runtimeSupport: { sha256: string; bytes: number };
  };
  partition: {
    embeddedPackageOrder: string[];
    bootstrapPackage: string;
    ordinaryDeferredPackageOrder: string[];
    runtimeCohortPackageOrder: string[];
    deferredPackageOrder: string[];
  };
  eagerOwnership: {
    report: HomebrewFlatVfsBuildReport;
    authenticatedBottleOrder: string[];
    embeddedEntries: HomebrewFlatLazyEmbeddedEntryEvidence[];
  };
  mirror: HomebrewFlatLazyImageBinding["mirror"];
  deferredTrees: HomebrewFlatLazyTreeEvidence[];
  bootstrapSupport: {
    package: string;
    zip: { sha256: string; bytes: number };
    environment: { sha256: string; bytes: number };
    authenticatedTree: { sha256: string; bytes: number };
    registeredTree: { id: string; descriptorSha256: string; descriptorBytes: number };
  };
  runtimeCohort: {
    id: "homebrew-runtime-support";
    activationRoot: "/usr/bin/brew";
    capability: "homebrew:runtime";
    packageOrder: string[];
    treeIds: string[];
    bootstrapTreeId: string;
    extractionCommands: SelectedHomebrewExtractionCommand[];
  };
  lazyUsage: VfsDeferredTreeUsage;
  metadata: VfsImageMetadata;
  image: {
    sha256: string;
    bytes: number;
    capacity: { byteLength: number; maxByteLength: number };
  };
}

export interface HomebrewFlatLazyVfsCompositionResult {
  fs: MemoryFileSystem;
  imageBytes: Uint8Array;
  binding: HomebrewFlatLazyImageBinding;
  partition: FlatLazyCompositionPartition;
  mirrorBundle: HomebrewBottleMirrorBundle;
  bootstrapTree: DerivedPackageDeferredZipTree;
  bootstrapConsumer: HomebrewBootstrapConsumerState;
  report: HomebrewFlatLazyVfsReport;
}

/**
 * Compose the canonical lightweight shell from the sole active flat selection.
 * The complete eager pour remains private evidence; only the reviewed Bash
 * closure is materialized into the output.
 */
export async function composeHomebrewFlatLazyVfs(
  planValue: HomebrewFlatVfsPlan,
  optionsValue: ComposeHomebrewFlatLazyVfsOptions,
): Promise<HomebrewFlatLazyVfsCompositionResult> {
  const plan = deepFreeze(structuredClone(planValue) as HomebrewFlatVfsPlan);
  const options = snapshotOptions(optionsValue);
  assertDistinctFilesystems(options.baseFs, options.outputFs, options.scratchFs);
  assertBaseBinding(options.baseImage, plan.kandeloAbi);
  assertTimestamp(options.normalizeTimestampsMs);
  await options.baseFs.verifyImportedLazyAtomicGroupSeals();
  await options.outputFs.verifyImportedLazyAtomicGroupSeals();
  await options.scratchFs.verifyImportedLazyAtomicGroupSeals();
  assertPlatformLineage(options.baseFs, "base");
  assertPlatformLineage(options.outputFs, "output");
  assertPlatformLineage(options.scratchFs, "scratch");
  assertNoPendingState(options.baseFs, "base");
  assertNoPendingState(options.outputFs, "output");
  assertNoPendingState(options.scratchFs, "scratch");
  assertHomebrewFlatVfsBaseClone(
    options.baseFs,
    options.outputFs,
    "flat lazy output",
  );
  assertHomebrewFlatVfsBaseClone(
    options.baseFs,
    options.scratchFs,
    "flat lazy scratch",
  );

  const bottleBytes = new Map<string, Uint8Array>();
  const descriptorByName = new Map(
    plan.packages.map((descriptor) => [descriptor.fullName, descriptor]),
  );
  // This is deliberately the first composition operation. It authenticates
  // and pours the complete selection into the exact caller-owned scratch FS.
  const eagerProof = await buildHomebrewVfsSelection(plan, {
    baseFs: options.baseFs,
    targetFs: options.scratchFs,
    async loadBottleBytes(candidate) {
      const authoritative = descriptorByName.get(candidate.fullName);
      if (authoritative === undefined) {
        throw new Error(`flat lazy eager proof requested unknown ${candidate.fullName}`);
      }
      const loaded = await options.loadBottleBytes(structuredClone(authoritative));
      if (!(loaded instanceof Uint8Array)) {
        throw new Error(`flat lazy eager proof is missing ${authoritative.fullName}`);
      }
      const exact = Uint8Array.from(loaded);
      bottleBytes.set(authoritative.fullName, exact);
      return exact;
    },
  });
  if (eagerProof.fs !== options.scratchFs || bottleBytes.size !== plan.packages.length) {
    throw new Error("flat lazy eager ownership proof did not use every selected bottle");
  }

  // Policy parsing and role partitioning happen only after the full proof.
  const materializationPolicy = exactPolicyBytes(
    options.materializationPolicyValue,
    options.materializationPolicyBytes,
    parseHomebrewVfsMaterializationPolicy,
    "materialization",
  );
  const runtimePolicy = exactPolicyBytes(
    options.runtimeSupportPolicyValue,
    options.runtimeSupportPolicyBytes,
    parseHomebrewRuntimeSupportPolicy,
    "runtime-support",
  );
  const selection = projectHomebrewBottleSelection({
    schema: plan.schema,
    name: plan.name,
    arch: plan.arch,
    kandeloAbi: plan.kandeloAbi,
    bottles: plan.packages,
    requestedVfsFilename: plan.requestedVfsFilename,
    resourcePolicy: plan.resourcePolicy,
    linkPolicy: plan.linkPolicy,
    runtimeSupport: plan.runtimeSupport,
  }, { expectedAbi: ABI });
  const partition = deriveFlatLazyCompositionPartition(
    selection,
    materializationPolicy,
    runtimePolicy,
  );
  assertCanonicalProduct(plan, partition);

  const kegDescriptors = plan.packages.filter(
    (descriptor) => descriptor.materialization === "keg",
  );
  const collection = await projectHomebrewFlatOriginalBottleCollectionFromEagerProof(
    plan,
    {
      baseFs: options.baseFs,
      eagerProof,
      packages: kegDescriptors,
      loadBottleBytes: (descriptor) => {
        const bytes = bottleBytes.get(descriptor.fullName);
        return bytes === undefined ? undefined : Uint8Array.from(bytes);
      },
    },
  );
  const bindings = bindHomebrewOriginalBottleCollection(
    kegDescriptors,
    collection,
  );
  const bindingByPackage = new Map(
    bindings.map((binding) => [binding.package, binding]),
  );
  const deferredBindings = bindExactPackageOrder(
    bindingByPackage,
    partition.deferredPackageOrder,
    "deferred",
  );
  const mirrorBundle = createHomebrewBottleMirrorBundle(
    options.mirrorRepository,
    deferredBindings,
  );

  const bootstrapDescriptor = descriptorByName.get(partition.bootstrapPackage)!;
  const preparedBootstrap = prepareSelectedBootstrap(
    bootstrapDescriptor,
    bottleBytes.get(partition.bootstrapPackage)!,
    options.bootstrapZipBytes,
    options.bootstrapEnvironmentBytes,
    plan.resourcePolicy,
  );
  const bootstrapTree = deriveAtomicBootstrapTree(
    bootstrapDescriptor,
    preparedBootstrap,
    runtimePolicy,
  );

  populateShellRuntimeLayout(options.outputFs);
  createHomebrewPrefixAncestors(options.outputFs, { packages: kegDescriptors });
  const runtimeSet = new Set(partition.runtimeCohortPackageOrder);
  const baseBindings = bindings.filter((binding) => !runtimeSet.has(binding.package));
  await installBoundHomebrewOriginalBottleTrees({
    fs: options.outputFs,
    id: "main-shell",
    bindings: baseBindings,
    embeddedPackageOrder: partition.embeddedPackageOrder,
    mirrorPlan: mirrorBundle.plan,
  });
  const runtimeBindings = bindExactPackageOrder(
    bindingByPackage,
    partition.runtimeCohortPackageOrder,
    "runtime cohort",
  );
  await installBoundHomebrewOriginalBottleTrees({
    fs: options.outputFs,
    id: runtimePolicy.id,
    bindings: runtimeBindings,
    mirrorPlan: mirrorBundle.plan,
    atomicActivationGroup: runtimePolicy.activation.atomicGroup,
  });
  writeHomebrewBottleMirrorPlan(options.outputFs, mirrorBundle.planAsset);

  prepareHomebrewBootstrapConsumerNamespace(options.outputFs, bootstrapTree);
  registerPackageDeferredZipTree(options.outputFs, bootstrapTree);
  const bootstrapConsumer = installHomebrewBootstrapConsumerState(
    options.outputFs,
    bootstrapTree,
    preparedBootstrap.environmentBytes,
  );
  const runtimeTreeIds = runtimeBindings.map((binding) => binding.tree.id);
  await options.outputFs.sealLazyAtomicGroup(
    runtimePolicy.activation.atomicGroup,
    [...runtimeTreeIds, bootstrapTree.descriptor.id],
  );
  assertPackageDeferredZipTreeState(options.outputFs, bootstrapTree, "deferred");
  const extractionCommands = selectHomebrewExtractionCommands(
    plan.packages,
    resolveHomebrewFlatLinkOwnership(plan.packages, plan.linkPolicy)
      .selectedOwnerByTarget,
  );
  installSelectedHomebrewExtractionCommandAliases(
    options.outputFs,
    extractionCommands,
    "deferred",
  );
  installSelectedShellAliases(options.outputFs, bindingByPackage, partition);
  installFlatProfile(options.outputFs, eagerProof.report.environment.PATH);
  const shellBinding = installShellConfig(options.outputFs, options.shellConfig);
  const demoBinding = installDemoConfig(options.outputFs, options.demoConfig);

  const binding = createImageBinding(
    plan,
    partition,
    mirrorBundle,
    digest(options.materializationPolicyBytes),
    digest(options.runtimeSupportPolicyBytes),
  );
  const packageDeferredTrees = [packageTreeBinding(bootstrapTree)];
  const capacity = filesystemCapacity(options.outputFs);
  const expectedCapacity = resolveHomebrewVfsResourcePolicy(
    plan.resourcePolicy,
  ).vfs.maxByteLength;
  if (capacity.maxByteLength !== expectedCapacity) {
    throw new Error(
      `flat lazy output capacity ${capacity.maxByteLength} differs from ${expectedCapacity}`,
    );
  }
  const metadata: VfsImageMetadata = {
    version: 1,
    kernelAbi: plan.kandeloAbi,
    createdBy: CREATED_BY,
    capacity: { maxByteLength: expectedCapacity },
    baseImage: options.baseImage,
    shellConfig: shellBinding,
    demoConfig: demoBinding,
    packageDeferredTrees,
    homebrewBootstrap: bootstrapConsumer,
    homebrewFlatLazy: binding,
  };
  options.outputFs.setImageMetadata(metadata);

  const embeddedEntries = createEmbeddedEvidence(
    partition,
    bindingByPackage,
    options.scratchFs,
  );
  const deferredTrees = createDeferredTreeEvidence(
    options.outputFs,
    partition,
    bindingByPackage,
    mirrorBundle,
  );
  const reportWithoutImage = {
    schema: 1 as const,
    kind: REPORT_KIND,
    selection: binding.selection,
    policies: {
      materialization: {
        sha256: binding.materializationPolicySha256,
        bytes: options.materializationPolicyBytes.byteLength,
      },
      runtimeSupport: {
        sha256: binding.runtimeSupportPolicySha256,
        bytes: options.runtimeSupportPolicyBytes.byteLength,
      },
    },
    partition: copyPartition(partition),
    eagerOwnership: {
      report: eagerProof.report,
      authenticatedBottleOrder: plan.packages.map((descriptor) => descriptor.fullName),
      embeddedEntries,
    },
    mirror: binding.mirror,
    deferredTrees,
    bootstrapSupport: {
      package: bootstrapDescriptor.fullName,
      zip: {
        sha256: digest(preparedBootstrap.zipBytes),
        bytes: preparedBootstrap.zipBytes.byteLength,
      },
      environment: {
        sha256: digest(preparedBootstrap.environmentBytes),
        bytes: preparedBootstrap.environmentBytes.byteLength,
      },
      authenticatedTree: {
        sha256: preparedBootstrap.tree.descriptorSha256,
        bytes: preparedBootstrap.tree.descriptorBytes.byteLength,
      },
      registeredTree: {
        id: bootstrapTree.descriptor.id,
        descriptorSha256: bootstrapTree.descriptorSha256,
        descriptorBytes: bootstrapTree.descriptorBytes.byteLength,
      },
    },
    runtimeCohort: {
      id: runtimePolicy.id,
      activationRoot: runtimePolicy.activation.root,
      capability: runtimePolicy.activation.capability,
      packageOrder: [...partition.runtimeCohortPackageOrder],
      treeIds: runtimeTreeIds,
      bootstrapTreeId: bootstrapTree.descriptor.id,
      extractionCommands: extractionCommands.map((command) => ({ ...command })),
    },
    lazyUsage: options.outputFs.pendingDeferredTreeUsage(),
    metadata,
  };
  assertFlatLazyState(options.outputFs, reportWithoutImage, bootstrapTree, bootstrapConsumer);

  const imageBytes = await options.outputFs.saveImage({
    normalizeTimestampsMs: options.normalizeTimestampsMs,
  });
  const imageCapacity = MemoryFileSystem.readImageCapacity(imageBytes);
  const report: HomebrewFlatLazyVfsReport = {
    ...reportWithoutImage,
    image: {
      sha256: digest(imageBytes),
      bytes: imageBytes.byteLength,
      capacity: imageCapacity,
    },
  };
  const restored = MemoryFileSystem.fromImagePreservingCapacity(imageBytes);
  await restored.verifyImportedLazyAtomicGroupSeals();
  assertHomebrewFlatLazyVfs(restored, report, bootstrapTree, bootstrapConsumer);
  return {
    fs: options.outputFs,
    imageBytes,
    binding,
    partition,
    mirrorBundle,
    bootstrapTree,
    bootstrapConsumer,
    report,
  };
}

/** Prove exact lineage and pending state on a live or restored composition. */
export function assertHomebrewFlatLazyVfs(
  fs: MemoryFileSystem,
  report: HomebrewFlatLazyVfsReport,
  bootstrapTree: DerivedPackageDeferredZipTree,
  bootstrapConsumer: HomebrewBootstrapConsumerState,
): void {
  assertFlatLazyState(fs, report, bootstrapTree, bootstrapConsumer);
  const capacity = filesystemCapacity(fs);
  if (
    capacity.byteLength !== report.image.capacity.byteLength ||
    capacity.maxByteLength !== report.image.capacity.maxByteLength
  ) {
    throw new Error("flat lazy restored filesystem capacity changed");
  }
}

function assertFlatLazyState(
  fs: MemoryFileSystem,
  report: Omit<HomebrewFlatLazyVfsReport, "image"> | HomebrewFlatLazyVfsReport,
  bootstrapTree: DerivedPackageDeferredZipTree,
  bootstrapConsumer: HomebrewBootstrapConsumerState,
): void {
  const metadata = fs.getImageMetadata();
  if (canonical(metadata) !== canonical(report.metadata)) {
    throw new Error("flat lazy image metadata changed or has mixed lineage fields");
  }
  expectExactKeys(metadata!, [
    "baseImage", "capacity", "createdBy", "demoConfig", "homebrewBootstrap",
    "homebrewFlatLazy", "kernelAbi", "packageDeferredTrees", "shellConfig", "version",
  ], "flat lazy image metadata");
  for (const retired of ["homebrewFlat", "homebrew", "shellComposition", "catalog"]) {
    if (Object.hasOwn(metadata!, retired)) {
      throw new Error(`flat lazy image mixes retired lineage ${retired}`);
    }
  }
  assertFlatLazyMetadataBinding(
    fs,
    metadata!,
    report,
    bootstrapTree,
    bootstrapConsumer,
  );
  const mirrorPlan = readMirrorPlan(fs);
  assertHomebrewBottleMirrorPlan(mirrorPlan);
  const imageBinding = metadata!.homebrewFlatLazy as HomebrewFlatLazyImageBinding;
  if (
    mirrorPlan.repository !== imageBinding.mirror.repository ||
    mirrorPlan.tag !== imageBinding.mirror.tag ||
    mirrorPlan.collection_sha256 !== imageBinding.mirror.collectionSha256 ||
    mirrorPlan.assets.length !== imageBinding.mirror.assetCount
  ) {
    throw new Error("flat lazy mirror plan differs from its image binding");
  }
  if (
    digest(readVfsBinary(fs, HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH)) !==
      report.mirror.planSha256
  ) {
    throw new Error("flat lazy mirror plan bytes changed");
  }
  assertPackageDeferredZipTreeState(fs, bootstrapTree, "deferred");
  assertHomebrewBootstrapConsumerState(fs, bootstrapConsumer);
  const pending = fs.exportLazyArchiveEntries();
  const bottleTrees = pending.flatMap((tree) => {
    const capabilities = tree.activation?.capabilities.filter((item) =>
      item.startsWith("homebrew-bottle:")
    ) ?? [];
    if (capabilities.length === 0) return [];
    if (capabilities.length !== 1) {
      throw new Error("flat lazy pending bottle tree has ambiguous identity");
    }
    return [{ id: capabilities[0]!.slice("homebrew-bottle:".length), tree }];
  });
  const mirrorByPackage = new Map(
    mirrorPlan.assets.map((asset) => [asset.package, asset]),
  );
  if (
    bottleTrees.length !== report.deferredTrees.length ||
    mirrorPlan.assets.length !== report.deferredTrees.length ||
    mirrorByPackage.size !== report.deferredTrees.length ||
    new Set(report.deferredTrees.map((tree) => tree.package)).size !==
      report.deferredTrees.length ||
    new Set(report.deferredTrees.map((tree) => tree.id)).size !==
      report.deferredTrees.length
  ) {
    throw new Error("flat lazy pending bottle-tree mirror binding changed");
  }
  for (const expected of report.deferredTrees) {
    const actual = bottleTrees.find(({ id }) => id === expected.id)?.tree;
    const asset = mirrorByPackage.get(expected.package);
    if (
      asset === undefined ||
      asset.package !== expected.package ||
      asset.id !== expected.id ||
      asset.sha256 !== expected.sha256 ||
      asset.bytes !== expected.bytes ||
      expected.transports[0] !== asset.url ||
      actual === undefined ||
      actual.content?.sha256 !== expected.sha256 ||
      actual.content.bytes !== expected.bytes ||
      canonical(actual.content.transports) !== canonical(expected.transports) ||
      digestJson(actual.inventory) !== expected.inventorySha256 ||
      digestJson(actual.content.source) !== expected.sourceInventorySha256 ||
      actual.activation?.atomicGroup?.id !== expected.atomicGroup
    ) {
      throw new Error(
        `flat lazy pending tree differs from its mirror plan for ${expected.package}`,
      );
    }
  }
  const expectedAtomic = [
    ...report.runtimeCohort.treeIds,
    report.runtimeCohort.bootstrapTreeId,
  ].sort();
  const actualAtomic = pending.flatMap((tree) => {
    const membership = tree.activation?.atomicGroup;
    if (membership?.id !== report.runtimeCohort.id) return [];
    if (
      membership.expectedCount !== expectedAtomic.length ||
      !SHA256_RE.test(membership.descriptorSha256 ?? "") ||
      !SHA256_RE.test(membership.cohortSha256 ?? "")
    ) {
      throw new Error("flat lazy runtime cohort is unsealed");
    }
    return [membership.member];
  }).sort();
  if (canonical(actualAtomic) !== canonical(expectedAtomic)) {
    throw new Error("flat lazy runtime cohort membership changed");
  }
  if (canonical(fs.pendingDeferredTreeUsage()) !== canonical(report.lazyUsage)) {
    throw new Error("flat lazy pending resource usage changed");
  }
  for (const entry of report.eagerOwnership.embeddedEntries) {
    assertEmbeddedEntry(fs, entry);
  }
  for (const path of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
    assertEagerExecutable(fs, path, `flat lazy shell alias ${path}`);
  }
  assertSelectedHomebrewExtractionCommandAliases(
    fs,
    report.runtimeCohort.extractionCommands,
    "deferred",
  );
  if (!fs.isPathDeferred(report.runtimeCohort.activationRoot)) {
    throw new Error("flat lazy Homebrew entrypoint lost deferred activation binding");
  }
  if (pathExists(fs, "/opt/kandelo/homebrew/Cellar/homebrew-bootstrap")) {
    throw new Error("flat lazy image contains the bootstrap keg");
  }
}

function assertFlatLazyMetadataBinding(
  fs: MemoryFileSystem,
  metadata: VfsImageMetadata,
  report: Omit<HomebrewFlatLazyVfsReport, "image"> | HomebrewFlatLazyVfsReport,
  bootstrapTree: DerivedPackageDeferredZipTree,
  bootstrapConsumer: HomebrewBootstrapConsumerState,
): void {
  if (
    metadata.version !== 1 ||
    metadata.kernelAbi !== ABI ||
    metadata.createdBy !== CREATED_BY
  ) {
    throw new Error("flat lazy image metadata has the wrong schema, ABI, or creator");
  }
  const binding = exactObject(
    metadata.homebrewFlatLazy,
    [
      "kind",
      "materializationPolicySha256",
      "mirror",
      "partition",
      "runtimeSupportPolicySha256",
      "schema",
      "selection",
    ],
    "flat lazy image binding",
  ) as unknown as HomebrewFlatLazyImageBinding;
  const selection = exactObject(
    binding.selection,
    [
      "arch",
      "kandeloAbi",
      "linkPolicy",
      "name",
      "requestedVfsFilename",
      "resourcePolicy",
      "runtimeSupport",
      "sha256",
    ],
    "flat lazy selection binding",
  );
  const mirror = exactObject(
    binding.mirror,
    [
      "assetCount",
      "collectionSha256",
      "planBytes",
      "planSha256",
      "repository",
      "tag",
    ],
    "flat lazy mirror binding",
  );
  const partition = exactObject(
    binding.partition,
    [
      "bootstrapPackage",
      "deferredPackageOrder",
      "embeddedPackageOrder",
      "runtimeCohortPackageOrder",
    ],
    "flat lazy partition binding",
  );
  if (
    binding.schema !== 1 ||
    binding.kind !== HOMEBREW_FLAT_LAZY_KIND ||
    canonical(selection) !== canonical(report.selection) ||
    !SHA256_RE.test(binding.materializationPolicySha256) ||
    !SHA256_RE.test(binding.runtimeSupportPolicySha256) ||
    binding.materializationPolicySha256 !== report.policies.materialization.sha256 ||
    binding.runtimeSupportPolicySha256 !== report.policies.runtimeSupport.sha256 ||
    canonical(mirror) !== canonical(report.mirror) ||
    canonical(partition) !== canonical({
      embeddedPackageOrder: report.partition.embeddedPackageOrder,
      deferredPackageOrder: report.partition.deferredPackageOrder,
      bootstrapPackage: report.partition.bootstrapPackage,
      runtimeCohortPackageOrder: report.partition.runtimeCohortPackageOrder,
    })
  ) {
    throw new Error("flat lazy metadata binding differs from its report");
  }
  if (
    report.selection.name !== "main-shell-abi42-wasm32" ||
    report.selection.arch !== "wasm32" ||
    report.selection.kandeloAbi !== ABI ||
    report.selection.requestedVfsFilename !== "shell.vfs.zst" ||
    report.selection.resourcePolicy !== "kandelo-homebrew-vfs-main-shell-v1" ||
    report.selection.linkPolicy !== "kandelo-homebrew-link-ownership-v1" ||
    report.selection.runtimeSupport !== "kandelo-homebrew-bootstrap-v1" ||
    !SHA256_RE.test(report.selection.sha256)
  ) {
    throw new Error("flat lazy selection binding is not canonical");
  }
  assertBoundPartition(report);

  const baseImage = exactObject(
    metadata.baseImage,
    ["bytes", "kernelAbi", "sha256"],
    "flat lazy base-image binding",
  );
  if (
    !SHA256_RE.test(String(baseImage.sha256)) ||
    !Number.isSafeInteger(baseImage.bytes) || Number(baseImage.bytes) <= 0 ||
    baseImage.kernelAbi !== ABI
  ) {
    throw new Error("flat lazy base-image binding is invalid");
  }
  const capacity = exactObject(
    metadata.capacity,
    ["maxByteLength"],
    "flat lazy capacity binding",
  );
  if (
    capacity.maxByteLength !==
      resolveHomebrewVfsResourcePolicy(report.selection.resourcePolicy).vfs.maxByteLength ||
    capacity.maxByteLength !== filesystemCapacity(fs).maxByteLength
  ) {
    throw new Error("flat lazy capacity binding changed");
  }
  const shell = exactObject(
    metadata.shellConfig,
    ["argv", "bytes", "path", "sha256"],
    "flat lazy shell-config binding",
  );
  assertBoundConfig(fs, shell, SHELL_CONFIG_PATH, "shell");
  const demo = exactObject(
    metadata.demoConfig,
    ["bytes", "path", "sha256"],
    "flat lazy demo-config binding",
  );
  assertBoundConfig(fs, demo, DEMO_CONFIG_PATH, "demo");
  if (
    canonical(metadata.homebrewBootstrap) !== canonical(bootstrapConsumer) ||
    canonical(metadata.packageDeferredTrees) !==
      canonical([packageTreeBinding(bootstrapTree)])
  ) {
    throw new Error("flat lazy bootstrap metadata binding changed");
  }
}

function assertBoundPartition(
  report: Omit<HomebrewFlatLazyVfsReport, "image"> | HomebrewFlatLazyVfsReport,
): void {
  const partition = report.partition;
  if (
    partition.embeddedPackageOrder.length !== 3 ||
    partition.deferredPackageOrder.length !== 37 ||
    partition.runtimeCohortPackageOrder.length !== 2 ||
    partition.ordinaryDeferredPackageOrder.length !== 35 ||
    canonical(partition.deferredPackageOrder) !== canonical([
      ...partition.ordinaryDeferredPackageOrder,
      ...partition.runtimeCohortPackageOrder,
    ].sort((left, right) =>
      report.eagerOwnership.authenticatedBottleOrder.indexOf(left) -
      report.eagerOwnership.authenticatedBottleOrder.indexOf(right)
    ))
  ) {
    throw new Error("flat lazy report partition is incomplete or overlapping");
  }
  const roles = [
    ...partition.embeddedPackageOrder,
    partition.bootstrapPackage,
    ...partition.ordinaryDeferredPackageOrder,
    ...partition.runtimeCohortPackageOrder,
  ];
  if (
    new Set(roles).size !== roles.length ||
    report.eagerOwnership.authenticatedBottleOrder.length !== roles.length ||
    new Set(report.eagerOwnership.authenticatedBottleOrder).size !== roles.length ||
    roles.some((name) =>
      !report.eagerOwnership.authenticatedBottleOrder.includes(name)
    ) ||
    report.eagerOwnership.authenticatedBottleOrder.some((name) =>
      !roles.includes(name)
    )
  ) {
    throw new Error("flat lazy report roles do not cover selection exactly");
  }
}

function assertBoundConfig(
  fs: MemoryFileSystem,
  binding: Record<string, unknown>,
  expectedPath: string,
  label: string,
): void {
  if (
    typeof binding.path !== "string" ||
    label === "demo" && binding.path !== expectedPath ||
    !SHA256_RE.test(String(binding.sha256)) ||
    !Number.isSafeInteger(binding.bytes) || Number(binding.bytes) <= 0
  ) {
    throw new Error(`flat lazy ${label} config binding is invalid`);
  }
  const bytes = readVfsBinary(fs, expectedPath);
  if (
    bytes.byteLength !== binding.bytes ||
    digest(bytes) !== binding.sha256
  ) {
    throw new Error(`flat lazy ${label} config bytes changed`);
  }
  if (
    label === "shell" &&
      bytes.byteLength > shellConfigContract.MAX_KANDELO_SHELL_CONFIG_BYTES ||
    label === "demo" &&
      bytes.byteLength > demoConfigContract.MAX_KANDELO_DEMO_CONFIG_BYTES
  ) {
    throw new Error(`flat lazy ${label} config binding exceeds its byte cap`);
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (label === "shell") {
    const config = shellConfigContract.parseKandeloShellConfig(source);
    if (
      config === null ||
      config.path !== binding.path ||
      canonical(config.argv) !== canonical(binding.argv)
    ) {
      throw new Error("flat lazy shell config binding is invalid");
    }
  } else {
    const config = demoConfigContract.parseKandeloDemoConfig(source);
    if (config === null) throw new Error("flat lazy demo config binding is invalid");
    demoConfigContract.validateKandeloDemoConfig(config);
  }
}

function exactObject(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  expectExactKeys(value as Record<string, unknown>, keys, label);
  return value as Record<string, unknown>;
}

function prepareSelectedBootstrap(
  descriptor: HomebrewBottleDescriptor,
  bottleBytes: Uint8Array,
  providedZip: Uint8Array,
  providedEnvironment: Uint8Array,
  resourcePolicy: HomebrewFlatVfsPlan["resourcePolicy"],
): PreparedHomebrewRuntimeSupport {
  const policy = resolveHomebrewVfsResourcePolicy(resourcePolicy);
  const preparedKeg = prepareHomebrewKeg(
    descriptorMaterializationPackage(descriptor),
    bottleBytes,
    {
      tarLimits: {
        maxCompressedBytes: policy.bottle.maxCompressedBytes,
        maxUncompressedBytes: policy.bottle.maxExpandedBytes,
        maxEntries: policy.bottle.maxEntries,
        maxPathBytes: policy.bottle.maxPathBytes,
        maxLinkBytes: policy.bottle.maxLinkBytes,
      },
      expectedDependencies: descriptor.dependencies,
      requireExactKegContainment: true,
    },
  );
  try {
    const prepared = prepareHomebrewRuntimeSupport(
      descriptor,
      preparedKeg,
      policy.supportZip,
    );
    assertExactBytes(providedZip, prepared.zipBytes, "bootstrap ZIP");
    assertExactBytes(
      providedEnvironment,
      prepared.environmentBytes,
      "bootstrap environment",
    );
    return prepared;
  } finally {
    releasePreparedHomebrewKegEntries(preparedKeg);
  }
}

function deriveAtomicBootstrapTree(
  descriptor: HomebrewBottleDescriptor,
  prepared: PreparedHomebrewRuntimeSupport,
  runtimePolicy: HomebrewFlatRuntimeSupportPolicy,
): DerivedPackageDeferredZipTree {
  return derivePackageDeferredZipTree({
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: BOOTSTRAP_TREE_ID,
    content_role: "source-tree",
    package: { name: descriptor.name, output: BOOTSTRAP_ARCHIVE },
    archive: { url: BOOTSTRAP_ARCHIVE, mode_policy: "portable-posix-v1" },
    mount_prefix: descriptor.prefix,
    owner: { uid: 1000, gid: 1000 },
    activation: {
      mode: "first-use",
      capabilities: ["homebrew:bootstrap", runtimePolicy.activation.capability],
      roots: [`${descriptor.prefix}/bin/brew`],
      atomic_group: runtimePolicy.activation.atomicGroup,
    },
  }, prepared.zipBytes);
}

function installSelectedShellAliases(
  fs: MemoryFileSystem,
  bindingByPackage: ReadonlyMap<string, BoundHomebrewOriginalBottleTree>,
  partition: FlatLazyCompositionPartition,
): void {
  const bashPackage = partition.embeddedPackageOrder.at(-1)!;
  if (!bashPackage.endsWith("/bash")) {
    throw new Error("flat lazy embedded root is not Bash");
  }
  const binding = bindingByPackage.get(bashPackage);
  if (binding === undefined) throw new Error("flat lazy Bash tree is absent");
  const bashLink = binding.tree.inventory.entries.find(
    (entry) => entry.path === "opt/kandelo/homebrew/bin/bash",
  );
  if (bashLink?.type !== "symlink") {
    throw new Error("flat lazy selected Bash does not own bin/bash");
  }
  const source = "/opt/kandelo/homebrew/bin/bash";
  assertEagerExecutable(fs, source, "selected Homebrew Bash");
  for (const target of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
    const existing = lstatOrNull(fs, target);
    if (existing !== null) {
      if (
        (existing.mode & S_IFMT) === S_IFLNK &&
        fs.readlink(target) === source &&
        existing.uid === 0 && existing.gid === 0
      ) continue;
      if (fs.isPathDeferred(target)) {
        fs.unlink(target);
      } else {
        throw new Error(`flat lazy shell alias conflicts with existing ${target}`);
      }
    }
    fs.symlinkWithOwner(source, target, 0, 0);
  }
}

function installFlatProfile(fs: MemoryFileSystem, path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("flat lazy eager proof has no Homebrew PATH");
  }
  ensureDirRecursive(fs, "/etc/profile.d");
  writeExclusiveText(
    fs,
    HOMEBREW_PROFILE_PATH,
    `export PATH="${path}:$PATH"\n`,
    0o644,
  );
}

function installShellConfig(
  fs: MemoryFileSystem,
  input: HomebrewFlatLazyShellConfigInput,
) {
  const source = exactConfigSource(
    input.config,
    input.source,
    shellConfigContract.MAX_KANDELO_SHELL_CONFIG_BYTES,
    "shell config",
  );
  const config = shellConfigContract.parseKandeloShellConfig(source);
  if (config === null || canonical(config) !== canonical(input.config)) {
    throw new Error("flat lazy shell config is invalid");
  }
  assertEagerExecutable(fs, config.path, "flat lazy default shell");
  writeExclusiveBinary(fs, SHELL_CONFIG_PATH, input.source, 0o644);
  return {
    path: config.path,
    argv: [...config.argv],
    sha256: digest(input.source),
    bytes: input.source.byteLength,
  };
}

function installDemoConfig(
  fs: MemoryFileSystem,
  input: HomebrewFlatLazyDemoConfigInput,
) {
  const source = exactConfigSource(
    input.config,
    input.source,
    demoConfigContract.MAX_KANDELO_DEMO_CONFIG_BYTES,
    "demo config",
  );
  const config = demoConfigContract.parseKandeloDemoConfig(source);
  if (config === null || canonical(config) !== canonical(input.config)) {
    throw new Error("flat lazy demo config is invalid");
  }
  demoConfigContract.validateKandeloDemoConfig(config);
  writeExclusiveBinary(fs, DEMO_CONFIG_PATH, input.source, 0o644);
  return {
    path: DEMO_CONFIG_PATH,
    sha256: digest(input.source),
    bytes: input.source.byteLength,
  };
}

function createImageBinding(
  plan: HomebrewFlatVfsPlan,
  partition: FlatLazyCompositionPartition,
  mirror: HomebrewBottleMirrorBundle,
  materializationPolicySha256: string,
  runtimeSupportPolicySha256: string,
): HomebrewFlatLazyImageBinding {
  return {
    schema: 1,
    kind: HOMEBREW_FLAT_LAZY_KIND,
    selection: {
      sha256: plan.selectionSha256,
      name: plan.name,
      arch: "wasm32",
      kandeloAbi: plan.kandeloAbi,
      requestedVfsFilename: "shell.vfs.zst",
      resourcePolicy: "kandelo-homebrew-vfs-main-shell-v1",
      linkPolicy: plan.linkPolicy,
      runtimeSupport: plan.runtimeSupport,
    },
    materializationPolicySha256,
    runtimeSupportPolicySha256,
    mirror: {
      repository: mirror.plan.repository,
      tag: mirror.plan.tag,
      collectionSha256: mirror.plan.collection_sha256,
      planSha256: mirror.planAsset.sha256,
      planBytes: mirror.planAsset.bytes.byteLength,
      assetCount: mirror.plan.assets.length,
    },
    partition: {
      embeddedPackageOrder: [...partition.embeddedPackageOrder],
      deferredPackageOrder: [...partition.deferredPackageOrder],
      bootstrapPackage: partition.bootstrapPackage,
      runtimeCohortPackageOrder: [...partition.runtimeCohortPackageOrder],
    },
  };
}

function createEmbeddedEvidence(
  partition: FlatLazyCompositionPartition,
  bindings: ReadonlyMap<string, BoundHomebrewOriginalBottleTree>,
  scratchFs: MemoryFileSystem,
): HomebrewFlatLazyEmbeddedEntryEvidence[] {
  return partition.embeddedPackageOrder.flatMap((packageName) => {
    const binding = bindings.get(packageName)!;
    return binding.tree.inventory.entries.map((entry) => ({
      path: `/${entry.path}`,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      ...(entry.target === undefined ? {} : { target: entry.target }),
      ...(entry.type === "file" || entry.type === "hardlink"
        ? { sha256: digest(readVfsBinary(scratchFs, `/${entry.path}`)) }
        : {}),
    }));
  });
}

function createDeferredTreeEvidence(
  fs: MemoryFileSystem,
  partition: FlatLazyCompositionPartition,
  bindings: ReadonlyMap<string, BoundHomebrewOriginalBottleTree>,
  mirror: HomebrewBottleMirrorBundle,
): HomebrewFlatLazyTreeEvidence[] {
  const pending = fs.exportLazyArchiveEntries();
  const mirrorByPackage = new Map(
    mirror.plan.assets.map((asset) => [asset.package, asset]),
  );
  return partition.deferredPackageOrder.map((packageName) => {
    const binding = bindings.get(packageName)!;
    const actual = pending.find((tree) =>
      tree.activation?.capabilities.includes(`homebrew-bottle:${binding.tree.id}`)
    );
    const asset = mirrorByPackage.get(packageName);
    if (actual?.content === undefined || actual.inventory === undefined || asset === undefined) {
      throw new Error(`flat lazy evidence omits deferred tree ${packageName}`);
    }
    const bottleCapabilities = actual.activation?.capabilities.filter((capability) =>
      capability.startsWith("homebrew-bottle:")
    ) ?? [];
    if (
      bottleCapabilities.length !== 1 ||
      bottleCapabilities[0] !== `homebrew-bottle:${binding.tree.id}` ||
      asset.package !== packageName ||
      asset.id !== binding.tree.id ||
      asset.sha256 !== actual.content.sha256 ||
      asset.bytes !== actual.content.bytes ||
      actual.content.transports[0] !== asset.url
    ) {
      throw new Error(
        `flat lazy deferred tree ${packageName} differs from its mirror plan`,
      );
    }
    return {
      package: packageName,
      id: binding.tree.id,
      sha256: actual.content.sha256,
      bytes: actual.content.bytes,
      transports: [...actual.content.transports],
      inventorySha256: digestJson(actual.inventory),
      sourceInventorySha256: digestJson(actual.content.source),
      ...(partition.runtimeCohortPackageOrder.includes(packageName)
        ? { atomicGroup: "homebrew-runtime-support" }
        : {}),
    };
  });
}

function packageTreeBinding(tree: DerivedPackageDeferredZipTree) {
  const descriptor = tree.descriptor;
  return {
    schema: descriptor.schema,
    kind: descriptor.kind,
    id: descriptor.id,
    content_role: descriptor.content_role,
    package: descriptor.package,
    descriptor: {
      sha256: tree.descriptorSha256,
      bytes: tree.descriptorBytes.byteLength,
    },
    archive: {
      output: descriptor.package.output,
      url: descriptor.archive.url,
      sha256: descriptor.archive.sha256,
      bytes: descriptor.archive.bytes,
      expanded_bytes: descriptor.archive.expanded_bytes,
      source_entry_count: descriptor.archive.source_entry_count,
    },
    mount_prefix: descriptor.mount_prefix,
    owner: descriptor.owner,
    activation: descriptor.activation,
    state: "deferred" as const,
  };
}

function assertCanonicalProduct(
  plan: HomebrewFlatVfsPlan,
  partition: FlatLazyCompositionPartition,
): void {
  if (
    plan.name !== "main-shell-abi42-wasm32" ||
    plan.arch !== "wasm32" ||
    plan.kandeloAbi !== ABI ||
    plan.requestedVfsFilename !== "shell.vfs.zst" ||
    plan.resourcePolicy !== "kandelo-homebrew-vfs-main-shell-v1" ||
    partition.embeddedPackageOrder.length !== 3 ||
    partition.deferredPackageOrder.length !== 37 ||
    partition.runtimeCohortPackageOrder.length !== 2 ||
    partition.ordinaryDeferredPackageOrder.length !== 35
  ) {
    throw new Error("flat lazy plan is not the canonical 3/1/2/35 shell product");
  }
}

function bindExactPackageOrder(
  bindings: ReadonlyMap<string, BoundHomebrewOriginalBottleTree>,
  order: readonly string[],
  label: string,
): BoundHomebrewOriginalBottleTree[] {
  return order.map((packageName) => {
    const binding = bindings.get(packageName);
    if (binding === undefined) {
      throw new Error(`flat lazy ${label} omits ${packageName}`);
    }
    return binding;
  });
}

function copyPartition(partition: FlatLazyCompositionPartition) {
  return {
    embeddedPackageOrder: [...partition.embeddedPackageOrder],
    bootstrapPackage: partition.bootstrapPackage,
    ordinaryDeferredPackageOrder: [...partition.ordinaryDeferredPackageOrder],
    runtimeCohortPackageOrder: [...partition.runtimeCohortPackageOrder],
    deferredPackageOrder: [...partition.deferredPackageOrder],
  };
}

function snapshotOptions(
  value: ComposeHomebrewFlatLazyVfsOptions,
): ComposeHomebrewFlatLazyVfsOptions {
  return {
    ...value,
    materializationPolicyValue: structuredClone(value.materializationPolicyValue),
    materializationPolicyBytes: Uint8Array.from(value.materializationPolicyBytes),
    runtimeSupportPolicyValue: structuredClone(value.runtimeSupportPolicyValue),
    runtimeSupportPolicyBytes: Uint8Array.from(value.runtimeSupportPolicyBytes),
    baseImage: structuredClone(value.baseImage),
    bootstrapZipBytes: Uint8Array.from(value.bootstrapZipBytes),
    bootstrapEnvironmentBytes: Uint8Array.from(value.bootstrapEnvironmentBytes),
    shellConfig: {
      config: structuredClone(value.shellConfig.config),
      source: Uint8Array.from(value.shellConfig.source),
    },
    demoConfig: {
      config: structuredClone(value.demoConfig.config),
      source: Uint8Array.from(value.demoConfig.source),
    },
  };
}

function exactPolicyBytes<T>(
  value: unknown,
  bytes: Uint8Array,
  parse: (value: unknown) => T,
  label: string,
): T {
  let bytesValue: unknown;
  try {
    bytesValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`flat lazy ${label} policy bytes are not UTF-8 JSON`);
  }
  const fromValue = parse(value);
  const fromBytes = parse(bytesValue);
  if (canonical(fromValue) !== canonical(fromBytes)) {
    throw new Error(`flat lazy ${label} policy value differs from its bytes`);
  }
  return fromBytes;
}

function exactConfigSource(
  value: unknown,
  bytes: Uint8Array,
  maxBytes: number,
  label: string,
): string {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error(`flat lazy ${label} exceeds ${maxBytes} bytes`);
  }
  let source: string;
  let parsed: unknown;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`flat lazy ${label} bytes are not UTF-8 JSON`);
  }
  if (canonical(parsed) !== canonical(value)) {
    throw new Error(`flat lazy ${label} value differs from its bytes`);
  }
  return source;
}

function assertDistinctFilesystems(...filesystems: MemoryFileSystem[]): void {
  if (new Set(filesystems).size !== filesystems.length) {
    throw new Error("flat lazy base, output, and scratch filesystems must be distinct");
  }
  if (new Set(filesystems.map((fs) => fs.sharedBuffer)).size !== filesystems.length) {
    throw new Error("flat lazy base, output, and scratch buffers must be distinct");
  }
}

function assertPlatformLineage(fs: MemoryFileSystem, label: string): void {
  const metadata = fs.getImageMetadata();
  if (metadata === null || metadata.kernelAbi !== ABI) {
    throw new Error(`flat lazy ${label} filesystem does not declare ABI ${ABI}`);
  }
  for (const field of [
    "homebrewFlatLazy", "homebrewFlat", "homebrew", "shellComposition",
    "packageDeferredTrees", "homebrewBootstrap", "catalog", "tap",
    "migrationLock",
  ]) {
    if (Object.hasOwn(metadata, field)) {
      throw new Error(`flat lazy ${label} filesystem has mixed lineage ${field}`);
    }
  }
  if (pathExists(fs, "/etc/kandelo/homebrew-vfs.json")) {
    throw new Error(`flat lazy ${label} filesystem already contains Homebrew state`);
  }
}

function assertNoPendingState(fs: MemoryFileSystem, label: string): void {
  if (fs.exportLazyEntries().length !== 0 || fs.exportLazyArchiveEntries().length !== 0) {
    throw new Error(`flat lazy ${label} filesystem contains pending state`);
  }
}

function assertBaseBinding(binding: HomebrewFlatLazyBaseImageBinding, abi: number): void {
  if (!SHA256_RE.test(binding.sha256) || !Number.isSafeInteger(binding.bytes) ||
      binding.bytes <= 0 || binding.kernelAbi !== abi) {
    throw new Error("flat lazy base-image identity is invalid");
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("flat lazy deterministic timestamp is invalid");
  }
}

function assertExactBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (actual.byteLength !== expected.byteLength ||
      actual.some((byte, index) => byte !== expected[index])) {
    throw new Error(`flat lazy provided ${label} differs from selected support output`);
  }
}

function assertEmbeddedEntry(
  fs: MemoryFileSystem,
  entry: HomebrewFlatLazyEmbeddedEntryEvidence,
): void {
  if (fs.isPathDeferred(entry.path)) {
    throw new Error(`flat lazy embedded path remains deferred: ${entry.path}`);
  }
  const stat = fs.lstat(entry.path);
  const expectedType = entry.type === "directory" ? S_IFDIR
    : entry.type === "symlink" ? S_IFLNK : S_IFREG;
  if ((stat.mode & S_IFMT) !== expectedType ||
      (stat.mode & 0o7777) !== entry.mode ||
      (entry.type !== "directory" && stat.size !== entry.size)) {
    throw new Error(`flat lazy embedded path changed: ${entry.path}`);
  }
  if (entry.type === "symlink" && fs.readlink(entry.path) !== entry.target) {
    throw new Error(`flat lazy embedded symlink changed: ${entry.path}`);
  }
  if ((entry.type === "file" || entry.type === "hardlink") &&
      digest(readVfsBinary(fs, entry.path)) !== entry.sha256) {
    throw new Error(`flat lazy embedded file changed: ${entry.path}`);
  }
}

function assertEagerExecutable(fs: MemoryFileSystem, path: string, label: string): void {
  if (fs.isPathDeferred(path)) throw new Error(`${label} is deferred`);
  const stat = fs.stat(path);
  if ((stat.mode & S_IFMT) !== S_IFREG || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} is not an executable regular file`);
  }
}

function writeExclusiveBinary(
  fs: MemoryFileSystem,
  path: string,
  bytes: Uint8Array,
  mode: number,
): void {
  if (pathExists(fs, path)) throw new Error(`refusing to replace ${path}`);
  writeVfsBinary(fs, path, bytes, mode);
}

function writeExclusiveText(
  fs: MemoryFileSystem,
  path: string,
  text: string,
  mode: number,
): void {
  if (pathExists(fs, path)) throw new Error(`refusing to replace ${path}`);
  writeVfsFile(fs, path, text, mode);
}

function readMirrorPlan(fs: MemoryFileSystem): Parameters<typeof assertHomebrewBottleMirrorPlan>[0] {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      readVfsBinary(fs, HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH),
    ));
  } catch (error) {
    throw new Error("flat lazy mirror plan is not valid JSON", { cause: error });
  }
}

function readVfsBinary(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  if ((stat.mode & S_IFMT) !== S_IFREG) {
    throw new Error(`flat lazy evidence expected a regular file: ${path}`);
  }
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (count <= 0) throw new Error(`short read from ${path}`);
      offset += count;
    }
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function filesystemCapacity(fs: MemoryFileSystem) {
  const stats = fs.statfs("/");
  return {
    byteLength: fs.sharedBuffer.byteLength,
    maxByteLength: stats.blocks * stats.bsize,
  };
}

function pathExists(fs: MemoryFileSystem, path: string): boolean {
  return lstatOrNull(fs, path) !== null;
}

function lstatOrNull(fs: MemoryFileSystem, path: string) {
  try {
    return fs.lstat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === -2) {
      return null;
    }
    throw error;
  }
}

function expectExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function digestJson(value: unknown): string {
  return digest(new TextEncoder().encode(canonical(value)));
}

function canonical(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
