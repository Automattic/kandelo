/** Browser-safe schema types shared by the lazy-layer producer and consumer. */

/** Immutable package-release identity for the exact lower VFS output. */
export interface HomebrewLazyLayerBasePackageSource {
  schema: 1;
  kind: "kandelo-package-output";
  index: {
    url: string;
    sha256: string;
    bytes: number;
    abi: number;
  };
  package: {
    name: string;
    version: string;
    revision: number;
    arch: "wasm32" | "wasm64";
    cache_key_sha: string;
  };
  archive: {
    format: "kandelo-package-tar-zstd-v2";
    url: string;
    sha256: string;
    bytes: number;
  };
  output: {
    name: string;
    path: string;
    sha256: string;
    bytes: number;
  };
}

export interface HomebrewLazyLayerEntry {
  /** Guest path relative to `/`. */
  path: string;
  /** Exact member name in the immutable deferred-tree payload. */
  source_path: string;
  type: "directory" | "file" | "symlink" | "hardlink";
  ownership: "layer" | "shared-base-directory";
  mode: number;
  /** Logical guest size. Hard links repeat their canonical file's size. */
  size: number;
  /** Symlink text, or the canonical guest path for a hard link. */
  target?: string;
  /** Stable identity shared by one regular file and all of its hard links. */
  inode_group?: string;
}

export type HomebrewDeferredTreeDecoder =
  | "zip-v1"
  | "homebrew-bottle-tar-gzip-v1";

/**
 * A release asset is the browser-readable copy carried by this bundle. An
 * external HTTPS transport can name the canonical bottle (for example GHCR)
 * or another immutable, byte-identical mirror. The content digest and size,
 * not either location, remain the tree's byte identity.
 */
export type HomebrewDeferredTreeTransport =
  | { kind: "bundle-release"; asset: string; url: string }
  | { kind: "external-https"; url: string };

export type HomebrewDeferredTreeDraftTransport =
  | { kind: "bundle-release"; asset: string }
  | { kind: "external-https"; url: string };

export interface HomebrewDeferredTreeDescriptor {
  id: string;
  activation: {
    mode: "boot-prefetch" | "first-use";
    /** Capability names explain why eager availability is required. */
    capabilities: string[];
    /** Absolute VFS roots that trigger materialization of this tree. */
    roots: string[];
  };
  content: {
    /** Canonical media type of the hashed bytes, independent of transport. */
    media_type:
      | "application/zip"
      | "application/vnd.oci.image.layer.v1.tar+gzip";
    decoder: HomebrewDeferredTreeDecoder;
    sha256: string;
    bytes: number;
  };
  /** Byte-identical immutable HTTPS locations, tried in declared order. */
  transports: HomebrewDeferredTreeTransport[];
  inventory: {
    entry_count: number;
    source_entry_count: number;
    regular_inode_count: number;
    layer_entry_count: number;
    shared_base_directory_count: number;
    /** Decoder expansion bound (ZIP member bytes or complete TAR bytes). */
    expanded_bytes: number;
    /** Bytes allocated once per regular inode, excluding hard-link aliases. */
    payload_bytes: number;
    entries: HomebrewLazyLayerEntry[];
  };
}

export interface HomebrewDeferredTreeDraftDescriptor extends
  Omit<HomebrewDeferredTreeDescriptor, "transports"> {
  /** The bundle-release URL is derived only after closure. */
  transports: HomebrewDeferredTreeDraftTransport[];
}

export interface HomebrewRuntimeLayerAssetIdentity {
  asset: string;
  sha256: string;
  bytes: number;
}

export interface HomebrewRuntimeLayerReleaseAsset extends
  HomebrewRuntimeLayerAssetIdentity {
  url: string;
}

export interface HomebrewRuntimeLayerBundleAssets {
  acceptance_vfs: HomebrewRuntimeLayerAssetIdentity;
  acceptance_descriptor: HomebrewRuntimeLayerAssetIdentity;
  acceptance_report: HomebrewRuntimeLayerAssetIdentity;
  acceptance_node_evidence: HomebrewRuntimeLayerAssetIdentity;
  acceptance_browser_evidence: HomebrewRuntimeLayerAssetIdentity;
  deferred_trees: Array<HomebrewRuntimeLayerAssetIdentity & { id: string }>;
}

export interface HomebrewLazyLayerPackageRecord {
  name: string;
  full_name: string;
  tap_repository: string;
  tap_name: string;
  tap_commit: string;
  version: string;
  formula_revision: number;
  bottle_rebuild: number;
  arch: "wasm32" | "wasm64";
  source_status: "success" | "fallback";
  metadata_status: string;
  url: string;
  sha256: string;
  bytes: number;
  cache_key_sha: string;
  link_manifest: string;
  prefix: string;
  keg: string;
  opt_link: { path: string; target: string };
  built_from?: {
    tap_repository: string;
    tap_commit: string;
    kandelo_repository: string;
    kandelo_commit: string;
    formula_sha256: string;
  };
}

