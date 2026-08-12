import { ABI_VERSION } from "./generated/abi";
import { parseHomebrewBottleMirrorPlan } from "./homebrew-bottle-mirror-browser";
import {
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  type HomebrewBottleMirrorAsset,
} from "./homebrew-bottle-mirror-plan";
import type { MemoryFileSystem } from "./vfs/memory-fs";

const HOMEBREW_FLAT_LAZY_KIND = "kandelo-homebrew-flat-selection-lazy-v1";
const RUNTIME_GROUP_ID = "homebrew-runtime-support";
const BOOTSTRAP_ENTRYPOINT = "/usr/bin/brew";
const BOOTSTRAP_TARGET = "/opt/kandelo/homebrew/bin/brew";
const BOTTLE_CAPABILITY_PREFIX = "homebrew-bottle:";
const BOOTSTRAP_TREE_ID = "homebrew-bootstrap/source-tree";
const SHA256_RE = /^[0-9a-f]{64}$/;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;

/**
 * Complete the flat lazy shell's policy-bound runtime cohort before the host
 * reports boot readiness. Atomic groups intentionally remain first-use in the
 * VFS registry; preparing the canonical public brew entrypoint delegates the
 * fetch, verification, and all-or-nothing commit to that existing machinery.
 */
export async function prepareHomebrewFlatLazyBoot(
  fs: MemoryFileSystem,
): Promise<number> {
  const metadata = fs.getImageMetadata();
  if (metadata === null || !Object.hasOwn(metadata, "homebrewFlatLazy")) {
    return 0;
  }
  const binding = assertCanonicalFlatLazyBootBinding(metadata);
  const mirrorBytes = readVfsBinary(fs, HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH);
  const mirrorPlan = await parseHomebrewBottleMirrorPlan(mirrorBytes);
  if (
    mirrorPlan.repository !== binding.mirror.repository ||
    mirrorPlan.tag !== binding.mirror.tag ||
    mirrorPlan.collection_sha256 !== binding.mirror.collectionSha256 ||
    mirrorPlan.assets.length !== binding.mirror.assetCount ||
    mirrorBytes.byteLength !== binding.mirror.planBytes ||
    await sha256(mirrorBytes) !== binding.mirror.planSha256
  ) {
    throw new Error("flat lazy shell mirror differs from its boot binding");
  }
  const assetByPackage = new Map(
    mirrorPlan.assets.map((asset) => [asset.package, asset]),
  );
  if (
    assetByPackage.size !== binding.deferredPackageOrder.length ||
    binding.deferredPackageOrder.some((packageName) =>
      assetByPackage.get(packageName) === undefined
    )
  ) {
    throw new Error("flat lazy shell mirror does not cover its deferred partition");
  }
  const runtimeAssets = binding.runtimeCohortPackageOrder.map((packageName) =>
    assetByPackage.get(packageName)!
  );
  const runtimeIds = runtimeAssets.map((asset) => asset.id).sort();
  const runtimeIdSet = new Set(runtimeIds);
  const ordinaryAssets = binding.deferredPackageOrder
    .filter((packageName) =>
      !binding.runtimeCohortPackageOrder.includes(packageName)
    )
    .map((packageName) => assetByPackage.get(packageName)!);
  const ordinaryIds = ordinaryAssets.map((asset) => asset.id).sort();
  if (runtimeIds.length !== 2 || ordinaryIds.length !== 35) {
    throw new Error("flat lazy shell mirror has the wrong runtime partition");
  }

  const pending = fs.exportLazyArchiveEntries();
  const bottleTrees = pending.flatMap((tree) => {
    const capabilities = bottleCapabilities(tree.activation?.capabilities);
    if (capabilities.length === 0) return [];
    if (capabilities.length !== 1) {
      throw new Error("flat lazy shell bottle tree has ambiguous identity");
    }
    return [{
      id: capabilities[0]!.slice(BOTTLE_CAPABILITY_PREFIX.length),
      tree,
    }];
  });
  assertPendingBottleMirrorBindings(bottleTrees, mirrorPlan.assets);
  const cohort = pending.filter(
    (tree) => tree.activation?.atomicGroup?.id === RUNTIME_GROUP_ID,
  );
  const ordinaryBottleIds = bottleTrees
    .filter(({ tree }) => tree.activation?.atomicGroup === undefined)
    .map(({ id }) => id)
    .sort();

  if (!fs.isPathDeferred(BOOTSTRAP_ENTRYPOINT)) {
    if (
      pending.length !== 35 ||
      cohort.length !== 0 ||
      bottleTrees.length !== 35 ||
      canonicalStrings(ordinaryBottleIds) !== canonicalStrings(ordinaryIds)
    ) {
      throw new Error(
        "flat lazy shell has an invalid completed runtime readiness state",
      );
    }
    assertExecutable(fs, BOOTSTRAP_ENTRYPOINT);
    return 0;
  }

  if (
    pending.length !== 38 ||
    bottleTrees.length !== 37 ||
    canonicalStrings(ordinaryBottleIds) !== canonicalStrings(ordinaryIds) ||
    cohort.length !== 3 ||
    canonicalStrings(bottleTrees.map(({ id }) => id).sort()) !==
      canonicalStrings([...ordinaryIds, ...runtimeIds].sort())
  ) {
    throw new Error("flat lazy shell omits its sealed boot runtime cohort");
  }
  const members = new Set<string>();
  const cohortDigests = new Set<string>();
  let bootstrapMembers = 0;
  for (const tree of cohort) {
    const membership = tree.activation?.atomicGroup;
    if (
      tree.activation?.mode !== "first-use" ||
      membership === undefined ||
      membership.expectedCount !== 3 ||
      !SHA256_RE.test(membership.descriptorSha256 ?? "") ||
      !SHA256_RE.test(membership.cohortSha256 ?? "") ||
      typeof membership.member !== "string" ||
      membership.member.length === 0
    ) {
      throw new Error("flat lazy shell runtime cohort is not sealed");
    }
    members.add(membership.member);
    cohortDigests.add(membership.cohortSha256!);
    const capabilities = tree.activation.capabilities;
    if (capabilities.includes("homebrew:bootstrap")) {
      bootstrapMembers += 1;
      if (
        capabilities.includes("homebrew:runtime") === false ||
        tree.activation.roots.includes(BOOTSTRAP_TARGET) === false ||
        membership.member !== BOOTSTRAP_TREE_ID ||
        bottleCapabilities(capabilities).length !== 0
      ) {
        throw new Error("flat lazy shell bootstrap member has changed");
      }
    } else {
      const bottleIdentity = bottleCapabilities(capabilities);
      if (
        bottleIdentity.length !== 1 ||
        bottleIdentity[0]!.slice(BOTTLE_CAPABILITY_PREFIX.length) !==
          membership.member ||
        !runtimeIdSet.has(membership.member)
      ) {
        throw new Error("flat lazy shell runtime cohort differs from its mirror");
      }
    }
  }
  if (
    canonicalStrings([...members].sort()) !==
      canonicalStrings([...runtimeIds, BOOTSTRAP_TREE_ID].sort()) ||
    cohortDigests.size !== 1 ||
    bootstrapMembers !== 1
  ) {
    throw new Error("flat lazy shell runtime cohort membership has changed");
  }

  const changed = await fs.preparePath(BOOTSTRAP_ENTRYPOINT);
  if (!changed || fs.isPathDeferred(BOOTSTRAP_ENTRYPOINT)) {
    throw new Error("flat lazy shell runtime cohort did not become ready");
  }
  const remaining = fs.exportLazyArchiveEntries();
  const remainingBottles = remaining.flatMap((tree) => {
    const capabilities = bottleCapabilities(tree.activation?.capabilities);
    return capabilities.length === 1
      ? [{ id: capabilities[0]!.slice(BOTTLE_CAPABILITY_PREFIX.length), tree }]
      : [];
  });
  assertPendingBottleMirrorBindings(remainingBottles, ordinaryAssets);
  const remainingBottleIds = remainingBottles.map(({ id }) => id).sort();
  if (
    remaining.length !== 35 ||
    remaining.some(
      (tree) => tree.activation?.atomicGroup?.id === RUNTIME_GROUP_ID,
    ) ||
    remainingBottles.length !== 35 ||
    canonicalStrings(remainingBottleIds) !== canonicalStrings(ordinaryIds)
  ) {
    throw new Error("flat lazy shell boot prepared a non-runtime bottle tree");
  }
  assertExecutable(fs, BOOTSTRAP_ENTRYPOINT);
  return 3;
}

