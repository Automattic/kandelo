#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseHomebrewRuntimeSupportPolicy } from "../host/src/homebrew-runtime-support";
import { parseCanonicalHomebrewBottleSelection } from "../host/src/homebrew-bottle-selection";
import {
  deriveFlatLazyCompositionPartition,
  parseHomebrewVfsMaterializationPolicy,
} from "../host/src/homebrew-vfs-materialization-policy";
import { HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH } from "../host/src/homebrew-bottle-mirror-plan";
import { ABI_VERSION } from "../host/src/generated/abi";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
} from "../host/src/vfs/package-deferred-tree";
import {
  assertPendingTreeHomebrewBottleMirrorBinding,
  decodeHomebrewBottleMirrorPlan,
} from "./homebrew-closed-lazy-assets";

export const HOMEBREW_MAIN_SHELL_PUBLIC_PRODUCT_KIND =
  "kandelo-homebrew-main-shell-public-product" as const;

export interface HomebrewMainShellPublicProduct {
  schema: 1;
  kind: typeof HOMEBREW_MAIN_SHELL_PUBLIC_PRODUCT_KIND;
  image: {
    sha256: string;
    bytes: number;
    kernel_abi: number;
  };
  homebrew_bootstrap: {
    sha256: string;
    bytes: number;
    activation_root: "/usr/bin/brew";
  };
  partition: {
    embedded_bottles: 3;
    bootstrap_trees: 1;
    runtime_cohort_bottles: 2;
    ordinary_deferred_bottles: 35;
    deferred_bottles: 37;
    initial_pending_trees: 38;
  };
  bottle_mirror: {
    repository: string;
    collection_sha256: string;
    tag: string;
    plan_url: string;
    plan_sha256: string;
    plan_bytes: number;
    asset_count: number;
  };
}

