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
  path: string;
  type: "directory" | "file" | "symlink";
  ownership: "layer" | "shared-base-directory";
  mode: number;
  size: number;
  target?: string;
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
  schema: 2;
  kind: "kandelo-homebrew-lazy-archive";
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
  archive: {
    format: "zip";
    /** Per-runtime publication may use a distinct immutable ZIP asset name. */
    asset: string;
    url: string;
    sha256: string;
    bytes: number;
    entry_count: number;
    layer_entry_count: number;
    shared_base_directory_count: number;
    uncompressed_bytes: number;
  };
  entries: HomebrewLazyLayerEntry[];
}
