/**
 * Candidate-only entrypoint for composing a Homebrew VFS with an embedded
 * boot closure and independently deferred bottle trees.
 *
 * The canonical eager image entrypoint deliberately does not import the
 * materialization composer. This module owns that dependency and injects the
 * strategy into the shared planner, image metadata, and serialization path.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertHomebrewBottleMirrorBundle,
  assertHomebrewVfsMaterialization,
  buildHomebrewMaterializedVfs,
  type HomebrewMaterializedVfsBuildResult,
} from "../../../host/src/homebrew-vfs-composer";
import {
  runHomebrewVfsImageBuilder,
  type HomebrewVfsImageMaterializer,
} from "./build-homebrew-vfs-image";

const materializeHomebrewVfs: HomebrewVfsImageMaterializer = async (
  plan,
  options,
) => {
  const result = await buildHomebrewMaterializedVfs(plan, options);
  return {
    result,
    assert(fs) {
      assertHomebrewVfsMaterialization(fs, result.evidence);
    },
    writeBottleMirrorBundle(outputDirectory) {
      return writeBottleMirrorBundle(outputDirectory, result);
    },
  };
};

function writeBottleMirrorBundle(
  outputDirectory: string,
  result: HomebrewMaterializedVfsBuildResult,
) {
  assertHomebrewBottleMirrorBundle(
    result.mirrorPlan,
    result.mirrorPayloads,
    result.mirrorPlanAsset,
  );
  const directory = resolve(outputDirectory);
  if (existsSync(directory)) {
    throw new Error(`bottle mirror output already exists: ${directory}`);
  }
  mkdirSync(dirname(directory), { recursive: true });
  mkdirSync(directory);

  const payloadByPackage = new Map(
    result.mirrorPayloads.map((payload) => [payload.package, payload]),
  );
  const assets = result.mirrorPlan.assets.map((asset) => {
    const payload = payloadByPackage.get(asset.package);
    if (
      payload === undefined ||
      payload.id !== asset.id ||
      payload.asset !== asset.asset ||
      payload.sha256 !== asset.sha256 ||
      payload.bytes.byteLength !== asset.bytes ||
      basename(asset.asset) !== asset.asset
    ) {
      throw new Error(`bottle mirror output differs for ${asset.package}`);
    }
    const assetPath = join(directory, asset.asset);
    writeFileSync(assetPath, payload.bytes, { flag: "wx" });
    assertExactHostFile(
      assetPath,
      asset.sha256,
      asset.bytes,
      "bottle mirror payload",
    );
    return {
      id: asset.id,
      package: asset.package,
      asset: asset.asset,
      sha256: asset.sha256,
      bytes: asset.bytes,
      url: asset.url,
    };
  });
  const planPath = join(directory, result.mirrorPlanAsset.asset);
  writeFileSync(planPath, result.mirrorPlanAsset.bytes, { flag: "wx" });
  assertExactHostFile(
    planPath,
    result.mirrorPlanAsset.sha256,
    result.mirrorPlanAsset.bytes.byteLength,
    "bottle mirror plan",
  );
  return {
    repository: result.mirrorPlan.repository,
    tag: result.mirrorPlan.tag,
    collection_sha256: result.mirrorPlan.collection_sha256,
    plan: {
      asset: result.mirrorPlanAsset.asset,
      sha256: result.mirrorPlanAsset.sha256,
      bytes: result.mirrorPlanAsset.bytes.byteLength,
    },
    assets,
  };
}

function assertExactHostFile(
  path: string,
  expectedSha256: string,
  expectedBytes: number,
  label: string,
): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== expectedBytes) {
    throw new Error(`${label} has the wrong file identity: ${path}`);
  }
  const actualSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${label} has the wrong sha256: ${path}`);
  }
}

runHomebrewVfsImageBuilder(
  process.argv.slice(2),
  materializeHomebrewVfs,
).catch((err) => {
  console.error(err);
  process.exit(1);
});
