import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SerializedLazyArchiveEntry } from "../host/src/vfs/memory-fs";
import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-vfs-composer";
import { homebrewRuntimeLayerPayloadAsset } from
  "../host/src/homebrew-runtime-layer-limits";
import {
  decodeHomebrewBottleMirrorPlan,
  loadHomebrewBottleMirrorBindings,
} from "./homebrew-closed-lazy-assets";

const payloadBytes = new Uint8Array([1, 2, 3, 4]);

test("loads exact local bytes under their immutable public URL identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-closed-bottles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createFixture(root);

  assert.deepEqual(
    loadHomebrewBottleMirrorBindings(
      fixture.planPath,
      fixture.planBytes,
      [fixture.pendingTree],
    ),
    [{
      url: fixture.plan.assets[0]!.url,
      sha256: sha256(payloadBytes),
      size: payloadBytes.byteLength,
      bytes: payloadBytes,
    }],
  );
});

test("rejects a plan that differs from the exact image-embedded bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-closed-bottles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createFixture(root);
  const changed = fixture.planBytes.slice();
  changed[0] ^= 1;
  assert.throws(
    () => loadHomebrewBottleMirrorBindings(
      fixture.planPath,
      changed,
      [fixture.pendingTree],
    ),
    /differs from the exact VFS-embedded plan/,
  );
});

test("rejects symlinked payloads even when their bytes match", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-closed-bottles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createFixture(root, false);
  const externalPayload = join(root, "external-payload");
  writeFileSync(externalPayload, payloadBytes);
  symlinkSync(externalPayload, fixture.payloadPath);
  assert.throws(
    () => loadHomebrewBottleMirrorBindings(
      fixture.planPath,
      fixture.planBytes,
      [fixture.pendingTree],
    ),
    /not a regular non-symlink file/,
  );
});

test("decodes only a structurally and derivationally valid mirror plan", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-closed-bottles-"));
  try {
    const fixture = createFixture(root);
    assert.deepEqual(
      decodeHomebrewBottleMirrorPlan(fixture.planBytes, "fixture"),
      fixture.plan,
    );
    const changed = encodeHomebrewBottleMirrorPlan({
      ...fixture.plan,
      collection_sha256: "0".repeat(64),
    });
    assert.throws(
      () => decodeHomebrewBottleMirrorPlan(changed, "fixture"),
      /inconsistent derived identity/,
    );
    assert.throws(
      () => decodeHomebrewBottleMirrorPlan(
        new TextEncoder().encode(JSON.stringify(fixture.plan)),
        "fixture",
      ),
      /bytes are not canonical/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(root: string, writePayload = true): {
  plan: HomebrewBottleMirrorPlan;
  planBytes: Uint8Array;
  planPath: string;
  payloadPath: string;
  pendingTree: SerializedLazyArchiveEntry;
} {
  const repository = "example/project";
  const identity = {
    id: "bottle-test",
    package: "example/tap/test",
    asset: homebrewRuntimeLayerPayloadAsset("bottle-test"),
    sha256: sha256(payloadBytes),
    bytes: payloadBytes.byteLength,
  };
  const collection = sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(repository, [identity]),
  );
  const tag = `homebrew-shell-bottles-sha256-${collection}`;
  const releaseRoot =
    `https://github.com/${repository}/releases/download/${tag}`;
  const plan: HomebrewBottleMirrorPlan = {
    schema: 1,
    kind: HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
    repository,
    collection_sha256: collection,
    tag,
    release_root: releaseRoot,
    manifest_asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    assets: [{ ...identity, url: `${releaseRoot}/${identity.asset}` }],
  };
  const planBytes = encodeHomebrewBottleMirrorPlan(plan);
  const planPath = join(root, HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET);
  const payloadPath = join(root, identity.asset);
  writeFileSync(planPath, planBytes);
  if (writePayload) writeFileSync(payloadPath, payloadBytes);
  return {
    plan,
    planBytes,
    planPath,
    payloadPath,
    pendingTree: {
      kind: "kandelo-deferred-tree-v2",
      content: {
        decoder: "homebrew-bottle-tar-gzip-v1",
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        sha256: identity.sha256,
        bytes: identity.bytes,
        expandedBytes: 1,
        sourceEntryCount: 1,
        transports: [`${releaseRoot}/${identity.asset}`],
      },
      url: `${releaseRoot}/${identity.asset}`,
      mountPrefix: "/home/linuxbrew/.linuxbrew",
      materialized: false,
      entries: [],
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
