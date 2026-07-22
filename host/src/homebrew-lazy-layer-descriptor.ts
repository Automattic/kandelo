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
  /**
   * Absent only on the already-published ZIP-v1 inventory contract.
   * Original-bottle trees distinguish decoded members from structural paths
   * created directly from the signed descriptor.
   */
  materialization?:
    | "archive"
    /** Archive bytes relocated only when named by INSTALL_RECEIPT.json. */
    | "archive-homebrew-relocate"
    | "archive-copy"
    /** A link-manifest copy whose reviewed mode intentionally differs. */
    | "archive-copy-mode"
    | "descriptor";
  type: "directory" | "file" | "symlink" | "hardlink";
  ownership: "layer" | "shared-base-directory" | "mergeable-directory";
  mode: number;
  /** Logical guest size. Hard links repeat their canonical file's size. */
  size: number;
  /** Symlink text, or the canonical guest path for a hard link. */
  target?: string;
  /** Stable identity shared by one regular file and all of its hard links. */
  inode_group?: string;
}

/** Exact filesystem-member truth decoded from one immutable source object. */
export interface HomebrewDeferredTreeSourceEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "hardlink";
  mode: number;
  /** TAR/ZIP member payload size; links and directories carry zero bytes. */
  size: number;
  /** Exact symlink text, or canonical source member named by a hard link. */
  target?: string;
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
  /** Explicit Formula ownership for a byte-identical original bottle tree. */
  package?: string;
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
    /** Legacy schema-4 directories which must already exist in the base. */
    shared_base_directory_count?: number;
    /** Schema-5 directories which may be created once or merged with a real directory. */
    mergeable_directory_count?: number;
    /** Decoder expansion bound (ZIP member bytes or complete TAR bytes). */
    expanded_bytes: number;
    /** Bytes allocated once per regular inode, excluding hard-link aliases. */
    payload_bytes: number;
    /**
     * Decoder-conditional original-bottle contract. Legacy ZIP descriptors
     * omit it and retain their historical one-source-per-entry meaning.
     */
    source?: {
      schema: 1;
      kind: "homebrew-bottle-tar-gzip-v1";
      entries: HomebrewDeferredTreeSourceEntry[];
    };
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

/** One immutable transport object emitted by the producer. */
export interface HomebrewLazyLayerPayload {
  id: string;
  asset: string;
  bytes: Uint8Array;
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
  /** Schema 4 is the exact legacy ZIP contract; schema 5 owns original bottles. */
  schema: 4 | 5;
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
        ...(tree.package === undefined ? {} : { package: tree.package }),
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
  if (typeof value === "string") {
    assertHomebrewCanonicalText(value);
    return value;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareHomebrewCanonicalText(left, right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

/**
 * Python orders Unicode strings by scalar value, while JavaScript's relational
 * operators compare UTF-16 code units. Compare decoded scalars explicitly so
 * canonical-json-v1 has one cross-host key order for non-BMP text.
 */
export function compareHomebrewCanonicalText(left: string, right: string): number {
  assertHomebrewCanonicalText(left);
  assertHomebrewCanonicalText(right);
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftScalar = left.codePointAt(leftOffset)!;
    const rightScalar = right.codePointAt(rightOffset)!;
    if (leftScalar !== rightScalar) return leftScalar < rightScalar ? -1 : 1;
    leftOffset += leftScalar > 0xffff ? 2 : 1;
    rightOffset += rightScalar > 0xffff ? 2 : 1;
  }
  return leftOffset < left.length ? 1 : rightOffset < right.length ? -1 : 0;
}

export function assertHomebrewCanonicalText(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (
      unit <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      index += 1;
      continue;
    }
    throw new Error("canonical-json-v1 strings must contain only Unicode scalar values");
  }
}