function assertCanonicalFlatLazyBootBinding(
  metadata: Record<string, unknown>,
): {
  deferredPackageOrder: string[];
  runtimeCohortPackageOrder: string[];
  mirror: {
    repository: string;
    tag: string;
    collectionSha256: string;
    planSha256: string;
    planBytes: number;
    assetCount: number;
  };
} {
  const binding = record(metadata.homebrewFlatLazy, "flat lazy shell binding");
  const selection = record(binding.selection, "flat lazy shell selection");
  const partition = record(binding.partition, "flat lazy shell partition");
  const mirror = record(binding.mirror, "flat lazy shell mirror binding");
  const bootstrap = record(
    metadata.homebrewBootstrap,
    "flat lazy shell bootstrap binding",
  );
  const entrypoint = record(
    bootstrap.entrypoint,
    "flat lazy shell bootstrap entrypoint",
  );
  if (
    binding.schema !== 1 ||
    binding.kind !== HOMEBREW_FLAT_LAZY_KIND ||
    selection.name !== "main-shell-abi42-wasm32" ||
    selection.arch !== "wasm32" ||
    selection.kandeloAbi !== ABI_VERSION ||
    selection.requestedVfsFilename !== "shell.vfs.zst" ||
    selection.resourcePolicy !== "kandelo-homebrew-vfs-main-shell-v1" ||
    selection.linkPolicy !== "kandelo-homebrew-link-ownership-v1" ||
    selection.runtimeSupport !== "kandelo-homebrew-bootstrap-v1" ||
    !SHA256_RE.test(typeof selection.sha256 === "string" ? selection.sha256 : "") ||
    !stringArrayOfLength(partition.embeddedPackageOrder, 3) ||
    !stringArrayOfLength(partition.deferredPackageOrder, 37) ||
    !stringArrayOfLength(partition.runtimeCohortPackageOrder, 2) ||
    !(partition.runtimeCohortPackageOrder as string[]).every((packageName) =>
      (partition.deferredPackageOrder as string[]).includes(packageName)
    ) ||
    typeof mirror.repository !== "string" ||
    mirror.repository.length === 0 ||
    typeof mirror.tag !== "string" ||
    mirror.tag.length === 0 ||
    !SHA256_RE.test(typeof mirror.collectionSha256 === "string"
      ? mirror.collectionSha256
      : "") ||
    !SHA256_RE.test(typeof mirror.planSha256 === "string"
      ? mirror.planSha256
      : "") ||
    !Number.isSafeInteger(mirror.planBytes) ||
    Number(mirror.planBytes) <= 0 ||
    mirror.assetCount !== 37 ||
    entrypoint.path !== BOOTSTRAP_ENTRYPOINT ||
    entrypoint.target !== BOOTSTRAP_TARGET
  ) {
    throw new Error("flat lazy shell boot binding is not canonical");
  }
  return {
    deferredPackageOrder: [...partition.deferredPackageOrder as string[]],
    runtimeCohortPackageOrder: [
      ...partition.runtimeCohortPackageOrder as string[],
    ],
    mirror: {
      repository: mirror.repository as string,
      tag: mirror.tag as string,
      collectionSha256: mirror.collectionSha256 as string,
      planSha256: mirror.planSha256 as string,
      planBytes: mirror.planBytes as number,
      assetCount: mirror.assetCount as number,
    },
  };
}

