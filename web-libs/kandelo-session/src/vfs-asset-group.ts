import { normalizeDeploymentBase } from "./deployment-scope";
import { validateVfsAssetGroupRelativePath } from "./vfs-asset-group-reference";

export { validateVfsAssetGroupRelativePath } from "./vfs-asset-group-reference";

export interface VfsAssetGroupFileIdentityV1 {
  bytes: number;
  path: string;
  sha256: string;
}

export interface VfsAssetGroupAssetV1 extends VfsAssetGroupFileIdentityV1 {
  group: string;
}

export interface VfsAssetGroupProductV1 {
  eager_groups: readonly string[];
  id: string;
  image: VfsAssetGroupFileIdentityV1;
  lazy_groups: readonly string[];
}

export interface VfsAssetGroupManifestV1 {
  assets: readonly VfsAssetGroupAssetV1[];
  kind: "kandelo-vfs-asset-group";
  policy: "source-only-v1";
  products: readonly VfsAssetGroupProductV1[];
  schema: 1;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export function validateVfsAssetGroupManifest(
  value: unknown,
): Readonly<VfsAssetGroupManifestV1> {
  exactKeys(
    value,
    ["assets", "kind", "policy", "products", "schema"],
    "VFS asset group manifest",
  );
  const manifest = value as VfsAssetGroupManifestV1;
  if (
    manifest.kind !== "kandelo-vfs-asset-group" ||
    manifest.schema !== 1 ||
    manifest.policy !== "source-only-v1" ||
    !Array.isArray(manifest.assets) ||
    !Array.isArray(manifest.products)
  ) {
    throw new Error("VFS asset group manifest has an unsupported identity");
  }
  const assets = manifest.assets.map((asset, index) =>
    validateAsset(asset, index),
  );
  const products = manifest.products.map((product, index) =>
    validateProduct(product, index),
  );
  assertSortedUniquePaths(
    assets.map(({ path }) => path),
    "VFS asset group asset paths",
  );
  assertSortedUniqueIds(
    products.map(({ id }) => id),
    "VFS asset group product IDs",
  );
  const groups = new Set(assets.map(({ group }) => group));
  for (const product of products) {
    assertSortedUniqueIds(
      product.eager_groups,
      `VFS asset group ${product.id} eager groups`,
    );
    assertSortedUniqueIds(
      product.lazy_groups,
      `VFS asset group ${product.id} lazy groups`,
    );
    for (const group of [...product.eager_groups, ...product.lazy_groups]) {
      if (!STABLE_ID.test(group) || !groups.has(group)) {
        throw new Error(
          `VFS asset group product ${product.id} references an unknown group`,
        );
      }
    }
    if (
      product.eager_groups.some((group) => product.lazy_groups.includes(group))
    ) {
      throw new Error(
        `VFS asset group product ${product.id} repeats a group across policies`,
      );
    }
  }
  assertDisjointPaths([
    ...assets.map(({ path }) => path),
    ...products.map(({ image }) => image.path),
  ]);
  return Object.freeze({
    assets: Object.freeze(assets),
    kind: manifest.kind,
    policy: manifest.policy,
    products: Object.freeze(products),
    schema: manifest.schema,
  });
}

export function resolveGroupedAssetUrl(
  manifestUrl: string,
  relativePath: string,
  deploymentBase: string,
): string {
  validateVfsAssetGroupRelativePath(relativePath);
  const manifest = new URL(manifestUrl);
  const directory = new URL("./", manifest);
  const base = normalizeDeploymentBase(deploymentBase);
  const resolved = new URL(relativePath, directory);
  if (
    resolved.origin !== manifest.origin ||
    !resolved.pathname.startsWith(directory.pathname) ||
    !resolved.pathname.startsWith(base)
  ) {
    throw new Error("VFS asset group path escapes its authority");
  }
  return resolved.href;
}

function validateAsset(value: unknown, index: number): VfsAssetGroupAssetV1 {
  exactKeys(
    value,
    ["bytes", "group", "path", "sha256"],
    `VFS asset group asset ${index}`,
  );
  const asset = value as VfsAssetGroupAssetV1;
  if (!STABLE_ID.test(asset.group)) {
    throw new Error(`VFS asset group asset ${index} has an invalid group`);
  }
  return Object.freeze({
    ...validateFileIdentity(
      { bytes: asset.bytes, path: asset.path, sha256: asset.sha256 },
      `VFS asset group asset ${index}`,
    ),
    group: asset.group,
  });
}

function validateProduct(
  value: unknown,
  index: number,
): VfsAssetGroupProductV1 {
  exactKeys(
    value,
    ["eager_groups", "id", "image", "lazy_groups"],
    `VFS asset group product ${index}`,
  );
  const product = value as VfsAssetGroupProductV1;
  if (
    !STABLE_ID.test(product.id) ||
    !Array.isArray(product.eager_groups) ||
    !Array.isArray(product.lazy_groups)
  ) {
    throw new Error(`VFS asset group product ${index} is invalid`);
  }
  return Object.freeze({
    eager_groups: Object.freeze(product.eager_groups.slice()),
    id: product.id,
    image: validateFileIdentity(
      product.image,
      `VFS asset group product ${index} image`,
    ),
    lazy_groups: Object.freeze(product.lazy_groups.slice()),
  }) as VfsAssetGroupProductV1;
}

function validateFileIdentity(
  value: unknown,
  label: string,
): VfsAssetGroupFileIdentityV1 {
  exactKeys(value, ["bytes", "path", "sha256"], label);
  const identity = value as VfsAssetGroupFileIdentityV1;
  if (
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes < 1 ||
    !SHA256.test(identity.sha256) ||
    !isValidRelativePath(identity.path)
  ) {
    throw new Error(`${label} has an invalid byte identity`);
  }
  return Object.freeze({
    bytes: identity.bytes,
    path: identity.path,
    sha256: identity.sha256,
  });
}

function isValidRelativePath(value: unknown): value is string {
  try {
    validateVfsAssetGroupRelativePath(value);
    return true;
  } catch {
    return false;
  }
}

function assertSortedUniqueIds(values: readonly string[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!STABLE_ID.test(value) || (index > 0 && values[index - 1]! >= value)) {
      throw new Error(`${label} are not sorted and unique`);
    }
  }
}

function assertSortedUniquePaths(
  values: readonly string[],
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      throw new Error(`${label} are not sorted and unique`);
    }
  }
}

function assertDisjointPaths(paths: readonly string[]): void {
  const sorted = paths.slice().sort();
  for (let index = 1; index < sorted.length; index += 1) {
    const prior = sorted[index - 1]!;
    const current = sorted[index]!;
    if (prior === current || current.startsWith(`${prior}/`)) {
      throw new Error("VFS asset group inventory paths collide");
    }
  }
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} fields differ`);
  }
}
