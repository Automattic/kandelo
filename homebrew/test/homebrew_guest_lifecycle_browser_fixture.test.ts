import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
  type HomebrewBottleMirrorPlan,
} from "../../host/src/homebrew-vfs-composer";
import { homebrewRuntimeLayerPayloadAsset } from
  "../../host/src/homebrew-runtime-layer-limits";
import {
  loadHomebrewGuestLifecycleBrowserFixture,
  projectHomebrewGuestLifecycleBrowserFixture,
} from "./homebrew_guest_lifecycle_browser_fixture";

test("requires an explicit live-network opt-in before accepting URLs", () => {
  const fixture = createFixture();
  assert.throws(
    () =>
      projectHomebrewGuestLifecycleBrowserFixture({
        ...fixture.value,
        allowLiveNetwork: false,
      }),
    /explicit live-network opt-in/,
  );
});

test("requires exact closed mirror inputs and forbids them in public mode", () => {
  const fixture = createFixture();
  const { payloads: _payloads, ...planOnly } = fixture.value.bottleMirror;
  assert.throws(
    () =>
      projectHomebrewGuestLifecycleBrowserFixture({
        ...fixture.value,
        bottleMirror: planOnly,
      }),
    /closed browser lifecycle transport requires exact bottle payloads/,
  );
  assert.throws(
    () =>
      projectHomebrewGuestLifecycleBrowserFixture({
        ...fixture.value,
        transportMode: "public",
      }),
    /public transport forbids local payload bytes/,
  );
  assert.doesNotThrow(() =>
    projectHomebrewGuestLifecycleBrowserFixture({
      ...fixture.value,
      transportMode: "public",
      bottleMirror: planOnly,
    })
  );
});

test("loads every exact fixture byte and binds payloads to the mirror plan", async () => {
  const fixture = createFixture();
  const loaded = await loadHomebrewGuestLifecycleBrowserFixture(
    fixture.value,
    {
      sourceUrl: (url) => url,
      fetchImpl: createFixtureFetch(fixture.bytesByUrl),
    },
  );

  assert.deepEqual(loaded.imageBytes, fixture.imageBytes);
  assert.deepEqual(loaded.bootstrapSpecBytes, fixture.specBytes);
  assert.deepEqual(loaded.bootstrapArchiveBytes, fixture.archiveBytes);
  assert.deepEqual(loaded.bootstrapEnvironmentBytes, fixture.environmentBytes);
  assert.deepEqual(loaded.bottleMirrorPlanBytes, fixture.planBytes);
  assert.deepEqual(loaded.closedBottleAssets, [{
    url: fixture.plan.assets[0]!.url,
    sha256: fixture.plan.assets[0]!.sha256,
    size: fixture.payloadBytes.byteLength,
    bytes: fixture.payloadBytes,
  }]);
});

test("rejects changed bytes and fixture identities that differ from the plan", async () => {
  const fixture = createFixture();
  const changedBytesByUrl = new Map(fixture.bytesByUrl);
  changedBytesByUrl.set(
    fixture.value.bootstrap.archive.url,
    new Uint8Array([99]),
  );
  await assert.rejects(
    () =>
      loadHomebrewGuestLifecycleBrowserFixture(fixture.value, {
        sourceUrl: (url) => url,
        fetchImpl: createFixtureFetch(changedBytesByUrl),
      }),
    /bootstrap archive.*changed SHA-256/,
  );

  const changedPayloadFixture = {
    ...fixture.value,
    bottleMirror: {
      ...fixture.value.bottleMirror,
      payloads: fixture.value.bottleMirror.payloads.map((payload, index) =>
        index === 0 ? { ...payload, sha256: "0".repeat(64) } : payload
      ),
    },
  };
  await assert.rejects(
    () =>
      loadHomebrewGuestLifecycleBrowserFixture(changedPayloadFixture, {
        sourceUrl: (url) => url,
        fetchImpl: createFixtureFetch(fixture.bytesByUrl),
      }),
    /payload fixture differs from mirror asset/,
  );

  const inconsistentPlanBytes = encodeHomebrewBottleMirrorPlan({
    ...fixture.plan,
    collection_sha256: "0".repeat(64),
  });
  const inconsistentPlanFixture = {
    ...fixture.value,
    bottleMirror: {
      ...fixture.value.bottleMirror,
      plan: exact(
        fixture.value.bottleMirror.plan.url,
        inconsistentPlanBytes,
      ),
    },
  };
  const inconsistentBytesByUrl = new Map(fixture.bytesByUrl);
  inconsistentBytesByUrl.set(
    fixture.value.bottleMirror.plan.url,
    inconsistentPlanBytes,
  );
  await assert.rejects(
    () =>
      loadHomebrewGuestLifecycleBrowserFixture(inconsistentPlanFixture, {
        sourceUrl: (url) => url,
        fetchImpl: createFixtureFetch(inconsistentBytesByUrl),
      }),
    /inconsistent derived identity/,
  );
});

function createFixture() {
  const imageBytes = new Uint8Array([1, 2]);
  const specBytes = new Uint8Array([3]);
  const archiveBytes = new Uint8Array([4]);
  const environmentBytes = new Uint8Array([5]);
  const payloadBytes = new Uint8Array([6, 7, 8]);
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
    assets: [{
      ...identity,
      url: `${releaseRoot}/${identity.asset}`,
    }],
  };
  const planBytes = encodeHomebrewBottleMirrorPlan(plan);
  const urls = {
    image: "https://example.test/main-shell.vfs.zst",
    spec: "https://example.test/main-shell-brew-package-tree.json",
    archive: "https://example.test/homebrew-bootstrap.zip",
    environment: "https://example.test/homebrew-brew.env",
    plan: `${releaseRoot}/${HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET}`,
  };
  const value = {
    schema: 1,
    allowLiveNetwork: true,
    transportMode: "closed",
    image: exact(urls.image, imageBytes),
    bootstrap: {
      spec: exact(urls.spec, specBytes),
      archive: exact(urls.archive, archiveBytes),
      environment: exact(urls.environment, environmentBytes),
    },
    bottleMirror: {
      plan: exact(urls.plan, planBytes),
      payloads: [{
        asset: identity.asset,
        ...exact(plan.assets[0]!.url, payloadBytes),
      }],
    },
    revisions: {
      coreRevision: "1".repeat(40),
      canaryRevision: "2".repeat(40),
    },
    timeoutMs: 900_000,
  } as const;
  const bytesByUrl = new Map<string, Uint8Array>([
    [urls.image, imageBytes],
    [urls.spec, specBytes],
    [urls.archive, archiveBytes],
    [urls.environment, environmentBytes],
    [urls.plan, planBytes],
    [plan.assets[0]!.url, payloadBytes],
  ]);
  return {
    value,
    bytesByUrl,
    imageBytes,
    specBytes,
    archiveBytes,
    environmentBytes,
    payloadBytes,
    plan,
    planBytes,
  };
}

function createFixtureFetch(bytesByUrl: ReadonlyMap<string, Uint8Array>) {
  return async (input: string | URL): Promise<Response> => {
    const url = String(input);
    const bytes = bytesByUrl.get(url);
    if (bytes === undefined) return new Response(null, { status: 404 });
    const owned = bytes.slice();
    return new Response(owned.buffer, {
      status: 200,
      headers: { "content-length": String(owned.byteLength) },
    });
  };
}

function exact(url: string, bytes: Uint8Array) {
  return {
    url,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
