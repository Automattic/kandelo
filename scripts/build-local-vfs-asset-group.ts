#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeImageOwnedLazyReference } from "../web-libs/kandelo-session/src/vfs-asset-group-reference.ts";
import {
  createSourceOnlyBinarySnapshotSession,
  sourceOnlyBinaryRoot,
  type SourceOnlyBinarySnapshot,
} from "../host/src/binary-resolver.ts";
import { ABI_VERSION } from "../host/src/generated/abi.ts";
import { restoreVerifiedVfsImage } from "../host/src/vfs/load-image.ts";
import {
  validateVfsAssetGroupManifest,
  type VfsAssetGroupManifestV1,
} from "../web-libs/kandelo-session/src/vfs-asset-group.ts";
import {
  loadVfsProductDeploymentMap,
  vfsProductDeploymentPath,
  type VfsProductDeploymentMapV1,
} from "./vfs-product-deployment.ts";
import {
  projectedArtifact,
  readGeneratedPagesRegistry,
} from "./check-pages-vfs-product-registry.mjs";
import { loadVfsProductCatalog } from "./vfs-product-catalog.mjs";

const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
const EXPECTED_IMAGE_MEMBERS = [
  "programs/wasm32/lamp.vfs.zst",
  "programs/wasm32/nginx-php-vfs.vfs.zst",
  "programs/wasm32/nginx-vfs.vfs.zst",
  "programs/wasm32/node-vfs.vfs.zst",
  "programs/wasm32/rootfs.vfs",
  "programs/wasm32/shell.vfs.zst",
  "programs/wasm32/wordpress.vfs.zst",
];

export interface BuildLocalVfsAssetGroupOptions {
  assetGroupDirectory: string;
  productMapPath: string;
  sourceRoot: string;
}

interface ProductProjection {
  id: string;
  load: "eager" | "lazy";
  output: string;
  sourceMember: string;
}

interface ExpectedAsset {
  bytes: number;
  sha256?: string;
  sourceMember: string;
}

