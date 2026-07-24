import type { ClosedLazyAsset } from "../../host/src/vfs/closed-lazy-assets";
import {
  MemoryFileSystem,
  type SerializedLazyArchiveEntry,
} from "../../host/src/vfs/memory-fs";
import {
  parsePackageDeferredZipTreeSpec,
  type PackageDeferredZipTreeSpec,
} from "../../host/src/vfs/package-deferred-tree-contract";
import {
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  type HomebrewBottleMirrorPlan,
} from "../../host/src/homebrew-bottle-mirror-plan";
import {
  assertPendingTreeHomebrewBottleMirrorBinding,
  bytesEqual,
  decodeHomebrewBottleMirrorPlan,
} from "../../scripts/homebrew-closed-lazy-assets-contract";
import {
  assertHomebrewGuestLifecycleCatalog,
  resolveHomebrewGuestLifecycleShell,
} from "./homebrew_guest_lifecycle_runtime_contract";

export type HomebrewGuestLifecycleTransportMode = "closed" | "public";

export interface HomebrewGuestLifecycleRuntimeInputs {
  imageBytes: Uint8Array;
  shellPath: string;
  shellArgv0: string;
  /**
   * The host may transfer `imageBytes.buffer` only when it is one whole
   * ordinary ArrayBuffer and this flag is true.
   */
  takeImageOwnership?: boolean;
  lazyUrlBase: string;
  lazyAssets?: readonly ClosedLazyAsset[];
  bootstrapTransportUrl: string;
  bootstrapBytes: number;
}

export interface DeriveHomebrewGuestLifecycleRuntimeInputs {
  imageBytes: Uint8Array;
  /**
   * Run an additional exact-image validation against the same filesystem this
   * function restored from `imageBytes`. Accepting a caller-supplied
   * filesystem would let validation cover different bytes than the runtime.
   */
  validateImageFileSystem?: (fs: MemoryFileSystem) => void;
  takeImageOwnership?: boolean;
  bootstrapSpecBytes: Uint8Array;
  bootstrapArchiveBytes: Uint8Array;
  bootstrapArchiveSha256: string;
  bootstrapEnvironmentBytes: Uint8Array;
  coreRevision: string;
  transportMode: HomebrewGuestLifecycleTransportMode;
  lazyUrlBase: string;
  expectedBootstrapTransportUrl?: string;
  expectedEmbeddedBottlePlanBytes?: Uint8Array;
  validateEmbeddedBottlePlan?: (plan: HomebrewBottleMirrorPlan) => void;
  closedBottleAssets?: readonly ClosedLazyAsset[];
  loadClosedBottleAssets?: (
    embeddedPlanBytes: Uint8Array,
    pendingBottleTrees: readonly SerializedLazyArchiveEntry[],
  ) => readonly ClosedLazyAsset[];
}

const HOMEBREW_COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";
const SHA256_RE = /^[0-9a-f]{64}$/;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;

/**
 * Bind one lifecycle run to the same image, package tree, catalog, shell, and
 * bottle plan on Node and browser. Transport acquisition is host-specific;
 * acceptance of the acquired bytes is deliberately shared.
 */
