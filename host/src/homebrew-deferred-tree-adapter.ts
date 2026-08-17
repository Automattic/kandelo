/**
 * Validate authenticated Homebrew bottle policy, then erase it into the
 * generic VFS deferred-tree contract.
 */

import {
  createHomebrewBottleRelocationRecipe,
  deriveHomebrewBottleDestinationPrefix,
  HOMEBREW_BOTTLE_RELOCATION_RECIPE_ID,
  parseHomebrewInstallReceiptRelocation,
} from "./homebrew-bottle-relocation";
import type {
  HomebrewDeferredTreeDescriptor,
  HomebrewDeferredTreeSourceEntry,
} from "./homebrew-lazy-layer-descriptor";
import type {
  LazyTreeDecoder,
  LazyTreeRegistrationEntry,
  LazyTreeSourceInventory,
} from "./vfs/memory-fs";
import {
  decodeMaterializationBytes,
  validateLazyTreeMaterializationPlan,
  type LazyTreeMaterializationPlan,
} from "./vfs/materialization-plan";

export interface AdaptedHomebrewDeferredTree {
  decoder: LazyTreeDecoder;
  source?: LazyTreeSourceInventory;
  materialization?: LazyTreeMaterializationPlan;
  entries: LazyTreeRegistrationEntry[];
}

/** Validate all bottle policy before returning only generic VFS inputs. */
export function adaptHomebrewDeferredTree(
  tree: HomebrewDeferredTreeDescriptor,
): AdaptedHomebrewDeferredTree {
  const entries = tree.inventory.entries.map(homebrewEntryToGenericEntry);
  if (tree.content.decoder === "zip-v1") {
    if (
      tree.inventory.source !== undefined ||
      tree.inventory.relocation !== undefined ||
      tree.inventory.entries.some((entry) => entry.materialization !== undefined)
    ) {
      throw new Error("Homebrew ZIP tree carries original-bottle policy");
    }
    return { decoder: "zip-v1", entries };
  }

  const source = homebrewSourceToGenericInventory(tree);
  const sourceByPath = new Map(
    tree.inventory.source!.entries.map((entry) => [entry.path, entry]),
  );
  const canonicalByPath = resolveHomebrewSourceHardlinks(
    tree.inventory.source!.entries,
    sourceByPath,
  );
  const receiptSources = tree.inventory.source!.entries.filter((entry) =>
    entry.path === "INSTALL_RECEIPT.json" ||
    entry.path.endsWith("/INSTALL_RECEIPT.json")
  );
  const relocationEntries = tree.inventory.entries.filter((entry) =>
    entry.materialization === "archive-homebrew-relocate"
  );
  const relocation = parseHomebrewRelocation(tree.inventory.relocation, source);
  if (relocation === undefined) {
    if (receiptSources.length > 0 || relocationEntries.length > 0) {
      throw new Error(
        "Homebrew bottle receipt relocation requires a schema-6 adapter plan",
      );
    }
    return { decoder: "tar-gzip-v1", source, entries };
  }
  if (receiptSources.length !== 1) {
    throw new Error(
      `Homebrew bottle has ${receiptSources.length} INSTALL_RECEIPT.json ` +
        "source members, expected one",
    );
  }
  const receiptSource = receiptSources[0]!;
  if (relocation.receiptSourcePath !== receiptSource.path) {
    throw new Error("Homebrew bottle relocation names a different receipt source");
  }
  const receiptCanonical = receiptSource.type === "file"
    ? receiptSource
    : canonicalByPath.get(receiptSource.path);
  if (receiptCanonical?.type !== "file") {
    throw new Error("Homebrew bottle INSTALL_RECEIPT.json is not regular");
  }
  if (
    relocation.materialization.assertions.length !== 1 ||
    relocation.materialization.assertions[0]!.sourcePath !== receiptCanonical.path
  ) {
    throw new Error(
      "Homebrew bottle plan does not assert its canonical receipt bytes",
    );
  }
  const receipt = parseHomebrewInstallReceiptRelocation(
    decodeMaterializationBytes(
      relocation.materialization.assertions[0]!.bytesHex,
    ),
  );
  const receiptGuests = tree.inventory.entries.filter((entry) =>
    entry.source_path === receiptSource.path &&
    (entry.materialization === "archive" ||
      entry.materialization === "archive-homebrew-relocate") &&
    `/${entry.path}`.endsWith(`/Cellar/${receiptSource.path}`)
  );
  if (receiptGuests.length !== 1) {
    throw new Error(
      "Homebrew bottle cannot identify one authenticated receipt destination",
    );
  }
  // WHY: these two paths are authenticated by the descriptor. Deriving the
  // prefix here prevents an ambient runtime default from changing bottle bytes.
  const destinationPrefix = deriveHomebrewBottleDestinationPrefix(
    `/${receiptGuests[0]!.path}`,
    receiptSource.path,
  );
  const relativePrefix = destinationPrefix.slice(1);
  for (const entry of tree.inventory.entries) {
    if (
      entry.path !== relativePrefix &&
      !entry.path.startsWith(`${relativePrefix}/`)
    ) {
      throw new Error(
        `Homebrew bottle entry /${entry.path} escapes its receipt prefix`,
      );
    }
    if (
      (entry.materialization === "archive" ||
        entry.materialization === "archive-homebrew-relocate") &&
      `/${entry.path}` !== `${destinationPrefix}/Cellar/${entry.source_path}`
    ) {
      throw new Error(
        `Homebrew bottle maps an archive member outside its keg at /${entry.path}`,
      );
    }
  }

  const sourceRootEnd = receiptSource.path.lastIndexOf("/");
  const sourceRoot = sourceRootEnd < 0
    ? ""
    : receiptSource.path.slice(0, sourceRootEnd);
  const changedSources = new Set(receipt.changedFiles.map((path) =>
    sourceRoot.length === 0 ? path : `${sourceRoot}/${path}`
  ));
  const markedSources = new Set(
    relocationEntries.map((entry) => entry.source_path),
  );
  if (!equalSets(changedSources, markedSources)) {
    throw new Error(
      "Homebrew bottle relocation markers differ from INSTALL_RECEIPT.json",
    );
  }
  for (const entry of relocationEntries) {
    if (
      `/${entry.path}` !==
        `${destinationPrefix}/Cellar/${entry.source_path}`
    ) {
      throw new Error(
        `Homebrew bottle changed destination /${entry.path} ` +
          "does not match its receipt destination prefix",
      );
    }
  }

  const transformedCanonicalSources = new Set<string>();
  for (const sourcePath of changedSources) {
    const changed = sourceByPath.get(sourcePath);
    const canonical = changed?.type === "file"
      ? changed
      : changed === undefined
        ? undefined
        : canonicalByPath.get(changed.path);
    if (canonical?.type !== "file") {
      throw new Error(
        `Homebrew bottle changed source ${sourcePath} is not regular`,
      );
    }
    transformedCanonicalSources.add(canonical.path);
  }
  const plannedSources = new Set(
    relocation.materialization.transforms.map((transform) => transform.sourcePath),
  );
  if (!equalSets(transformedCanonicalSources, plannedSources)) {
    throw new Error(
      "Homebrew bottle plan transforms differ from INSTALL_RECEIPT.json",
    );
  }
  const expectedRecipe = createHomebrewBottleRelocationRecipe(receipt, {
    destinationPrefix,
    path: receiptSource.path,
  });
  if (plannedSources.size === 0) {
    if (relocation.materialization.recipes.length !== 0) {
      throw new Error("Homebrew bottle plan has a recipe without changed files");
    }
  } else if (
    relocation.materialization.recipes.length !== 1 ||
    !sameJson(relocation.materialization.recipes[0], expectedRecipe) ||
    relocation.materialization.transforms.some((transform) =>
      transform.recipe !== HOMEBREW_BOTTLE_RELOCATION_RECIPE_ID
    )
  ) {
    throw new Error(
      "Homebrew bottle plan recipe differs from the authenticated receipt",
    );
  }

  return {
    decoder: "tar-gzip-v1",
    source,
    materialization: relocation.materialization,
    entries,
  };
}