export async function inspectHomebrewMainShellPublicProduct(input: {
  imageBytes: Uint8Array;
  homebrewBootstrapArchiveBytes: Uint8Array;
  homebrewBootstrapSpec: unknown;
  selectionBytes: Uint8Array;
  materializationPolicyBytes: Uint8Array;
  runtimeSupportPolicyBytes: Uint8Array;
  checkedMirrorPlanBytes: Uint8Array;
}): Promise<HomebrewMainShellPublicProduct> {
  const imageBytes = nonemptyBytes(input.imageBytes, "main-shell VFS image");
  const bootstrapBytes = nonemptyBytes(
    input.homebrewBootstrapArchiveBytes,
    "Homebrew bootstrap archive",
  );
  const selectionBytes = nonemptyBytes(input.selectionBytes, "flat selection");
  const materializationPolicyBytes = nonemptyBytes(
    input.materializationPolicyBytes,
    "materialization policy",
  );
  const runtimeSupportPolicyBytes = nonemptyBytes(
    input.runtimeSupportPolicyBytes,
    "runtime-support policy",
  );
  const checkedMirrorPlanBytes = nonemptyBytes(
    input.checkedMirrorPlanBytes,
    "checked mirror plan",
  );
  const selection = parseCanonicalHomebrewBottleSelection(selectionBytes, {
    expectedAbi: ABI_VERSION,
  });
  const materializationPolicy = parseHomebrewVfsMaterializationPolicy(
    parseJsonBytes(materializationPolicyBytes, "materialization policy"),
  );
  const runtimeSupport = parseHomebrewRuntimeSupportPolicy(
    parseJsonBytes(runtimeSupportPolicyBytes, "runtime-support policy"),
  );
  const partition = deriveFlatLazyCompositionPartition(
    selection,
    materializationPolicy,
    runtimeSupport,
  );
  const bootstrap = derivePackageDeferredZipTree(
    input.homebrewBootstrapSpec,
    bootstrapBytes,
  );
  if (
    bootstrap.descriptor.activation.atomicGroup?.id !==
      runtimeSupport.activation.atomicGroup ||
    !bootstrap.descriptor.activation.capabilities.includes(
      runtimeSupport.activation.capability,
    ) ||
    !bootstrap.descriptor.activation.capabilities.includes("homebrew:bootstrap")
  ) {
    throw new Error(
      "Homebrew bootstrap tree differs from the runtime-support activation group",
    );
  }

  const fs = MemoryFileSystem.fromImagePreservingCapacity(imageBytes);
  // WHY: a restored image's atomic-group digests are untrusted until this
  // bounded pass authenticates them. Synchronous metadata export deliberately
  // fails closed before that trust boundary.
  await fs.verifyImportedLazyAtomicGroupSeals();
  assertPackageDeferredZipTreeState(fs, bootstrap, "deferred");
  const activationRoot = runtimeSupport.activation.root;
  if (!fs.isPathDeferred(activationRoot)) {
    throw new Error(
      `${activationRoot} is not backed by the deferred Homebrew bootstrap tree`,
    );
  }
  const activationStat = fs.lstat(activationRoot);
  if (
    (activationStat.mode & 0xf000) !== 0xa000 ||
    !bootstrap.descriptor.activation.roots.includes(fs.readlink(activationRoot))
  ) {
    throw new Error(
      `${activationRoot} does not select the Homebrew bootstrap entrypoint`,
    );
  }

  const allPendingTrees = fs
    .exportLazyArchiveEntries()
    .filter((tree) => tree.content !== undefined);
  const bottleTrees = allPendingTrees.filter((tree) =>
    tree.activation?.capabilities.some((capability) =>
      capability.startsWith("homebrew-bottle:"),
    ),
  );
  const bootstrapTrees = allPendingTrees.filter((tree) =>
    tree.activation?.capabilities.includes("homebrew:bootstrap"),
  );
  const unknownTrees = allPendingTrees.filter(
    (tree) => !bottleTrees.includes(tree) && !bootstrapTrees.includes(tree),
  );
  if (bootstrapTrees.length !== 1 || unknownTrees.length !== 0) {
    throw new Error(
      "main-shell image has an unexpected deferred package-tree inventory",
    );
  }

  const metadata = fs.getImageMetadata();
  if (metadata === null || metadata.kernelAbi !== ABI_VERSION) {
    throw new Error(
      `main-shell image declares kernel ABI ${metadata?.kernelAbi ?? "none"}, ` +
        `expected ${ABI_VERSION}`,
    );
  }
  const flatBinding = record(
    metadata.homebrewFlatLazy,
    "flat lazy shell metadata binding",
  );
  const selectedPartition = record(
    flatBinding.partition,
    "flat lazy shell metadata partition",
  );
  if (
    !equalStrings(
      selectedPartition.embeddedPackageOrder,
      partition.embeddedPackageOrder,
    ) ||
    !equalStrings(
      selectedPartition.deferredPackageOrder,
      partition.deferredPackageOrder,
    ) ||
    selectedPartition.bootstrapPackage !== partition.bootstrapPackage ||
    !equalStrings(
      selectedPartition.runtimeCohortPackageOrder,
      partition.runtimeCohortPackageOrder,
    ) ||
    partition.embeddedPackageOrder.length !== 3 ||
    partition.runtimeCohortPackageOrder.length !== 2 ||
    partition.ordinaryDeferredPackageOrder.length !== 35 ||
    partition.deferredPackageOrder.length !== 37 ||
    allPendingTrees.length !== 38 ||
    bottleTrees.length !== 37
  ) {
    throw new Error(
      "flat lazy shell partition differs from the selected 3/1/2/35 product",
    );
  }

  const planBytes = readVfsFile(fs, HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH);
  const plan = decodeHomebrewBottleMirrorPlan(
    planBytes,
    HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
  );
  if (!equalBytes(planBytes, checkedMirrorPlanBytes)) {
    throw new Error(
      "embedded bottle mirror plan differs from the checked plan",
    );
  }
  const checkedPlan = decodeHomebrewBottleMirrorPlan(
    checkedMirrorPlanBytes,
    "checked mirror plan",
  );
  assertPendingTreeHomebrewBottleMirrorBinding(bottleTrees, plan);
  if (
    checkedPlan.assets.length !== 37 ||
    !sameStrings(
      checkedPlan.assets.map((asset) => asset.package),
      partition.deferredPackageOrder,
    )
  ) {
    throw new Error(
      "checked bottle mirror inventory differs from the selected deferred partition",
    );
  }

  return {
    schema: 1,
    kind: HOMEBREW_MAIN_SHELL_PUBLIC_PRODUCT_KIND,
    image: {
      sha256: sha256(imageBytes),
      bytes: imageBytes.byteLength,
      kernel_abi: metadata.kernelAbi,
    },
    homebrew_bootstrap: {
      sha256: sha256(bootstrapBytes),
      bytes: bootstrapBytes.byteLength,
      activation_root: activationRoot,
    },
    partition: {
      embedded_bottles: 3,
      bootstrap_trees: 1,
      runtime_cohort_bottles: 2,
      ordinary_deferred_bottles: 35,
      deferred_bottles: 37,
      initial_pending_trees: 38,
    },
    bottle_mirror: {
      repository: plan.repository,
      collection_sha256: plan.collection_sha256,
      tag: plan.tag,
      plan_url: `${plan.release_root}/${plan.manifest_asset}`,
      plan_sha256: sha256(planBytes),
      plan_bytes: planBytes.byteLength,
      asset_count: plan.assets.length,
    },
  };
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.lstat(path);
  if ((stat.mode & 0xf000) !== 0x8000 || stat.size <= 0) {
    throw new Error(`${path} is not a nonempty regular file`);
  }
  const output = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < output.byteLength) {
      const count = fs.read(
        fd,
        output.subarray(offset),
        null,
        output.byteLength - offset,
      );
      if (count <= 0) {
        throw new Error(`short read from ${path}`);
      }
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  return output;
}

function nonemptyBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${label} is empty`);
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRegularFile(path: string, label: string): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`${label} is not a nonempty regular file: ${path}`);
  }
  return new Uint8Array(readFileSync(path));
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function equalStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function sameStrings(
  value: readonly string[],
  expected: readonly string[],
): boolean {
  if (value.length !== expected.length) return false;
  const sortedValue = [...value].sort();
  const sortedExpected = [...expected].sort();
  return sortedValue.every((entry, index) => entry === sortedExpected[index]);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function parseArgs(args: string[]): {
  image: string;
  homebrewBootstrapArchive: string;
  homebrewBootstrapSpec: string;
  selection: string;
  materializationPolicy: string;
  runtimeSupportPolicy: string;
  mirrorPlan: string;
  output: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      ![
        "--image",
        "--homebrew-bootstrap-archive",
        "--homebrew-bootstrap-spec",
        "--selection",
        "--materialization-policy",
        "--runtime-support-policy",
        "--mirror-plan",
        "--out",
      ].includes(key) ||
      values.has(key)
    ) {
      usage();
    }
    values.set(key, value);
  }
  if (values.size !== 8) usage();
  return {
    image: resolve(values.get("--image")!),
    homebrewBootstrapArchive: resolve(
      values.get("--homebrew-bootstrap-archive")!,
    ),
    homebrewBootstrapSpec: resolve(values.get("--homebrew-bootstrap-spec")!),
    selection: resolve(values.get("--selection")!),
    materializationPolicy: resolve(values.get("--materialization-policy")!),
    runtimeSupportPolicy: resolve(values.get("--runtime-support-policy")!),
    mirrorPlan: resolve(values.get("--mirror-plan")!),
    output: resolve(values.get("--out")!),
  };
}

function usage(): never {
  throw new Error(
    "usage: npx tsx scripts/inspect-homebrew-main-shell-public-product.ts " +
      "--image <shell.vfs.zst> " +
      "--homebrew-bootstrap-archive <homebrew-bootstrap.zip> " +
      "--homebrew-bootstrap-spec <main-shell-brew-package-tree.json> " +
      "--selection <main-shell-flat-selection.json> " +
      "--materialization-policy <materialization-policy.json> " +
      "--runtime-support-policy <runtime-support-policy.json> " +
      "--mirror-plan <mirror-plan.json> --out <new-report.json>",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = parseArgs(process.argv.slice(2));
  const report = await inspectHomebrewMainShellPublicProduct({
    imageBytes: readRegularFile(options.image, "main-shell VFS image"),
    homebrewBootstrapArchiveBytes: readRegularFile(
      options.homebrewBootstrapArchive,
      "Homebrew bootstrap archive",
    ),
    homebrewBootstrapSpec: parseJsonBytes(
      readRegularFile(
        options.homebrewBootstrapSpec,
        "Homebrew bootstrap package-tree spec",
      ),
      "Homebrew bootstrap package-tree spec",
    ),
    selectionBytes: readRegularFile(options.selection, "flat selection"),
    materializationPolicyBytes: readRegularFile(
      options.materializationPolicy,
      "materialization policy",
    ),
    runtimeSupportPolicyBytes: readRegularFile(
      options.runtimeSupportPolicy,
      "runtime-support policy",
    ),
    checkedMirrorPlanBytes: readRegularFile(
      options.mirrorPlan,
      "checked mirror plan",
    ),
  });
  // WHY: Pages consumes this file as deployment authority. Refuse to replace
  // an earlier report so a stale or partially rerun step cannot be mistaken
  // for the product inspected in this invocation.
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
}