export async function buildLocalVfsAssetGroup(
  options: BuildLocalVfsAssetGroupOptions,
): Promise<void> {
  const sourceRoot = exactDirectory(options.sourceRoot, "source root");
  const configuredSourceOnlyRoot = sourceOnlyBinaryRoot();
  if (configuredSourceOnlyRoot === null) {
    throw new Error("local VFS asset-group production requires source-only-v1");
  }
  const sourceOnlyRoot = exactDirectory(
    configuredSourceOnlyRoot,
    "SourceOnly root",
  );
  const assetGroupDirectory = exactGeneratedTarget(
    options.assetGroupDirectory,
    "vfs-group",
    "asset-group directory",
  );
  const productMapPath = exactGeneratedTarget(
    options.productMapPath,
    "pages-vfs-products.private.json",
    "private product map",
  );
  if (dirname(assetGroupDirectory) !== dirname(productMapPath)) {
    throw new Error(
      "generated asset group and private map must share one parent",
    );
  }
  for (const target of [assetGroupDirectory, productMapPath]) {
    if (
      target === sourceOnlyRoot ||
      isWithin(sourceOnlyRoot, target) ||
      isWithin(target, sourceOnlyRoot)
    ) {
      throw new Error(
        "generated VFS outputs may not overlap the SourceOnly projection",
      );
    }
    rejectLinkTarget(target);
  }

  const paths = authorityPaths(sourceRoot);
  const registry = readGeneratedPagesRegistry(paths.generatedRegistryPath);
  const catalog = loadVfsProductCatalog(paths.catalogPath);
  const products: ProductProjection[] = registry.products
    .map((entry: any) => {
      const product = catalog.productById(entry.id) as {
        architecture: string;
        id: string;
        output: string;
      };
      const artifact = projectedArtifact(product);
      return {
        id: entry.id,
        load: entry.load,
        output: product.output,
        sourceMember: `programs/${product.architecture}/${artifact.filename}`,
      };
    })
    .sort((left: ProductProjection, right: ProductProjection) =>
      ordinal(left.id, right.id),
    );
  if (
    products.length !== 7 ||
    canonicalJson(
      products.map(({ sourceMember }) => sourceMember).sort(ordinal),
    ) !== canonicalJson(EXPECTED_IMAGE_MEMBERS)
  ) {
    throw new Error(
      "generated Pages registry differs from the exact seven product images",
    );
  }

  // WHY: one session pins the projection authority while restored images
  // reveal the second-stage lazy closure that must be captured from it.
  const session = createSourceOnlyBinarySnapshotSession();
  const imageMembers = products.map(({ sourceMember }) => sourceMember);
  const imageSnapshots = requireSnapshots(
    session.snapshots(imageMembers, MAX_CAPTURE_BYTES),
    imageMembers,
  );
  const expectedAssets = new Map<string, ExpectedAsset>();
  for (const [index, snapshot] of imageSnapshots.entries()) {
    const fs = await restoreVerifiedVfsImage(snapshot.bytes);
    for (const entry of fs.exportLazyEntries()) {
      addExpectedAsset(expectedAssets, entry.url, { bytes: entry.size });
    }
    for (const entry of fs.exportLazyArchiveEntries()) {
      const identity = entry.content ?? entry.integrity;
      if (identity === undefined) {
        throw new Error(
          `product ${products[index]!.id} has an archive without byte integrity`,
        );
      }
      for (const reference of entry.content?.transports ?? [entry.url]) {
        addExpectedAsset(expectedAssets, reference, {
          bytes: identity.bytes,
          sha256: identity.sha256,
        });
      }
    }
  }
  if (expectedAssets.size !== 80) {
    throw new Error(
      `Pages product images reference ${expectedAssets.size} lazy bodies, expected 80`,
    );
  }

  const assetMembers = [...expectedAssets.values()].map(
    ({ sourceMember }) => sourceMember,
  );
  const imageMemberSet = new Set(imageMembers);
  const collision = assetMembers.find((member) => imageMemberSet.has(member));
  if (collision !== undefined) {
    throw new Error(
      `SourceOnly image and lazy asset members collide at ${collision}`,
    );
  }
  const allMembers = [...imageMembers, ...assetMembers];
  if (allMembers.length !== 87 || new Set(allMembers).size !== 87) {
    throw new Error("Pages VFS closure must contain 87 distinct snapshot members");
  }
  const snapshots = requireSnapshots(
    session.snapshots(allMembers, MAX_CAPTURE_BYTES),
    allMembers,
  );
  const captured = new Map(
    snapshots.map((snapshot) => [snapshot.relPath, snapshot]),
  );
  for (const [assetPath, expected] of expectedAssets) {
    const snapshot = captured.get(expected.sourceMember)!;
    if (
      snapshot.bytes.byteLength !== expected.bytes ||
      (expected.sha256 !== undefined && snapshot.sha256 !== expected.sha256)
    ) {
      throw new Error(
        `lazy asset ${assetPath} differs from its image byte identity`,
      );
    }
  }

  const parent = dirname(assetGroupDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const stageRoot = mkdtempSync(join(parent, ".local-vfs-asset-group-stage-"));
  const stagedGroup = join(stageRoot, "vfs-group");
  const stagedMap = join(stageRoot, "pages-vfs-products.private.json");
  try {
    const manifest: VfsAssetGroupManifestV1 = {
      assets: [...expectedAssets.entries()]
        .map(([path, expected]) => {
          const snapshot = captured.get(expected.sourceMember)!;
          return {
            bytes: snapshot.bytes.byteLength,
            group: "programs",
            path,
            sha256: snapshot.sha256,
          };
        })
        .sort((left, right) => ordinal(left.path, right.path)),
      kind: "kandelo-vfs-asset-group",
      policy: "source-only-v1",
      products: products.map((product) => {
        const snapshot = captured.get(product.sourceMember)!;
        return {
          eager_groups: [],
          id: product.id,
          image: {
            bytes: snapshot.bytes.byteLength,
            path: `images/${product.output}`,
            sha256: snapshot.sha256,
          },
          lazy_groups: ["programs"],
        };
      }),
      schema: 1,
    };
    validateVfsAssetGroupManifest(manifest);
    for (const product of products) {
      writeExactFile(
        join(stagedGroup, "images", product.output),
        captured.get(product.sourceMember)!.bytes,
      );
    }
    for (const [path, expected] of expectedAssets) {
      writeExactFile(
        join(stagedGroup, ...path.split("/")),
        captured.get(expected.sourceMember)!.bytes,
      );
    }
    const manifestBytes = Buffer.from(canonicalJson(manifest));
    writeExactFile(join(stagedGroup, "manifest.json"), manifestBytes);
    const manifestIdentity = {
      bytes: manifestBytes.byteLength,
      path: "vfs-groups/release-1/manifest.json",
      sha256: sha256(manifestBytes),
    };
    const map: VfsProductDeploymentMapV1 = {
      kind: "kandelo-pages-private-product-map",
      products: products.map((product) => {
        const snapshot = captured.get(product.sourceMember)!;
        return {
          asset_group: manifestIdentity,
          bytes: snapshot.bytes.byteLength,
          id: product.id,
          load: product.load,
          path: vfsProductDeploymentPath(
            product.id,
            snapshot.sha256,
            ABI_VERSION,
          ),
          private_path: join(assetGroupDirectory, "images", product.output),
          sha256: snapshot.sha256,
        };
      }),
      schema: 1,
    };
    validateStagedGroup(stagedGroup, manifest);
    validateStagedProductMap({
      finalMap: map,
      products,
      sourceRoot,
      stageRoot,
      stagedGroup,
    });
    writeExactFile(stagedMap, Buffer.from(canonicalJson(map)));

    publishGeneratedTargets({
      assetGroupDirectory,
      productMapPath,
      stagedGroup,
      stagedMap,
    });
  } finally {
    rmSync(stageRoot, { force: true, recursive: true });
  }
}

function validateStagedProductMap(options: {
  finalMap: VfsProductDeploymentMapV1;
  products: readonly ProductProjection[];
  sourceRoot: string;
  stageRoot: string;
  stagedGroup: string;
}): void {
  const validationPath = join(options.stageRoot, "validation-private-map.json");
  const validationMap: VfsProductDeploymentMapV1 = {
    ...options.finalMap,
    products: options.finalMap.products.map((entry, index) => ({
      ...entry,
      private_path: join(
        options.stagedGroup,
        "images",
        options.products[index]!.output,
      ),
    })),
  };
  writeExactFile(validationPath, Buffer.from(canonicalJson(validationMap)));
  const loaded = loadVfsProductDeploymentMap({
    mapPath: validationPath,
    sourceRoot: options.sourceRoot,
  });
  const normalized = {
    ...loaded,
    products: loaded.products.map((entry, index) => ({
      ...entry,
      private_path: options.finalMap.products[index]!.private_path,
    })),
  };
  if (canonicalJson(normalized) !== canonicalJson(options.finalMap)) {
    throw new Error(
      "staged private Pages product map changed during validation",
    );
  }
  rmSync(validationPath);
}

function addExpectedAsset(
  expected: Map<string, ExpectedAsset>,
  reference: string,
  identity: { bytes: number; sha256?: string },
): void {
  const path = normalizeImageOwnedLazyReference(reference);
  const sourceMember = path.slice("assets/".length);
  if (!Number.isSafeInteger(identity.bytes) || identity.bytes < 1) {
    throw new Error(`lazy asset ${path} has an invalid size`);
  }
  const prior = expected.get(path);
  if (
    prior !== undefined &&
    (prior.sourceMember !== sourceMember ||
      prior.bytes !== identity.bytes ||
      (prior.sha256 !== undefined &&
        identity.sha256 !== undefined &&
        prior.sha256 !== identity.sha256))
  ) {
    throw new Error(`lazy asset ${path} has conflicting image identities`);
  }
  expected.set(path, {
    bytes: identity.bytes,
    sha256: prior?.sha256 ?? identity.sha256,
    sourceMember,
  });
}

function requireSnapshots(
  snapshots: Array<SourceOnlyBinarySnapshot | null>,
  members: readonly string[],
): SourceOnlyBinarySnapshot[] {
  return snapshots.map((snapshot, index) => {
    if (snapshot === null) {
      throw new Error(`SourceOnly projection lacks ${members[index]}`);
    }
    if (snapshot.relPath !== members[index]) {
      throw new Error(
        "SourceOnly snapshot order differs from the requested closure",
      );
    }
    return snapshot;
  });
}

function validateStagedGroup(
  root: string,
  manifest: VfsAssetGroupManifestV1,
): void {
  const expected = new Map<string, { bytes: number; sha256: string }>();
  const manifestBytes = readFileSync(join(root, "manifest.json"));
  expected.set("manifest.json", {
    bytes: manifestBytes.byteLength,
    sha256: sha256(manifestBytes),
  });
  for (const product of manifest.products) {
    expected.set(product.image.path, product.image);
  }
  for (const asset of manifest.assets) expected.set(asset.path, asset);
  const actual = inventory(root, {
    label: "staged asset group",
    maxBytes: [...expected.values()].reduce(
      (total, identity) => total + identity.bytes,
      0,
    ),
    maxFiles: expected.size,
  });
  if (
    actual.size !== expected.size ||
    [...actual].some(([path, identity]) => {
      const wanted = expected.get(path);
      return (
        wanted === undefined ||
        wanted.bytes !== identity.bytes ||
        wanted.sha256 !== identity.sha256
      );
    })
  ) {
    throw new Error(
      "staged local VFS asset-group inventory differs from its manifest",
    );
  }
}

export function publishGeneratedTargets(options: {
  assetGroupDirectory: string;
  productMapPath: string;
  stagedGroup: string;
  stagedMap: string;
}, operations: { rename(from: string, to: string): void } = {
  rename: renameSync,
}): void {
  const parent = dirname(options.assetGroupDirectory);
  const lock = join(parent, ".local-vfs-asset-group.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("local VFS asset-group publication is already in progress");
    }
    throw error;
  }
  let backupRoot: string | undefined;
  let discardBackup = false;
  try {
    if (
      treesEqual(options.stagedGroup, options.assetGroupDirectory) &&
      filesEqual(options.stagedMap, options.productMapPath)
    ) return;
    backupRoot = mkdtempSync(join(parent, ".local-vfs-asset-group-backup-"));
    const backupGroup = join(backupRoot, "vfs-group");
    const backupMap = join(backupRoot, "pages-vfs-products.private.json");
    let oldGroup = false;
    let oldMap = false;
    let installedGroup: { dev: number; ino: number } | undefined;
    let installedMap: { dev: number; ino: number } | undefined;
    try {
      // WHY: without a single-directory atomic swap, absence is the only
      // truthful intermediate map state while its authenticated group moves.
      if (existsSync(options.productMapPath)) {
        operations.rename(options.productMapPath, backupMap);
        oldMap = true;
      }
      if (existsSync(options.assetGroupDirectory)) {
        operations.rename(options.assetGroupDirectory, backupGroup);
        oldGroup = true;
      }
      operations.rename(options.stagedGroup, options.assetGroupDirectory);
      installedGroup = entryIdentity(options.assetGroupDirectory);
      operations.rename(options.stagedMap, options.productMapPath);
      installedMap = entryIdentity(options.productMapPath);
      discardBackup = true;
    } catch (publicationError) {
      let restorationError: unknown;
      try {
        if (
          installedMap !== undefined &&
          hasEntryIdentity(options.productMapPath, installedMap)
        ) {
          rmSync(options.productMapPath, { force: true });
        }
        if (
          installedGroup !== undefined &&
          hasEntryIdentity(options.assetGroupDirectory, installedGroup)
        ) {
          rmSync(options.assetGroupDirectory, { force: true, recursive: true });
        }
        if (oldGroup && !existsSync(options.assetGroupDirectory)) {
          operations.rename(backupGroup, options.assetGroupDirectory);
        }
        if (oldMap && !existsSync(options.productMapPath)) {
          operations.rename(backupMap, options.productMapPath);
        }
      } catch (error) {
        restorationError = error;
      }
      if (existsSync(backupGroup) || existsSync(backupMap)) {
        const publicationMessage =
          publicationError instanceof Error
            ? publicationError.message
            : String(publicationError);
        const restorationMessage =
          restorationError === undefined
            ? "rollback could not replace a generated target"
            : restorationError instanceof Error
              ? restorationError.message
              : String(restorationError);
        throw new Error(
          `local VFS asset-group publication failed: ${publicationMessage}; ` +
            `incomplete rollback: ${restorationMessage}; ` +
            `prior generation preserved at ${backupRoot}`,
          { cause: publicationError },
        );
      }
      discardBackup = true;
      throw publicationError;
    }
  } finally {
    if (backupRoot !== undefined && discardBackup) {
      rmSync(backupRoot, { force: true, recursive: true });
    }
    rmSync(lock, { force: true, recursive: true });
  }
}