function homebrewSourceToGenericInventory(
  tree: HomebrewDeferredTreeDescriptor,
): LazyTreeSourceInventory {
  if (tree.inventory.source === undefined) {
    throw new Error("Homebrew original bottle has no complete source inventory");
  }
  return {
    schema: 1,
    kind: "archive-source-inventory-v1",
    entries: tree.inventory.source.entries.map((entry) => ({
      sourcePath: entry.path,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      ...(entry.target === undefined ? {} : { target: entry.target }),
    })),
  };
}

function homebrewEntryToGenericEntry(
  entry: HomebrewDeferredTreeDescriptor["inventory"]["entries"][number],
): LazyTreeRegistrationEntry {
  return {
    vfsPath: `/${entry.path}`,
    sourcePath: entry.source_path,
    ...(entry.materialization === undefined
      ? {}
      : {
          materialization: entry.materialization === "archive-homebrew-relocate"
            ? "archive" as const
            : entry.materialization,
        }),
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    ...(entry.target === undefined
      ? {}
      : { target: entry.type === "hardlink" ? `/${entry.target}` : entry.target }),
    ...(entry.inode_group === undefined ? {} : { inodeGroup: entry.inode_group }),
  };
}

function parseHomebrewRelocation(
  value: unknown,
  source: LazyTreeSourceInventory,
): {
  receiptSourcePath: string;
  materialization: LazyTreeMaterializationPlan;
} | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Homebrew bottle relocation must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["kind", "materialization", "receipt_source_path", "schema"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    record.schema !== 1 || record.kind !== "homebrew-bottle-relocation-v1"
  ) {
    throw new Error("Homebrew bottle relocation has an unsupported identity");
  }
  if (typeof record.receipt_source_path !== "string") {
    throw new Error("Homebrew bottle relocation receipt source is invalid");
  }
  return {
    receiptSourcePath: record.receipt_source_path,
    materialization: validateLazyTreeMaterializationPlan(
      record.materialization,
      source,
    ),
  };
}

function resolveHomebrewSourceHardlinks(
  entries: readonly HomebrewDeferredTreeSourceEntry[],
  byPath: ReadonlyMap<string, HomebrewDeferredTreeSourceEntry>,
): Map<string, HomebrewDeferredTreeSourceEntry> {
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
        throw new Error(`Homebrew bottle source hardlink cycle includes ${current.path}`);
      }
      seen.add(current.path);
      chain.push(current);
      const target = byPath.get(current.target!);
      if (target === undefined || (target.type !== "file" && target.type !== "hardlink")) {
        throw new Error(
          `Homebrew bottle source hardlink ${current.path} target is invalid`,
        );
      }
      current = target;
    }
    canonical ??= current;
    for (const link of chain) canonicalByPath.set(link.path, canonical);
  }
  return canonicalByPath;
}

function equalSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