interface HomebrewLazyLayerDescriptorCommon {
  schema: 4;
  arch: "wasm32" | "wasm64";
  mount_prefix: "/";
  tap: {
    repository: string;
    name: string;
    commit: string;
  };
  tap_lock: Array<{
    repository: string;
    name: string;
    commit: string;
    kandelo_repository: string;
    kandelo_commit: string;
    kandelo_abi: number;
    bottle_release_tag: string;
  }>;
  kandelo: {
    repository: string;
    commit: string;
    abi: number;
  };
  bottle_release_tag: string;
  selection: {
    requested_packages: string[];
    package_order: string[];
    base_package_order: string[];
    layer_package_order: string[];
  };
  packages: {
    base: HomebrewLazyLayerPackageRecord[];
    layer: HomebrewLazyLayerPackageRecord[];
  };
  base_vfs: {
    sha256: string;
    bytes: number;
    kernel_abi: number;
    package_source: HomebrewLazyLayerBasePackageSource;
    composition: {
      path: "/etc/kandelo/homebrew-vfs.json";
      sha256: string;
      bytes: number;
      requested_packages_sha256: string;
      package_set_sha256: string;
      package_count: number;
      package_order: string[];
    };
  };
}

/** Inert producer output. It cannot be consumed or published before closure. */
export interface HomebrewLazyLayerDraftDescriptor extends
  HomebrewLazyLayerDescriptorCommon {
  kind: "kandelo-homebrew-deferred-layer-draft";
  acceptance_vfs: HomebrewRuntimeLayerAssetIdentity;
  deferred_trees: HomebrewDeferredTreeDraftDescriptor[];
}

/** Closed public descriptor whose release tag is its independent bundle hash. */
export interface HomebrewLazyLayerDescriptor extends
  HomebrewLazyLayerDescriptorCommon {
  schema: 4;
  kind: "kandelo-homebrew-deferred-layer";
  bundle: {
    schema: 1;
    kind: "kandelo-homebrew-runtime-layer-bundle";
    algorithm: "sha256-canonical-json-v1";
    descriptor_encoding: "canonical-json-v1";
    sha256: string;
    assets: HomebrewRuntimeLayerBundleAssets;
  };
  release: {
    repository: string;
    tag: string;
  };
  acceptance_vfs: HomebrewRuntimeLayerReleaseAsset & {
    asset: "kandelo-homebrew.vfs.zst";
  };
  acceptance_evidence: {
    descriptor: HomebrewRuntimeLayerReleaseAsset & {
      asset: "kandelo-homebrew-vfs.json";
    };
    report: HomebrewRuntimeLayerReleaseAsset & {
      asset: "kandelo-homebrew-vfs-report.json";
    };
    node: HomebrewRuntimeLayerReleaseAsset & {
      asset: "kandelo-homebrew-node-evidence.json";
    };
    browser: HomebrewRuntimeLayerReleaseAsset & {
      asset: "kandelo-homebrew-browser-evidence.json";
    };
  };
  /** One or more independently materialized immutable filesystem trees. */
  deferred_trees: HomebrewDeferredTreeDescriptor[];
}

/**
 * Return the transport-independent document hashed by a runtime-layer tag.
 *
 * The bundle release tag and its asset URLs are derived from the digest, so
 * including them would make the identity circular. External transport records,
 * asset names, bytes, digests, and every semantic descriptor field remain in
 * the document. The public descriptor is therefore a deterministic envelope
 * around this closed identity rather than an input to its own hash.
 */
export function homebrewRuntimeLayerBundleIdentityDocument(
  descriptor: HomebrewLazyLayerDescriptor,
): unknown {
  return {
    schema: 1,
    kind: "kandelo-homebrew-runtime-layer-bundle-identity",
    bundle: {
      schema: descriptor.bundle.schema,
      kind: descriptor.bundle.kind,
      algorithm: descriptor.bundle.algorithm,
      descriptor_encoding: descriptor.bundle.descriptor_encoding,
      assets: descriptor.bundle.assets,
    },
    layer: {
      schema: descriptor.schema,
      kind: descriptor.kind,
      arch: descriptor.arch,
      mount_prefix: descriptor.mount_prefix,
      tap: descriptor.tap,
      tap_lock: descriptor.tap_lock,
      kandelo: descriptor.kandelo,
      bottle_release_tag: descriptor.bottle_release_tag,
      selection: descriptor.selection,
      packages: descriptor.packages,
      base_vfs: descriptor.base_vfs,
      acceptance_vfs: withoutUrl(descriptor.acceptance_vfs),
      acceptance_evidence: {
        descriptor: withoutUrl(descriptor.acceptance_evidence.descriptor),
        report: withoutUrl(descriptor.acceptance_evidence.report),
        node: withoutUrl(descriptor.acceptance_evidence.node),
        browser: withoutUrl(descriptor.acceptance_evidence.browser),
      },
      deferred_trees: descriptor.deferred_trees.map((tree) => ({
        id: tree.id,
        activation: tree.activation,
        content: tree.content,
        transports: tree.transports.map((transport) =>
          transport.kind === "bundle-release"
            ? { kind: transport.kind, asset: transport.asset }
            : transport
        ),
        inventory: tree.inventory,
      })),
    },
  };
}

/** UTF-8 canonical JSON used by both the producer and browser verifier. */
export function canonicalHomebrewRuntimeLayerBundleIdentityBytes(
  descriptor: HomebrewLazyLayerDescriptor,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(sortJson(homebrewRuntimeLayerBundleIdentityDocument(descriptor))),
  );
}

/**
 * Normative public descriptor bytes: recursively sorted compact JSON followed
 * by exactly one LF. Changing this representation requires a new
 * `descriptor_encoding` value, so equal bundle tags cannot acquire new bytes.
 */
export function canonicalHomebrewRuntimeLayerDescriptorBytes(
  descriptor: HomebrewLazyLayerDescriptor,
): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(sortJson(descriptor))}\n`);
}

function withoutUrl(
  value: HomebrewRuntimeLayerReleaseAsset,
): HomebrewRuntimeLayerAssetIdentity {
  return { asset: value.asset, sha256: value.sha256, bytes: value.bytes };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