function entryIdentity(path: string): { dev: number; ino: number } {
  const metadata = lstatSync(path);
  return { dev: metadata.dev, ino: metadata.ino };
}

function hasEntryIdentity(
  path: string,
  identity: { dev: number; ino: number },
): boolean {
  if (!existsSync(path)) return false;
  const metadata = lstatSync(path);
  return metadata.dev === identity.dev && metadata.ino === identity.ino;
}

function authorityPaths(sourceRoot: string) {
  return {
    catalogPath: join(sourceRoot, "images/vfs/products/generated/catalog.json"),
    generatedRegistryPath: join(
      sourceRoot,
      "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
    ),
  };
}

function exactDirectory(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be absolute`);
  }
  const metadata = lstatSync(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a direct directory`);
  }
  return value;
}

function exactGeneratedTarget(
  value: string,
  name: string,
  label: string,
): string {
  if (
    !isAbsolute(value) ||
    resolve(value) !== value ||
    basename(value) !== name
  ) {
    throw new Error(`${label} must be the explicit absolute ${name} target`);
  }
  if (canonicalizeFromExistingAncestor(value) !== value) {
    throw new Error(`${label} has a symlinked ancestor`);
  }
  return value;
}

function canonicalizeFromExistingAncestor(value: string): string {
  const suffix: string[] = [];
  let existing = resolve(value);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(value);
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function rejectLinkTarget(path: string): void {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`generated target may not be a symbolic link: ${path}`);
  }
  if (path.endsWith(".json") ? !metadata.isFile() : !metadata.isDirectory()) {
    throw new Error(`generated target has the wrong entry type: ${path}`);
  }
}

