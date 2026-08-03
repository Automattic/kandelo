#!/usr/bin/env -S npx tsx

/**
 * Inspect the exact historical Homebrew shell reused by the temporary Pages
 * deployment lane.
 *
 * The image and bootstrap already exist. This tool never rebuilds or repairs
 * them. It verifies their pinned bytes and the small set of properties needed
 * for the current-host browser proof, then records what Pages will serve.
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ABI_VERSION } from "../host/src/generated/abi";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_LOCK_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_BOOTSTRAP_BYTES = 64 * 1024 * 1024;

interface AssetIdentity {
  name: string;
  sha256: string;
  bytes: number;
}

interface GalleryCompatibilityAsset {
  package: string;
  output: string;
  archive: AssetIdentity & {
    member: string;
    member_sha256: string;
    member_bytes: number;
  };
}

interface SourceProjectionCompatibilityAsset
  extends GalleryCompatibilityAsset {
  arch: "wasm32" | "wasm64";
}

interface TransitionalPagesShellLock {
  schema: 1;
  kind: "kandelo-transitional-homebrew-pages-shell-lock";
  lifecycle: "transitional";
  removal_condition: "canonical-kandelo-prefix-shell-is-deployable";
  kernel_abi: number;
  guest_prefix: "/home/linuxbrew/.linuxbrew";
  runtime_support: {
    activation_group: "homebrew-runtime-support";
    formula: "kandelo-dev/tap-core/ruby";
    cache_key_sha256: string;
  };
  historical_build: {
    kandelo_commit: string;
    workflow_run: string;
  };
  package_release: {
    repository: "Automattic/kandelo";
    tag: "binaries-abi-v42";
    authority: "mutable-tag-digest-pinned-public-readback";
    shell_archive: AssetIdentity & {
      member: "artifacts/shell.vfs.zst";
      member_sha256: string;
      member_bytes: number;
    };
    bootstrap_archive: AssetIdentity & {
      members: {
        "homebrew-bootstrap.zip": {
          path: "artifacts/homebrew-bootstrap.zip";
          sha256: string;
          bytes: number;
        };
        "homebrew-brew.env": {
          path: "artifacts/homebrew-brew.env";
          sha256: string;
          bytes: number;
        };
      };
    };
  };
  gallery_compatibility: {
    reason: "reuse-currently-deployed-exact-assets-during-shell-cutover";
    verified_live_base_url: "https://automattic.github.io/kandelo/";
    assets: GalleryCompatibilityAsset[];
  };
  source_projection_compatibility: {
    reason: "reuse-exact-output-after-consumer-only-host-input-change";
    assets: SourceProjectionCompatibilityAsset[];
  };
  bottle_mirror: {
    repository: "Kandelo-dev/homebrew-tap-core";
    tag: string;
    immutable: true;
    asset_count: number;
    plan: AssetIdentity;
  };
}

export interface TransitionalPagesShellInspectionInputs {
  lock: unknown;
  shellArchive: Uint8Array;
  image: Uint8Array;
  bootstrapArchive: Uint8Array;
  bootstrapZip: Uint8Array;
  bootstrapEnvironment: Uint8Array;
  mirrorPlan: Uint8Array;
  galleryCompatibility: Array<{
    package: string;
    archive: Uint8Array;
    output: Uint8Array;
  }>;
  sourceProjectionCompatibility: Array<{
    package: string;
    arch: "wasm32" | "wasm64";
    archive: Uint8Array;
    output: Uint8Array;
  }>;
}

export function createTransitionalPagesShellFetchPlan(
  value: unknown,
): Record<string, unknown> {
  const lock = parseLock(value);
  const releaseRoot =
    `https://github.com/${lock.package_release.repository}/releases/download/` +
    `${lock.package_release.tag}`;
  const mirrorRoot =
    `https://github.com/${lock.bottle_mirror.repository}/releases/download/` +
    `${lock.bottle_mirror.tag}`;
  return {
    schema: 1,
    kind: "kandelo-transitional-homebrew-pages-shell-fetch-plan",
    shell_archive: {
      ...lock.package_release.shell_archive,
      url: `${releaseRoot}/${lock.package_release.shell_archive.name}`,
    },
    bootstrap_archive: {
      ...lock.package_release.bootstrap_archive,
      url: `${releaseRoot}/${lock.package_release.bootstrap_archive.name}`,
    },
    gallery_compatibility: lock.gallery_compatibility.assets.map((asset) => ({
      ...asset,
      archive: {
        ...asset.archive,
        url: `${releaseRoot}/${asset.archive.name}`,
      },
    })),
    source_projection_compatibility:
      lock.source_projection_compatibility.assets.map((asset) => ({
        ...asset,
        archive: {
          ...asset.archive,
          url: `${releaseRoot}/${asset.archive.name}`,
        },
      })),
    mirror_plan: {
      ...lock.bottle_mirror.plan,
      url: `${mirrorRoot}/${lock.bottle_mirror.plan.name}`,
    },
  };
}

export function inspectTransitionalPagesShell(
  inputs: TransitionalPagesShellInspectionInputs,
): Record<string, unknown> {
  const lock = parseLock(inputs.lock);
  if (lock.kernel_abi !== ABI_VERSION) {
    throw new Error(
      `transitional shell ABI ${lock.kernel_abi} differs from source ABI ` +
        `${ABI_VERSION}`,
    );
  }
  assertIdentity(
    inputs.shellArchive,
    lock.package_release.shell_archive,
    "shell package archive",
  );
  assertBytes(
    inputs.image,
    lock.package_release.shell_archive.member_sha256,
    lock.package_release.shell_archive.member_bytes,
    "shell image",
  );
  assertIdentity(
    inputs.bootstrapArchive,
    lock.package_release.bootstrap_archive,
    "bootstrap package archive",
  );
  const bootstrapZip =
    lock.package_release.bootstrap_archive.members["homebrew-bootstrap.zip"];
  const bootstrapEnvironment =
    lock.package_release.bootstrap_archive.members["homebrew-brew.env"];
  assertBytes(
    inputs.bootstrapZip,
    bootstrapZip.sha256,
    bootstrapZip.bytes,
    "Homebrew bootstrap ZIP",
  );
  assertBytes(
    inputs.bootstrapEnvironment,
    bootstrapEnvironment.sha256,
    bootstrapEnvironment.bytes,
    "Homebrew environment",
  );
  assertIdentity(inputs.mirrorPlan, lock.bottle_mirror.plan, "mirror plan");
  assertGalleryCompatibility(inputs.galleryCompatibility, lock);
  assertSourceProjectionCompatibility(
    inputs.sourceProjectionCompatibility,
    lock,
  );
  assertImageContract(inputs.image, lock);

  const releaseRoot =
    `https://github.com/${lock.package_release.repository}/releases/download/` +
    `${lock.package_release.tag}`;
  const mirrorRoot =
    `https://github.com/${lock.bottle_mirror.repository}/releases/download/` +
    `${lock.bottle_mirror.tag}`;
  return {
    schema: 1,
    kind: "kandelo-transitional-homebrew-pages-shell-inspection",
    lifecycle: lock.lifecycle,
    removal_condition: lock.removal_condition,
    exact_current_main: false,
    kernel_abi: lock.kernel_abi,
    guest_prefix: lock.guest_prefix,
    shell: {
      sha256: sha256(inputs.image),
      bytes: inputs.image.byteLength,
      package_url:
        `${releaseRoot}/${lock.package_release.shell_archive.name}`,
      package_sha256: sha256(inputs.shellArchive),
    },
    homebrew_bootstrap: {
      sha256: sha256(inputs.bootstrapZip),
      bytes: inputs.bootstrapZip.byteLength,
      package_url:
        `${releaseRoot}/${lock.package_release.bootstrap_archive.name}`,
    },
    gallery_compatibility: lock.gallery_compatibility.assets.map((asset) => ({
      package: asset.package,
      output: asset.output,
      archive_url: `${releaseRoot}/${asset.archive.name}`,
      archive_sha256: asset.archive.sha256,
      sha256: asset.archive.member_sha256,
      bytes: asset.archive.member_bytes,
      verified_live_base_url:
        lock.gallery_compatibility.verified_live_base_url,
    })),
    source_projection_compatibility:
      lock.source_projection_compatibility.assets.map((asset) => ({
        package: asset.package,
        arch: asset.arch,
        output: asset.output,
        archive_url: `${releaseRoot}/${asset.archive.name}`,
        archive_sha256: asset.archive.sha256,
        sha256: asset.archive.member_sha256,
        bytes: asset.archive.member_bytes,
      })),
    bottle_mirror: {
      immutable: true,
      plan_url: `${mirrorRoot}/${lock.bottle_mirror.plan.name}`,
      plan_sha256: sha256(inputs.mirrorPlan),
      asset_count: lock.bottle_mirror.asset_count,
    },
    runtime_support: lock.runtime_support,
    historical_build: lock.historical_build,
  };
}

function parseLock(value: unknown): TransitionalPagesShellLock {
  const root = exactRecord(value, [
    "schema",
    "kind",
    "lifecycle",
    "removal_condition",
    "kernel_abi",
    "guest_prefix",
    "runtime_support",
    "historical_build",
    "package_release",
    "gallery_compatibility",
    "source_projection_compatibility",
    "bottle_mirror",
  ], "transitional shell lock");
  const runtime = exactRecord(root.runtime_support, [
    "activation_group",
    "formula",
    "cache_key_sha256",
  ], "runtime support");
  const historical = exactRecord(root.historical_build, [
    "kandelo_commit",
    "workflow_run",
  ], "historical build");
  const release = exactRecord(root.package_release, [
    "repository",
    "tag",
    "authority",
    "shell_archive",
    "bootstrap_archive",
  ], "package release");
  const shell = exactRecord(release.shell_archive, [
    "name",
    "sha256",
    "bytes",
    "member",
    "member_sha256",
    "member_bytes",
  ], "shell archive");
  const bootstrap = exactRecord(release.bootstrap_archive, [
    "name",
    "sha256",
    "bytes",
    "members",
  ], "bootstrap archive");
  const members = exactRecord(bootstrap.members, [
    "homebrew-bootstrap.zip",
    "homebrew-brew.env",
  ], "bootstrap members");
  const bootstrapZip = memberRecord(
    members["homebrew-bootstrap.zip"],
    "bootstrap ZIP",
  );
  const bootstrapEnvironment = memberRecord(
    members["homebrew-brew.env"],
    "bootstrap environment",
  );
  const gallery = exactRecord(root.gallery_compatibility, [
    "reason",
    "verified_live_base_url",
    "assets",
  ], "gallery compatibility");
  const galleryAssets = parseGalleryCompatibilityAssets(gallery.assets);
  const sourceProjection = exactRecord(
    root.source_projection_compatibility,
    ["reason", "assets"],
    "source projection compatibility",
  );
  const sourceProjectionAssets = parseSourceProjectionCompatibilityAssets(
    sourceProjection.assets,
  );
  const mirror = exactRecord(root.bottle_mirror, [
    "repository",
    "tag",
    "immutable",
    "asset_count",
    "plan",
  ], "bottle mirror");
  const plan = assetRecord(mirror.plan, "mirror plan");
  assetRecord(shell, "shell archive");
  assetRecord(bootstrap, "bootstrap archive");
  if (
    root.schema !== 1 ||
    root.kind !== "kandelo-transitional-homebrew-pages-shell-lock" ||
    root.lifecycle !== "transitional" ||
    root.removal_condition !==
      "canonical-kandelo-prefix-shell-is-deployable" ||
    !isPositiveInteger(root.kernel_abi) ||
    root.guest_prefix !== "/home/linuxbrew/.linuxbrew" ||
    runtime.activation_group !== "homebrew-runtime-support" ||
    runtime.formula !== "kandelo-dev/tap-core/ruby" ||
    !isSha256(runtime.cache_key_sha256) ||
    typeof historical.kandelo_commit !== "string" ||
    !GIT_SHA_RE.test(historical.kandelo_commit) ||
    historical.workflow_run !==
      "https://github.com/Automattic/kandelo/actions/runs/30532812285" ||
    release.repository !== "Automattic/kandelo" ||
    release.tag !== "binaries-abi-v42" ||
    release.authority !== "mutable-tag-digest-pinned-public-readback" ||
    shell.member !== "artifacts/shell.vfs.zst" ||
    !isSha256(shell.member_sha256) ||
    !isPositiveInteger(shell.member_bytes) ||
    bootstrapZip.path !== "artifacts/homebrew-bootstrap.zip" ||
    bootstrapEnvironment.path !== "artifacts/homebrew-brew.env" ||
    gallery.reason !==
      "reuse-currently-deployed-exact-assets-during-shell-cutover" ||
    gallery.verified_live_base_url !==
      "https://automattic.github.io/kandelo/" ||
    sourceProjection.reason !==
      "reuse-exact-output-after-consumer-only-host-input-change" ||
    mirror.repository !== "Kandelo-dev/homebrew-tap-core" ||
    typeof mirror.tag !== "string" ||
    !/^homebrew-shell-bottles-sha256-[0-9a-f]{64}$/.test(mirror.tag) ||
    mirror.immutable !== true ||
    !isPositiveInteger(mirror.asset_count) ||
    plan.name !== "kandelo-homebrew-bottle-mirror-plan.json"
  ) {
    throw new Error("transitional shell lock is invalid");
  }
  gallery.assets = galleryAssets;
  sourceProjection.assets = sourceProjectionAssets;
  return root as unknown as TransitionalPagesShellLock;
}

function parseGalleryCompatibilityAssets(
  value: unknown,
): GalleryCompatibilityAsset[] {
  const expected = [
    ["lamp", "lamp.vfs.zst", "artifacts/lamp.vfs.zst"],
    [
      "nginx-php-vfs",
      "nginx-php.vfs.zst",
      "artifacts/nginx-php.vfs.zst",
    ],
    ["nginx-vfs", "nginx.vfs.zst", "artifacts/nginx.vfs.zst"],
    ["node-vfs", "node-vfs.vfs.zst", "artifacts/node-vfs.vfs.zst"],
    ["wordpress", "wordpress.vfs.zst", "artifacts/wordpress.vfs.zst"],
  ] as const;
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error("gallery compatibility asset set is invalid");
  }
  return value.map((entry, index) => {
    const record = exactRecord(
      entry,
      ["package", "output", "archive"],
      "gallery compatibility asset",
    );
    const archive = exactRecord(record.archive, [
      "name",
      "sha256",
      "bytes",
      "member",
      "member_sha256",
      "member_bytes",
    ], "gallery compatibility archive");
    assetRecord(archive, "gallery compatibility archive");
    const [packageName, output, member] = expected[index]!;
    if (
      record.package !== packageName || record.output !== output ||
      archive.member !== member || !isSha256(archive.member_sha256) ||
      !isPositiveInteger(archive.member_bytes)
    ) {
      throw new Error("gallery compatibility asset is invalid");
    }
    return {
      package: packageName,
      output,
      archive: archive as unknown as GalleryCompatibilityAsset["archive"],
    };
  });
}

function parseSourceProjectionCompatibilityAssets(
  value: unknown,
): SourceProjectionCompatibilityAsset[] {
  const expected = [
    ["kandelo-sdk", "wasm32", "kandelo-sdk.vfs.zst",
      "artifacts/kandelo-sdk.vfs.zst"],
    ["mariadb-test", "wasm32", "mariadb-test.vfs.zst",
      "artifacts/mariadb-test.vfs.zst"],
    ["mariadb-vfs", "wasm32", "mariadb-vfs.vfs.zst",
      "artifacts/mariadb-vfs.vfs.zst"],
    ["mariadb-vfs", "wasm64", "mariadb-vfs.vfs.zst",
      "artifacts/mariadb-vfs.vfs.zst"],
    ["redis-vfs", "wasm32", "redis.vfs.zst",
      "artifacts/redis.vfs.zst"],
    ["rootfs", "wasm32", "rootfs.vfs", "artifacts/rootfs.vfs"],
  ] as const;
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error("source projection compatibility asset set is invalid");
  }
  return value.map((entry, index) => {
    const record = exactRecord(
      entry,
      ["package", "arch", "output", "archive"],
      "source projection compatibility asset",
    );
    const archive = exactRecord(record.archive, [
      "name",
      "sha256",
      "bytes",
      "member",
      "member_sha256",
      "member_bytes",
    ], "source projection compatibility archive");
    assetRecord(archive, "source projection compatibility archive");
    const [packageName, arch, output, member] = expected[index]!;
    if (
      record.package !== packageName || record.arch !== arch ||
      record.output !== output || archive.member !== member ||
      !isSha256(archive.member_sha256) ||
      !isPositiveInteger(archive.member_bytes)
    ) {
      throw new Error("source projection compatibility asset is invalid");
    }
    return {
      package: packageName,
      arch,
      output,
      archive:
        archive as unknown as SourceProjectionCompatibilityAsset["archive"],
    };
  });
}

function assertImageContract(
  image: Uint8Array,
  lock: TransitionalPagesShellLock,
): void {
  const metadata = MemoryFileSystem.readImageMetadata(image);
  const root = requireRecord(metadata, "shell image metadata");
  const bootstrap = requireRecord(root.homebrewBootstrap, "Homebrew bootstrap");
  const entrypoint = requireRecord(bootstrap.entrypoint, "brew entrypoint");
  const ownership = requireRecord(bootstrap.ownership, "brew ownership");
  const environment = requireRecord(bootstrap.environment, "brew environment");
  const homebrew = requireRecord(root.homebrew, "Homebrew composition");
  const defaultShell = requireRecord(homebrew.defaultShell, "default shell");
  const materialization = requireRecord(
    homebrew.materialization,
    "Homebrew materialization",
  );
  const mirror = requireRecord(materialization.bottle_mirror, "bottle mirror");
  const runtime = requireRecord(
    materialization.runtime_support,
    "runtime support",
  );
  const packages = Array.isArray(homebrew.packages) ? homebrew.packages : [];
  const ruby = packages.filter((value) => {
    const record = requireRecord(value, "Homebrew package");
    return record.fullName === lock.runtime_support.formula;
  });
  const trees = Array.isArray(root.packageDeferredTrees)
    ? root.packageDeferredTrees
    : [];
  if (trees.length !== 1) {
    throw new Error("transitional image has an unexpected bootstrap tree set");
  }
  const tree = requireRecord(trees[0], "bootstrap tree");
  const treeArchive = requireRecord(tree.archive, "bootstrap tree archive");
  const activation = requireRecord(tree.activation, "bootstrap activation");
  const atomicGroup = requireRecord(activation.atomicGroup, "activation group");
  if (
    root.kernelAbi !== lock.kernel_abi ||
    entrypoint.path !== "/usr/bin/brew" ||
    entrypoint.target !== `${lock.guest_prefix}/bin/brew` ||
    ownership.prefix !== lock.guest_prefix ||
    environment.path !== "/etc/homebrew/brew.env" ||
    environment.sha256 !==
      lock.package_release.bootstrap_archive.members["homebrew-brew.env"]
        .sha256 ||
    environment.bytes !==
      lock.package_release.bootstrap_archive.members["homebrew-brew.env"]
        .bytes ||
    defaultShell.path !== `${lock.guest_prefix}/bin/bash` ||
    tree.id !== "homebrew-bootstrap/source-tree" ||
    tree.state !== "deferred" ||
    treeArchive.url !== "homebrew-bootstrap.zip" ||
    treeArchive.sha256 !==
      lock.package_release.bootstrap_archive.members["homebrew-bootstrap.zip"]
        .sha256 ||
    treeArchive.bytes !==
      lock.package_release.bootstrap_archive.members["homebrew-bootstrap.zip"]
        .bytes ||
    activation.mode !== "first-use" ||
    atomicGroup.id !== lock.runtime_support.activation_group ||
    typeof mirror.repository !== "string" ||
    mirror.repository.toLowerCase() !==
      lock.bottle_mirror.repository.toLowerCase() ||
    mirror.tag !== lock.bottle_mirror.tag ||
    mirror.asset_count !== lock.bottle_mirror.asset_count ||
    mirror.manifest_sha256 !== lock.bottle_mirror.plan.sha256 ||
    mirror.manifest_bytes !== lock.bottle_mirror.plan.bytes ||
    !Array.isArray(runtime.package_order) ||
    runtime.package_order.length !== 1 ||
    runtime.package_order[0] !== lock.runtime_support.formula ||
    ruby.length !== 1 ||
    requireRecord(ruby[0], "Ruby package").cacheKeySha !==
      lock.runtime_support.cache_key_sha256
  ) {
    throw new Error("transitional shell image differs from its locked contract");
  }
}

function assertGalleryCompatibility(
  inputs: TransitionalPagesShellInspectionInputs["galleryCompatibility"],
  lock: TransitionalPagesShellLock,
): void {
  if (inputs.length !== lock.gallery_compatibility.assets.length) {
    throw new Error("gallery compatibility input set is incomplete");
  }
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]!;
    const expected = lock.gallery_compatibility.assets[index]!;
    if (input.package !== expected.package) {
      throw new Error("gallery compatibility input order is invalid");
    }
    assertIdentity(
      input.archive,
      expected.archive,
      `${expected.package} compatibility archive`,
    );
    assertBytes(
      input.output,
      expected.archive.member_sha256,
      expected.archive.member_bytes,
      `${expected.package} compatibility output`,
    );
  }
}

function assertSourceProjectionCompatibility(
  inputs:
    TransitionalPagesShellInspectionInputs["sourceProjectionCompatibility"],
  lock: TransitionalPagesShellLock,
): void {
  const expected = lock.source_projection_compatibility.assets;
  if (inputs.length !== expected.length) {
    throw new Error("source projection compatibility input set is incomplete");
  }
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index]!;
    const asset = expected[index]!;
    if (input.package !== asset.package || input.arch !== asset.arch) {
      throw new Error("source projection compatibility input order is invalid");
    }
    assertIdentity(
      input.archive,
      asset.archive,
      `${asset.package} ${asset.arch} compatibility archive`,
    );
    assertBytes(
      input.output,
      asset.archive.member_sha256,
      asset.archive.member_bytes,
      `${asset.package} ${asset.arch} compatibility output`,
    );
  }
}

function assetRecord(value: unknown, label: string): AssetIdentity {
  const record = requireRecord(value, label);
  if (
    typeof record.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(record.name) ||
    !isSha256(record.sha256) ||
    !isPositiveInteger(record.bytes)
  ) {
    throw new Error(`${label} identity is invalid`);
  }
  return record as unknown as AssetIdentity;
}

function memberRecord(value: unknown, label: string): {
  path: string;
  sha256: string;
  bytes: number;
} {
  const record = exactRecord(value, ["path", "sha256", "bytes"], label);
  if (
    typeof record.path !== "string" ||
    !isSha256(record.sha256) ||
    !isPositiveInteger(record.bytes)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return record as unknown as {
    path: string;
    sha256: string;
    bytes: number;
  };
}

function assertIdentity(
  bytes: Uint8Array,
  identity: AssetIdentity,
  label: string,
): void {
  assertBytes(bytes, identity.sha256, identity.bytes, label);
}

function assertBytes(
  bytes: Uint8Array,
  expectedSha256: string,
  expectedBytes: number,
  label: string,
): void {
  if (
    bytes.byteLength !== expectedBytes ||
    sha256(bytes) !== expectedSha256
  ) {
    throw new Error(`${label} differs from its locked identity`);
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has unsupported fields`);
  }
  return record;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRegularFile(
  path: string,
  label: string,
  maxBytes: number,
): Uint8Array {
  const stat = lstatSync(path);
  if (
    !stat.isFile() || stat.isSymbolicLink() || stat.size < 1 ||
    stat.size > maxBytes
  ) {
    throw new Error(`${label} must be one bounded regular file`);
  }
  return new Uint8Array(readFileSync(path));
}

function readCanonicalLock(path: string): unknown {
  const bytes = readRegularFile(path, "transition lock", MAX_LOCK_BYTES);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text) as unknown;
  if (`${JSON.stringify(value, null, 2)}\n` !== text) {
    // WHY: canonical byte equality rejects duplicate JSON keys and makes the
    // reviewed lock the only authority, rather than JSON parser behavior.
    throw new Error("transition lock is not canonical JSON");
  }
  return value;
}

interface CliOptions {
  lock: string;
  shellArchive: string;
  image: string;
  bootstrapArchive: string;
  bootstrapZip: string;
  bootstrapEnvironment: string;
  mirrorPlan: string;
  galleryRoot: string;
  report: string;
}

function parseArgs(args: string[]): CliOptions {
  const allowed = new Set([
    "--lock",
    "--shell-archive",
    "--image",
    "--bootstrap-archive",
    "--bootstrap-zip",
    "--bootstrap-env",
    "--mirror-plan",
    "--gallery-root",
    "--report",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined || value === undefined || !allowed.has(key) ||
      values.has(key)
    ) {
      return usage();
    }
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) return usage();
    return resolve(value);
  };
  return {
    lock: required("--lock"),
    shellArchive: required("--shell-archive"),
    image: required("--image"),
    bootstrapArchive: required("--bootstrap-archive"),
    bootstrapZip: required("--bootstrap-zip"),
    bootstrapEnvironment: required("--bootstrap-env"),
    mirrorPlan: required("--mirror-plan"),
    galleryRoot: required("--gallery-root"),
    report: required("--report"),
  };
}

function usage(): never {
  throw new Error(
    "usage: inspect-transitional-homebrew-pages-shell.ts " +
      "--lock <lock.json> --shell-archive <package.tar.zst> " +
      "--image <shell.vfs.zst> " +
      "--bootstrap-archive <package.tar.zst> " +
      "--bootstrap-zip <homebrew-bootstrap.zip> " +
      "--bootstrap-env <homebrew-brew.env> " +
      "--mirror-plan <plan.json> --gallery-root <prepared-root> " +
      "--report <new-report.json>",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.length === 4 && args[0] === "--lock" &&
    args[1] !== undefined && args[1].length > 0 &&
    args[2] === "--fetch-plan" &&
    args[3] !== undefined && args[3].length > 0
  ) {
    const plan = createTransitionalPagesShellFetchPlan(
      readCanonicalLock(resolve(args[1])),
    );
    writeFileSync(
      resolve(args[3]),
      `${JSON.stringify(plan, null, 2)}\n`,
      { flag: "wx", mode: 0o644 },
    );
    return;
  }
  const options = parseArgs(args);
  const lock = readCanonicalLock(options.lock);
  const parsedLock = parseLock(lock);
  const report = inspectTransitionalPagesShell({
    lock,
    shellArchive: readRegularFile(
      options.shellArchive,
      "shell package archive",
      MAX_PACKAGE_ARCHIVE_BYTES,
    ),
    image: readRegularFile(options.image, "shell image", MAX_IMAGE_BYTES),
    bootstrapArchive: readRegularFile(
      options.bootstrapArchive,
      "bootstrap package archive",
      MAX_PACKAGE_ARCHIVE_BYTES,
    ),
    bootstrapZip: readRegularFile(
      options.bootstrapZip,
      "bootstrap ZIP",
      MAX_BOOTSTRAP_BYTES,
    ),
    bootstrapEnvironment: readRegularFile(
      options.bootstrapEnvironment,
      "bootstrap environment",
      1024,
    ),
    mirrorPlan: readRegularFile(options.mirrorPlan, "mirror plan", 1024 * 1024),
    galleryCompatibility: parsedLock.gallery_compatibility.assets.map(
      (asset) => ({
        package: asset.package,
        archive: readRegularFile(
          join(
            options.galleryRoot,
            "sources",
            "gallery",
            `${asset.package}.tar.zst`,
          ),
          `${asset.package} compatibility archive`,
          MAX_PACKAGE_ARCHIVE_BYTES,
        ),
        output: readRegularFile(
          join(
            options.galleryRoot,
            "gallery",
            asset.package,
            asset.output,
          ),
          `${asset.package} compatibility output`,
          MAX_IMAGE_BYTES,
        ),
      }),
    ),
    sourceProjectionCompatibility:
      parsedLock.source_projection_compatibility.assets.map((asset) => ({
        package: asset.package,
        arch: asset.arch,
        archive: readRegularFile(
          join(
            options.galleryRoot,
            "sources",
            "source-projection",
            `${asset.package}-${asset.arch}.tar.zst`,
          ),
          `${asset.package} ${asset.arch} compatibility archive`,
          MAX_PACKAGE_ARCHIVE_BYTES,
        ),
        output: readRegularFile(
          join(
            options.galleryRoot,
            "source-projection",
            asset.arch,
            asset.package,
            asset.output,
          ),
          `${asset.package} ${asset.arch} compatibility output`,
          MAX_IMAGE_BYTES,
        ),
      })),
  });
  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