export function deriveHomebrewGuestLifecycleRuntimeInputs(
  input: DeriveHomebrewGuestLifecycleRuntimeInputs,
): HomebrewGuestLifecycleRuntimeInputs {
  const bootstrapSpec = parsePackageDeferredZipTreeSpec(
    parseJson(
      input.bootstrapSpecBytes,
      "Homebrew bootstrap tree spec",
    ),
  );
  if (
    !SHA256_RE.test(input.bootstrapArchiveSha256) ||
    input.bootstrapArchiveBytes.byteLength === 0
  ) {
    throw new Error("Homebrew bootstrap archive identity is invalid");
  }
  const fs = MemoryFileSystem.fromImage(input.imageBytes);
  assertExactBytes(
    readVfsFile(fs, "/etc/homebrew/brew.env"),
    input.bootstrapEnvironmentBytes,
    "main-shell Homebrew environment",
  );
  const guestManifest = parseJson(
    readVfsFile(fs, HOMEBREW_COMPOSITION_PATH),
    HOMEBREW_COMPOSITION_PATH,
  );
  assertHomebrewGuestLifecycleCatalog(guestManifest, input.coreRevision);
  const shell = resolveHomebrewGuestLifecycleShell(fs);

  const pendingTrees = classifyPendingTrees(fs.exportLazyArchiveEntries());
  if (
    pendingTrees.bootstrap.length !== 1 ||
    pendingTrees.unclassified.length !== 0
  ) {
    throw new Error(
      `lifecycle image has ${pendingTrees.bootstrap.length} pending Homebrew ` +
        `source trees and ${pendingTrees.unclassified.length} unclassified ` +
        `package trees`,
    );
  }
  assertBootstrapTreeBinding(
    fs,
    pendingTrees.bootstrap[0]!,
    bootstrapSpec,
    input.bootstrapArchiveSha256,
    input.bootstrapArchiveBytes.byteLength,
  );

  const embeddedPlanBytes = readVfsFile(
    fs,
    HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  );
  if (
    input.expectedEmbeddedBottlePlanBytes !== undefined &&
    !bytesEqual(embeddedPlanBytes, input.expectedEmbeddedBottlePlanBytes)
  ) {
    throw new Error(
      "live bottle mirror plan differs from the exact VFS-embedded plan",
    );
  }
  const embeddedPlan = decodeHomebrewBottleMirrorPlan(
    embeddedPlanBytes,
    HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  );
  input.validateEmbeddedBottlePlan?.(embeddedPlan);
  if (pendingTrees.bottles.length !== embeddedPlan.assets.length) {
    throw new Error(
      `lifecycle image has ${pendingTrees.bottles.length} pending bottle ` +
        `trees, while its mirror plan declares ${embeddedPlan.assets.length}`,
    );
  }
  assertPendingTreeHomebrewBottleMirrorBinding(
    pendingTrees.bottles,
    embeddedPlan,
  );

  const bootstrapTransportUrl = new URL(
    bootstrapSpec.archive.url,
    input.lazyUrlBase,
  ).toString();
  if (
    input.expectedBootstrapTransportUrl !== undefined &&
    bootstrapTransportUrl !== input.expectedBootstrapTransportUrl
  ) {
    throw new Error(
      `Homebrew bootstrap transport resolves to ${bootstrapTransportUrl}, ` +
        `expected ${input.expectedBootstrapTransportUrl}`,
    );
  }

  const lazyAssets = bindClosedLifecycleAssets(
    input,
    embeddedPlan,
    embeddedPlanBytes,
    pendingTrees.bottles,
    bootstrapTransportUrl,
    input.bootstrapArchiveSha256,
    input.bootstrapArchiveBytes.byteLength,
  );
  input.validateImageFileSystem?.(fs);

  return {
    imageBytes: input.imageBytes,
    shellPath: shell.path,
    shellArgv0: shell.argv0,
    ...(input.takeImageOwnership === true
      ? { takeImageOwnership: true }
      : {}),
    lazyUrlBase: input.lazyUrlBase,
    ...(lazyAssets === undefined ? {} : { lazyAssets }),
    bootstrapTransportUrl,
    bootstrapBytes: input.bootstrapArchiveBytes.byteLength,
  };
}

function assertBootstrapTreeBinding(
  fs: MemoryFileSystem,
  tree: SerializedLazyArchiveEntry,
  spec: PackageDeferredZipTreeSpec,
  archiveSha256: string,
  archiveBytes: number,
): void {
  const content = tree.content;
  const inventory = tree.inventory;
  const inventoryBytes = inventory?.reduce(
    (total, entry) => total + entry.size,
    0,
  );
  if (
    spec.content_role !== "source-tree" ||
    (
      tree.kind !== "kandelo-deferred-tree-v1" &&
      tree.kind !== "kandelo-deferred-tree-v2"
    ) ||
    tree.materialized ||
    content === undefined ||
    inventory === undefined ||
    inventory.length === 0 ||
    tree.mountPrefix !== spec.mount_prefix ||
    tree.url !== spec.archive.url ||
    content.decoder !== "zip-v1" ||
    content.mediaType !== "application/zip" ||
    content.sha256 !== archiveSha256 ||
    content.bytes !== archiveBytes ||
    content.expandedBytes !== inventoryBytes ||
    content.sourceEntryCount !== inventory.length ||
    content.transports.length !== 1 ||
    content.transports[0] !== spec.archive.url ||
    content.modePolicy !== spec.archive.mode_policy ||
    content.source !== undefined ||
    JSON.stringify(tree.activation) !== JSON.stringify(spec.activation)
  ) {
    throw new Error(
      `Homebrew bootstrap deferred tree ${spec.id} changed descriptor: ` +
        `${JSON.stringify({
          kind: tree.kind,
          materialized: tree.materialized,
          mountPrefix: tree.mountPrefix,
          url: tree.url,
          content,
          inventoryBytes,
          inventoryLength: inventory?.length,
          activation: tree.activation,
        })}`,
    );
  }

  for (const entry of inventory) {
    if (entry.type === "hardlink") {
      throw new Error(
        `Homebrew bootstrap ZIP tree ${spec.id} contains a hardlink inventory entry`,
      );
    }
    const stat = fs.lstat(entry.vfsPath);
    const expectedType = entry.type === "directory"
      ? S_IFDIR
      : entry.type === "symlink"
        ? S_IFLNK
        : S_IFREG;
    if (
      (stat.mode & S_IFMT) !== expectedType ||
      (stat.mode & 0o7777) !== entry.mode ||
      stat.uid !== spec.owner.uid ||
      stat.gid !== spec.owner.gid ||
      (entry.type !== "directory" && stat.size !== entry.size) ||
      (entry.type === "file" && !fs.isPathDeferred(entry.vfsPath)) ||
      (
        entry.type === "symlink" &&
        fs.readlink(entry.vfsPath) !== entry.target
      )
    ) {
      throw new Error(
        `Homebrew bootstrap deferred tree ${spec.id} changed ${entry.vfsPath}`,
      );
    }
  }
}