function writeExactFile(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, bytes, { flag: "wx", mode: 0o644 });
}

function inventory(
  root: string,
  limits: { label: string; maxBytes: number; maxFiles: number },
): Map<string, { bytes: number; sha256: string }> {
  const result = new Map<string, { bytes: number; sha256: string }>();
  let totalBytes = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 64) {
      throw new Error(`${limits.label} exceeds the reuse depth ceiling`);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => ordinal(left.name, right.name),
    )) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`generated tree contains a symbolic link: ${path}`);
      }
      if (metadata.isDirectory()) visit(path, depth + 1);
      else if (metadata.isFile() && metadata.nlink === 1 && metadata.size > 0) {
        if (result.size >= limits.maxFiles) {
          throw new Error(`${limits.label} exceeds the reuse file ceiling`);
        }
        if (totalBytes + metadata.size > limits.maxBytes) {
          throw new Error(`${limits.label} exceeds the reuse byte ceiling`);
        }
        const body = readFileSync(path);
        totalBytes += body.byteLength;
        result.set(relative(root, path).split(sep).join("/"), {
          bytes: body.byteLength,
          sha256: sha256(body),
        });
      } else {
        throw new Error(`generated tree contains a non-regular file: ${path}`);
      }
    }
  };
  visit(root, 0);
  return result;
}