function assertPendingBottleMirrorBindings(
  bottleTrees: Array<{
    id: string;
    tree: ReturnType<MemoryFileSystem["exportLazyArchiveEntries"]>[number];
  }>,
  assets: readonly HomebrewBottleMirrorAsset[],
): void {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  if (
    assetById.size !== assets.length ||
    new Set(bottleTrees.map(({ id }) => id)).size !== bottleTrees.length
  ) {
    throw new Error("flat lazy shell pending bottle identities are ambiguous");
  }
  for (const { id, tree } of bottleTrees) {
    const asset = assetById.get(id);
    if (
      asset === undefined ||
      tree.content?.sha256 !== asset.sha256 ||
      tree.content.bytes !== asset.bytes ||
      tree.content.transports.length !== 1 ||
      tree.content.transports[0] !== asset.url
    ) {
      throw new Error("flat lazy shell pending bottle differs from its mirror");
    }
  }
}

function bottleCapabilities(capabilities: readonly string[] | undefined): string[] {
  return capabilities?.filter((value) => value.startsWith(BOTTLE_CAPABILITY_PREFIX)) ?? [];
}

function stringArrayOfLength(value: unknown, length: number): value is string[] {
  return Array.isArray(value) && value.length === length &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === "string" && item.length !== 0);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function readVfsBinary(fs: MemoryFileSystem, path: string): Uint8Array {
  if (fs.isPathDeferred(path)) {
    throw new Error(`flat lazy shell boot binding is deferred: ${path}`);
  }
  const stat = fs.stat(path);
  if ((stat.mode & S_IFMT) !== S_IFREG) {
    throw new Error(`flat lazy shell boot binding is not a file: ${path}`);
  }
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0) throw new Error(`short read from ${path}`);
      offset += count;
    }
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function canonicalStrings(values: readonly string[]): string {
  return JSON.stringify(values);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertExecutable(fs: MemoryFileSystem, path: string): void {
  const stat = fs.stat(path);
  if ((stat.mode & S_IFMT) !== S_IFREG || (stat.mode & 0o111) === 0) {
    throw new Error(`flat lazy shell readiness path is not executable: ${path}`);
  }
}
