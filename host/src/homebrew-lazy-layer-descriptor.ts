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
  transports: Array<{ url: string }>;
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

export interface HomebrewLazyLayerDescriptor {
  schema: 3;
  kind: "kandelo-homebrew-deferred-layer";
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
  release: {
    repository: string;
    tag: string;
  };
  acceptance_vfs: {
    asset: "kandelo-homebrew.vfs.zst";
    url: string;
    sha256: string;
    bytes: number;
  };
  /** One or more independently materialized immutable filesystem trees. */
  deferred_trees: HomebrewDeferredTreeDescriptor[];
}
