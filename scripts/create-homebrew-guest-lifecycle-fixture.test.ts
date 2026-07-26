import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-vfs-composer";
import {
  homebrewRuntimeLayerPayloadAsset,
} from "../host/src/homebrew-runtime-layer-limits";
import {
  projectHomebrewGuestLifecycleBrowserFixture,
} from "../homebrew/test/homebrew_guest_lifecycle_browser_fixture";
import {
  createHomebrewGuestLifecycleFixture,
} from "./create-homebrew-guest-lifecycle-fixture";

test("creates one exact closed-browser lifecycle fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "homebrew-lifecycle-fixture-"));
  try {
    const image = write(root, "main-shell.vfs.zst", new Uint8Array([1]));
    const spec = write(root, "tree.json", new Uint8Array([2]));
    const archive = write(root, "homebrew-bootstrap.zip", new Uint8Array([3]));
    const environment = write(root, "homebrew-brew.env", new Uint8Array([4]));
    const mirror = join(root, "mirror");
    mkdirSync(mirror);
    const payloadBytes = new Uint8Array([5, 6]);
    const plan = mirrorPlan(payloadBytes);
    writeFileSync(
      join(mirror, HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET),
      encodeHomebrewBottleMirrorPlan(plan),
    );
    writeFileSync(join(mirror, plan.assets[0]!.asset), payloadBytes);
    const out = join(root, "fixture.json");

    createHomebrewGuestLifecycleFixture({
      image,
      bootstrapSpec: spec,
      bootstrapArchive: archive,
      bootstrapEnvironment: environment,
      bottleMirror: mirror,
      fixedAssetUrlRoot: "https://closed.example.test/run/",
      coreRevision: "1".repeat(40),
      canaryRevision: "2".repeat(40),
      timeoutMs: 900_000,
      out,
    });

    const fixture = projectHomebrewGuestLifecycleBrowserFixture(
      JSON.parse(readFileSync(out, "utf8")),
    );
    assert.equal(
      fixture.image.url,
      "https://closed.example.test/run/main-shell.vfs.zst",
    );
    assert.equal(
      fixture.bottleMirror.plan.url,
      `${plan.release_root}/${plan.manifest_asset}`,
    );
    assert.deepEqual(fixture.bottleMirror.payloads, [{
      asset: plan.assets[0]!.asset,
      url: plan.assets[0]!.url,
      sha256: plan.assets[0]!.sha256,
      bytes: payloadBytes.byteLength,
    }]);

    writeFileSync(join(mirror, plan.assets[0]!.asset), new Uint8Array([9, 9]));
    assert.throws(
      () =>
        createHomebrewGuestLifecycleFixture({
          image,
          bootstrapSpec: spec,
          bootstrapArchive: archive,
          bootstrapEnvironment: environment,
          bottleMirror: mirror,
          fixedAssetUrlRoot: "https://closed.example.test/run/",
          coreRevision: "1".repeat(40),
          canaryRevision: "2".repeat(40),
          timeoutMs: 900_000,
          out: join(root, "changed.json"),
        }),
      /changed identity/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mirrorPlan(payload: Uint8Array): HomebrewBottleMirrorPlan {
  const repository = "example/project";
  const identity = {
    id: "bottle-test",
    package: "example/tap/test",
    asset: homebrewRuntimeLayerPayloadAsset("bottle-test"),
    sha256: sha256(payload),
    bytes: payload.byteLength,
  };
  const collection = sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(repository, [identity]),
  );
  const tag = `homebrew-shell-bottles-sha256-${collection}`;
  const releaseRoot =
    `https://github.com/${repository}/releases/download/${tag}`;
  return {
    schema: 1,
    kind: HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
    repository,
    collection_sha256: collection,
    tag,
    release_root: releaseRoot,
    manifest_asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    assets: [{
      ...identity,
      url: `${releaseRoot}/${identity.asset}`,
    }],
  };
}

function write(
  root: string,
  name: string,
  bytes: Uint8Array,
): string {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
