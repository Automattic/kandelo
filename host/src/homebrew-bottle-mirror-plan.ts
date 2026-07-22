import {
  homebrewRuntimeLayerPayloadAsset,
  isHomebrewRuntimeLayerId,
} from "./homebrew-runtime-layer-limits";
import {
  MAX_CLOSED_LAZY_ASSETS,
  MAX_CLOSED_LAZY_ASSET_BYTES,
} from "./vfs/closed-lazy-assets";

export const HOMEBREW_BOTTLE_MIRROR_PLAN_KIND =
  "kandelo-homebrew-bottle-mirror-plan" as const;
export const HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET =
  "kandelo-homebrew-bottle-mirror-plan.json" as const;
export const HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH =
  "/etc/kandelo/homebrew-bottle-mirror-plan.json" as const;

export interface HomebrewBottleMirrorAsset {
  id: string;
  package: string;
  asset: string;
  sha256: string;
  bytes: number;
  url: string;
}

/**
 * Immutable public mirror plan whose tag depends only on the exact deferred
 * bottle identities. It deliberately does not depend on the final VFS digest.
 */
export interface HomebrewBottleMirrorPlan {
  schema: 1;
  kind: typeof HOMEBREW_BOTTLE_MIRROR_PLAN_KIND;
  repository: string;
  collection_sha256: string;
  tag: string;
  release_root: string;
  manifest_asset: typeof HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET;
  assets: HomebrewBottleMirrorAsset[];
}

const PLAN_KEYS = [
  "schema",
  "kind",
  "repository",
  "collection_sha256",
  "tag",
  "release_root",
  "manifest_asset",
  "assets",
] as const;
const ASSET_KEYS = [
  "id",
  "package",
  "asset",
  "sha256",
  "bytes",
  "url",
] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPOSITORY_RE =
  /^[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?$/;
const PACKAGE_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.@+-]*$/;

/**
 * Validate an untrusted plan's complete structural contract and rebuild it in
 * the one field order used for canonical bytes and identity derivation.
 * Unknown fields are rejected rather than silently participating on one host
 * and disappearing on another.
 */
export function projectHomebrewBottleMirrorPlan(
  value: unknown,
): HomebrewBottleMirrorPlan {
  if (!isRecord(value) || !hasExactKeys(value, PLAN_KEYS)) {
    throw new Error("Homebrew bottle mirror plan has unknown or missing fields");
  }
  if (
    value.schema !== 1 ||
    value.kind !== HOMEBREW_BOTTLE_MIRROR_PLAN_KIND ||
    typeof value.repository !== "string" ||
    !REPOSITORY_RE.test(value.repository) ||
    typeof value.collection_sha256 !== "string" ||
    !SHA256_RE.test(value.collection_sha256) ||
    typeof value.tag !== "string" ||
    typeof value.release_root !== "string" ||
    value.manifest_asset !== HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET ||
    !Array.isArray(value.assets) ||
    value.assets.length === 0 ||
    value.assets.length > MAX_CLOSED_LAZY_ASSETS
  ) {
    throw new Error("Homebrew bottle mirror plan has invalid top-level fields");
  }

  const seenIds = new Set<string>();
  const seenPackages = new Set<string>();
  const seenAssets = new Set<string>();
  const seenUrls = new Set<string>();
  let previousId: string | undefined;
  let totalBytes = 0;
  const assets = value.assets.map((rawAsset, index) => {
    const asset = projectAsset(rawAsset, index);
    totalBytes += asset.bytes;
    if (
      seenIds.has(asset.id) ||
      seenPackages.has(asset.package) ||
      seenAssets.has(asset.asset) ||
      seenUrls.has(asset.url) ||
      (previousId !== undefined && previousId >= asset.id) ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_CLOSED_LAZY_ASSET_BYTES
    ) {
      throw new Error("Homebrew bottle mirror asset ownership is not canonical");
    }
    seenIds.add(asset.id);
    seenPackages.add(asset.package);
    seenAssets.add(asset.asset);
    seenUrls.add(asset.url);
    previousId = asset.id;
    return asset;
  });

  return {
    schema: 1,
    kind: HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
    repository: value.repository,
    collection_sha256: value.collection_sha256,
    tag: value.tag,
    release_root: value.release_root,
    manifest_asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    assets,
  };
}

/** Canonical JSON bytes embedded in the VFS and published with its payloads. */
export function encodeHomebrewBottleMirrorPlan(
  plan: HomebrewBottleMirrorPlan,
): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(plan, null, 2)}\n`);
}

/** Exact content-address input shared by Node composition and browser proof. */
export function encodeHomebrewBottleMirrorCollectionIdentity(
  repository: string,
  assets: ReadonlyArray<Pick<
    HomebrewBottleMirrorAsset,
    "id" | "package" | "asset" | "sha256" | "bytes"
  >>,
): Uint8Array {
  const canonical = assets.map(({ id, package: packageName, asset, sha256, bytes }) => ({
    id,
    package: packageName,
    asset,
    sha256,
    bytes,
  })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return new TextEncoder().encode(JSON.stringify({
    schema: 1,
    kind: HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
    repository,
    assets: canonical,
  }));
}

function projectAsset(value: unknown, index: number): HomebrewBottleMirrorAsset {
  if (!isRecord(value) || !hasExactKeys(value, ASSET_KEYS)) {
    throw new Error(
      `Homebrew bottle mirror asset ${index} has unknown or missing fields`,
    );
  }
  const packageParts = typeof value.package === "string"
    ? value.package.split("/")
    : [];
  if (
    !isHomebrewRuntimeLayerId(value.id) ||
    typeof value.package !== "string" ||
    packageParts.length !== 3 ||
    packageParts.some((part) => !PACKAGE_COMPONENT_RE.test(part)) ||
    typeof value.asset !== "string" ||
    value.asset === HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET ||
    value.asset !== homebrewRuntimeLayerPayloadAsset(value.id) ||
    typeof value.sha256 !== "string" ||
    !SHA256_RE.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) <= 0 ||
    typeof value.url !== "string"
  ) {
    throw new Error(`Homebrew bottle mirror asset ${index} has invalid fields`);
  }
  return {
    id: value.id,
    package: value.package,
    asset: value.asset,
    sha256: value.sha256,
    bytes: value.bytes as number,
    url: value.url,
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