function treesEqual(left: string, right: string): boolean {
  if (!existsSync(right)) return false;
  const stagedInventory = inventory(left, {
    label: "staged asset group",
    maxBytes: MAX_CAPTURE_BYTES,
    maxFiles: 88,
  });
  const maxBytes = [...stagedInventory.values()].reduce(
    (total, identity) => total + identity.bytes,
    0,
  );
  let existingInventory: Map<string, { bytes: number; sha256: string }>;
  try {
    existingInventory = inventory(right, {
      label: "existing asset group",
      maxBytes,
      maxFiles: stagedInventory.size,
    });
  } catch {
    return false;
  }
  return (
    stagedInventory.size === existingInventory.size &&
    [...stagedInventory].every(([path, identity]) => {
      const other = existingInventory.get(path);
      return other?.bytes === identity.bytes && other.sha256 === identity.sha256;
    })
  );
}

function filesEqual(left: string, right: string): boolean {
  if (!existsSync(right)) return false;
  try {
    const staged = lstatSync(left);
    const metadata = lstatSync(right);
    return (
      staged.isFile() &&
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.size === staged.size &&
      readFileSync(left).equals(readFileSync(right))
    );
  } catch {
    return false;
  }
}

function isWithin(root: string, path: string): boolean {
  const value = relative(root, path);
  return (
    value !== "" &&
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !isAbsolute(value)
  );
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .sort(([left], [right]) => ordinal(left, right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    if (typeof candidate === "number" && !Number.isSafeInteger(candidate)) {
      throw new Error("canonical JSON permits safe integers only");
    }
    return candidate;
  };
  return `${JSON.stringify(normalize(value))}\n`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const invokedPath =
  process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [assetGroupDirectory, productMapPath] = process.argv.slice(2);
  if (
    assetGroupDirectory === undefined ||
    productMapPath === undefined ||
    process.argv.length !== 4
  ) {
    throw new Error(
      "usage: build-local-vfs-asset-group.ts <absolute-vfs-group-dir> <absolute-private-map>",
    );
  }
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await buildLocalVfsAssetGroup({
    assetGroupDirectory,
    productMapPath,
    sourceRoot,
  });
}
