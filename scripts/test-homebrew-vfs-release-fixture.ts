import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildHomebrewOriginalBottleCollection,
  type HomebrewLazyLayerDraftDescriptor,
} from "../host/src/homebrew-lazy-layer";
import type {
  HomebrewFederatedVfsPlan,
  HomebrewLinkManifest,
  HomebrewVfsPackagePlan,
} from "../host/src/homebrew-vfs-planner";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";

const [sourceRoot, rootTap, dependencyTap, bottleRoot] = process.argv.slice(2);
if (!sourceRoot || !rootTap || !dependencyTap || !bottleRoot) {
  throw new Error(
    "usage: test-homebrew-vfs-release-fixture.ts SOURCE ROOT_TAP DEPENDENCY_TAP BOTTLES",
  );
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const report = readJson<{
  metadata: {
    tap_repository: string;
    tap_name: string;
    tap_commit: string;
    kandelo_repository: string;
    kandelo_commit: string;
    kandelo_abi: number;
    release_tag: string;
  };
  packages: Array<Record<string, unknown>>;
}>(join(sourceRoot, "report.json"));
const descriptor = readJson<HomebrewLazyLayerDraftDescriptor>(join(sourceRoot, "layer.json"));

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function numberField(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return value as number;
}

const packagePlans: HomebrewVfsPackagePlan[] = report.packages.map((raw) => {
  const name = stringField(raw.name, "package name");
  const tapName = stringField(raw.tap_name, `${name} tap name`);
  const tapRoot = tapName === report.metadata.tap_name ? rootTap : dependencyTap;
  const linkManifestPath = stringField(raw.link_manifest, `${name} link manifest`);
  const linkManifest = readJson<HomebrewLinkManifest>(join(tapRoot, linkManifestPath));
  const builtFrom = raw.built_from as Record<string, unknown>;
  return {
    name,
    fullName: stringField(raw.full_name, `${name} full name`),
    tapRepository: stringField(raw.tap_repository, `${name} tap repository`),
    tapName,
    tapCommit: stringField(raw.tap_commit, `${name} tap commit`),
    kandeloRepository: stringField(builtFrom.kandelo_repository, `${name} Kandelo repository`),
    kandeloCommit: stringField(builtFrom.kandelo_commit, `${name} Kandelo commit`),
    version: stringField(raw.version, `${name} version`),
    formulaRevision: 0,
    bottleRebuild: 0,
    arch: "wasm32",
    kandeloAbi: report.metadata.kandelo_abi,
    metadataStatus: "success",
    sourceStatus: "success",
    url: stringField(raw.url, `${name} URL`),
    sha256: stringField(raw.sha256, `${name} digest`),
    bytes: numberField(raw.bytes, `${name} bytes`),
    cacheKeySha: stringField(raw.cache_key_sha, `${name} cache key`),
    prefix: linkManifest.prefix,
    cellar: linkManifest.cellar,
    keg: linkManifest.keg,
    payloadRoot: linkManifest.bottle.payload_root,
    linkManifestPath,
    linkManifest,
    dependencies: name === "file-formula"
      ? [{ name: "dash", full_name: "third-party/runtime/dash", version: "0.5.12" }]
      : [],
    runtimeSupport: ["node"],
    browserCompatible: false,
    builtFrom: {
      tapRepository: stringField(builtFrom.tap_repository, `${name} build tap repository`),
      tapCommit: stringField(builtFrom.tap_commit, `${name} build tap commit`),
      kandeloRepository: stringField(
        builtFrom.kandelo_repository,
        `${name} build Kandelo repository`,
      ),
      kandeloCommit: stringField(builtFrom.kandelo_commit, `${name} build Kandelo commit`),
      formulaSha256: stringField(builtFrom.formula_sha256, `${name} Formula digest`),
    },
  };
});

const plan: HomebrewFederatedVfsPlan = {
  schema: 1,
  tapRepository: report.metadata.tap_repository,
  tapName: report.metadata.tap_name,
  tapCommit: report.metadata.tap_commit,
  kandeloRepository: report.metadata.kandelo_repository,
  kandeloCommit: report.metadata.kandelo_commit,
  kandeloAbi: report.metadata.kandelo_abi,
  releaseTag: report.metadata.release_tag,
  requestedPackages: ["file-formula"],
  requestedFullNames: ["kandelo-dev/tap-core/file-formula"],
  packages: packagePlans,
  taps: descriptor.tap_lock.map((tap) => ({
    tapRepository: tap.repository,
    tapName: tap.name,
    tapCommit: tap.commit,
    kandeloRepository: tap.kandelo_repository,
    kandeloCommit: tap.kandelo_commit,
    kandeloAbi: tap.kandelo_abi,
    releaseTag: tap.bottle_release_tag,
  })),
};

const bottleByPackage = new Map(packagePlans.map((pkg) => [
  pkg.fullName,
  new Uint8Array(readFileSync(join(bottleRoot, `${pkg.name}.bottle.tar.gz`))),
]));
const collection = await buildHomebrewOriginalBottleCollection(plan, {
  fs: MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024)),
  baseFs: MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024)),
  loadBottleBytes(pkg) {
    const bytes = bottleByPackage.get(pkg.fullName);
    if (bytes === undefined) throw new Error(`missing fixture bottle ${pkg.fullName}`);
    return bytes;
  },
  compatibilityPolicy: {
    mirror_link_manifest_bin: { targets: [] },
    link_conflict_owners: [],
    aliases: [],
  },
  treeIdOverrides: new Map([["kandelo-dev/tap-core/file-formula", "file-formula"]]),
});

descriptor.schema = 5;
descriptor.selection.requested_packages = [...plan.requestedPackages];
descriptor.selection.package_order = packagePlans.map((pkg) => pkg.fullName);
descriptor.selection.base_package_order = [];
descriptor.selection.layer_package_order = packagePlans.map((pkg) => pkg.fullName);
descriptor.packages = { base: [], layer: collection.packages };
descriptor.base_vfs.composition.package_order = ["kandelo-dev/tap-core/base-only"];
descriptor.base_vfs.composition.package_count = 1;
descriptor.deferred_trees = collection.deferredTrees;
writeFileSync(
  join(sourceRoot, "layer.json"),
  `${JSON.stringify(descriptor, null, 2)}\n`,
);

for (const payload of collection.payloads) {
  const path = payload.id === "file-formula"
    ? join(sourceRoot, "direct-root.bin")
    : join(sourceRoot, payload.asset);
  writeFileSync(path, payload.bytes);
}