function bindClosedLifecycleAssets(
  input: DeriveHomebrewGuestLifecycleRuntimeInputs,
  plan: HomebrewBottleMirrorPlan,
  embeddedPlanBytes: Uint8Array,
  pendingBottleTrees: readonly SerializedLazyArchiveEntry[],
  bootstrapTransportUrl: string,
  bootstrapSha256: string,
  bootstrapBytes: number,
): readonly ClosedLazyAsset[] | undefined {
  if (input.transportMode === "public") {
    if (
      input.closedBottleAssets !== undefined ||
      input.loadClosedBottleAssets !== undefined
    ) {
      throw new Error("public lifecycle transport cannot carry closed bottle bytes");
    }
    return undefined;
  }
  if (
    input.closedBottleAssets !== undefined &&
    input.loadClosedBottleAssets !== undefined
  ) {
    throw new Error(
      "closed lifecycle transport must have exactly one bottle-byte source",
    );
  }
  const closedBottleAssets = input.closedBottleAssets ??
    input.loadClosedBottleAssets?.(embeddedPlanBytes, pendingBottleTrees);
  if (closedBottleAssets === undefined) {
    throw new Error("closed lifecycle transport requires exact bottle bytes");
  }
  assertClosedBottleAssets(closedBottleAssets, plan);
  return [
    ...closedBottleAssets,
    {
      url: bootstrapTransportUrl,
      sha256: bootstrapSha256,
      size: bootstrapBytes,
      bytes: input.bootstrapArchiveBytes,
    },
  ];
}

function assertClosedBottleAssets(
  assets: readonly ClosedLazyAsset[],
  plan: HomebrewBottleMirrorPlan,
): void {
  if (assets.length !== plan.assets.length) {
    throw new Error(
      `closed bottle binding count ${assets.length} differs from mirror ` +
        `asset count ${plan.assets.length}`,
    );
  }
  const byUrl = new Map(assets.map((asset) => [asset.url, asset]));
  if (byUrl.size !== assets.length) {
    throw new Error("closed bottle bindings duplicate a release URL");
  }
  for (const expected of plan.assets) {
    const actual = byUrl.get(expected.url);
    if (
      actual === undefined ||
      actual.sha256 !== expected.sha256 ||
      actual.size !== expected.bytes ||
      actual.bytes.byteLength !== expected.bytes
    ) {
      throw new Error(
        `closed bottle binding does not match mirror asset ${expected.package}`,
      );
    }
  }
}

function classifyPendingTrees(entries: readonly SerializedLazyArchiveEntry[]): {
  bottles: SerializedLazyArchiveEntry[];
  bootstrap: SerializedLazyArchiveEntry[];
  unclassified: SerializedLazyArchiveEntry[];
} {
  const pending = entries.filter((tree) => tree.content !== undefined);
  for (const tree of pending) {
    const capabilities = tree.activation?.capabilities ?? [];
    const bottleCapabilities = capabilities.filter((capability) =>
      capability.startsWith("homebrew-bottle:")
    );
    if (
      bottleCapabilities.length > 1 ||
      (
        bottleCapabilities.length === 1 &&
        capabilities.includes("homebrew:bootstrap")
      )
    ) {
      throw new Error(
        `pending tree ${tree.mountPrefix} has ambiguous Homebrew ownership`,
      );
    }
  }
  const bottles = pending.filter((tree) =>
    tree.activation?.capabilities.some((capability) =>
      capability.startsWith("homebrew-bottle:")
    )
  );
  const bootstrap = pending.filter((tree) =>
    tree.activation?.capabilities.includes("homebrew:bootstrap")
  );
  const unclassified = pending.filter(
    (tree) => !bottles.includes(tree) && !bootstrap.includes(tree),
  );
  return { bottles, bootstrap, unclassified };
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`${path} is not a regular file`);
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
      if (count <= 0) {
        throw new Error(`${path} ended after ${offset}/${bytes.byteLength} bytes`);
      }
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON: ${String(error)}`);
  }
}

function assertExactBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string,
): void {
  if (
    actual.byteLength !== expected.byteLength ||
    !actual.every((byte, index) => byte === expected[index])
  ) {
    throw new Error(`${label} differs from the resolved package output`);
  }
}
