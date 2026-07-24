import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MAX_CLOSED_LAZY_ASSET_BYTES,
  MAX_CLOSED_LAZY_ASSETS,
} from "../../host/src/vfs/closed-lazy-assets";
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
    /fixture assets.*changed SHA-256/,
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
  const changedPayloadRequests: string[] = [];
  await assert.rejects(
    () =>
      loadHomebrewGuestLifecycleBrowserFixture(changedPayloadFixture, {
        sourceUrl: (url) => url,
        fetchImpl: async (input) => {
          const url = String(input);
          changedPayloadRequests.push(url);
          return createFixtureFetch(fixture.bytesByUrl)(input);
        },
      }),
    /payload fixture differs from mirror asset/,
  );
  assert.equal(
    changedPayloadRequests.includes(fixture.plan.assets[0]!.url),
    false,
    "a payload whose exact identity is not authorized by the plan is not fetched",
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

test("loads the complete fixture under one aggregate transport budget and signal", async () => {
  const fixture = createFixture();
  const signals = new Set<AbortSignal>();
  let requests = 0;
  const loaded = await loadHomebrewGuestLifecycleBrowserFixture(
    fixture.value,
    {
      sourceUrl: (url) => url,
      fetchImpl: async (input, init) => {
        requests += 1;
        signals.add(init!.signal as AbortSignal);
        const bytes = fixture.bytesByUrl.get(String(input));
        assert.ok(bytes);
        return new Response(bytes.slice().buffer);
      },
    },
  );

  assert.equal(requests, fixture.bytesByUrl.size);
  assert.equal(signals.size, 1);
  assert.equal(loaded.closedBottleAssets?.length, 1);
});

test("rejects duplicate URLs and aggregate count or byte overflow before fetching", async () => {
  const fixture = createFixture();
  let requests = 0;
  const fetchImpl = async (): Promise<Response> => {
    requests += 1;
    return new Response(new Uint8Array([1]));
  };
  const duplicate = {
    ...fixture.value,
    bootstrap: {
      ...fixture.value.bootstrap,
      spec: fixture.value.image,
    },
  };
  await assert.rejects(
    () =>
      loadHomebrewGuestLifecycleBrowserFixture(duplicate, {
        sourceUrl: (url) => url,
        fetchImpl,
      }),
    /duplicate URL/,
  );

  const sparsePayloads = new Array(1);
  assert.throws(
    () =>
      projectHomebrewGuestLifecycleBrowserFixture({
        ...fixture.value,
        bottleMirror: {
          ...fixture.value.bottleMirror,
          payloads: sparsePayloads,
        },
      }),
    /bottle payload 0 is missing/,
  );

  assert.throws(
    () =>
      projectHomebrewGuestLifecycleBrowserFixture({
        ...fixture.value,
        bottleMirror: {
          ...fixture.value.bottleMirror,
          payloads: [
            fixture.value.bottleMirror.payloads[0],
            fixture.value.bottleMirror.payloads[0],
          ],
        },
      }),
    /duplicate asset/,
  );

  const tooManyPayloads = Array.from(
    { length: MAX_CLOSED_LAZY_ASSETS - 4 },
    (_unused, index) => ({
      asset: `payload-${index}.tar.gz`,
      url: `https://example.test/payload-${index}.tar.gz`,
      sha256: "0".repeat(64),
      bytes: 1,
    }),
  );
  assert.throws(
    () =>
      projectHomebrewGuestLifecycleBrowserFixture({
        ...fixture.value,
        bottleMirror: {
          ...fixture.value.bottleMirror,
          payloads: tooManyPayloads,
        },
      }),
    new RegExp(`exceeds ${MAX_CLOSED_LAZY_ASSETS} exact assets`),
  );

  const aggregateOverflow = {
    ...fixture.value,
    image: {
      ...fixture.value.image,
      bytes: Math.floor(MAX_CLOSED_LAZY_ASSET_BYTES * 0.6),
    },
    bootstrap: {
      ...fixture.value.bootstrap,
      spec: {
        ...fixture.value.bootstrap.spec,
        bytes: Math.floor(MAX_CLOSED_LAZY_ASSET_BYTES * 0.6),
      },
    },
  };
  await assert.rejects(
    () =>
      loadHomebrewGuestLifecycleBrowserFixture(aggregateOverflow, {
        sourceUrl: (url) => url,
        fetchImpl,
      }),
    new RegExp(`exceed ${MAX_CLOSED_LAZY_ASSET_BYTES} bytes`),
  );
  assert.equal(requests, 0);
});

test("propagates one caller cancellation without starting fixture I/O", async () => {
  const fixture = createFixture();
  const controller = new AbortController();
  const reason = new Error("fixture deadline elapsed");
  controller.abort(reason);
  let requests = 0;
  await assert.rejects(
    () =>
      loadHomebrewGuestLifecycleBrowserFixture(fixture.value, {
        sourceUrl: (url) => url,
        signal: controller.signal,
        fetchImpl: async () => {
          requests += 1;
          return new Response(new Uint8Array([1]));
        },
      }),
    (error) => error === reason,
  );
  assert.equal(requests, 0);
});

test("preserves caller cancellation during public plan identity validation", async () => {
  const fixture = createFixture();
  const { payloads: _payloads, ...planOnly } = fixture.value.bottleMirror;
  const publicFixture = {
    ...fixture.value,
    transportMode: "public",
    bottleMirror: planOnly,
  };
  const controller = new AbortController();
  const reason = new Error("fixture deadline elapsed during plan validation");
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  const ownDescriptor = Object.getOwnPropertyDescriptor(
    crypto.subtle,
    "digest",
  );
  let digestCalls = 0;
  let markIdentityStarted!: () => void;
  let releaseIdentity!: () => void;
  const identityStarted = new Promise<void>((resolve) => {
    markIdentityStarted = resolve;
  });
  const identityGate = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  Object.defineProperty(crypto.subtle, "digest", {
    configurable: true,
    value: async (
      algorithm: AlgorithmIdentifier,
      data: BufferSource,
    ): Promise<ArrayBuffer> => {
      digestCalls += 1;
      if (digestCalls === 6) {
        markIdentityStarted();
        await identityGate;
      }
      return originalDigest(algorithm, data);
    },
  });
  try {
    const loading = loadHomebrewGuestLifecycleBrowserFixture(publicFixture, {
      sourceUrl: (url) => url,
      signal: controller.signal,
      fetchImpl: createFixtureFetch(fixture.bytesByUrl),
    });
    await identityStarted;
    let observedReason: unknown;
    void loading.catch((error: unknown) => {
      observedReason = error;
    });
    controller.abort(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      observedReason,
      reason,
      "the caller deadline settles without waiting for Web Crypto",
    );
  } finally {
    releaseIdentity();
    if (ownDescriptor === undefined) {
      Reflect.deleteProperty(crypto.subtle, "digest");
    } else {
      Object.defineProperty(crypto.subtle, "digest", ownDescriptor);
    }
  }
});

test("settles caller cancellation when an injected fetch ignores its signal", async () => {
  const fixture = createFixture();
  const { payloads: _payloads, ...planOnly } = fixture.value.bottleMirror;
  const publicFixture = {
    ...fixture.value,
    transportMode: "public",
    bottleMirror: planOnly,
  };
  const controller = new AbortController();
  const reason = new Error("fixture deadline elapsed during transport");
  let markFetchStarted!: () => void;
  let releaseFetch!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const loading = loadHomebrewGuestLifecycleBrowserFixture(publicFixture, {
    sourceUrl: (url) => url,
    signal: controller.signal,
    fetchImpl: async (input) => {
      markFetchStarted();
      await fetchGate;
      const bytes = fixture.bytesByUrl.get(String(input));
      assert.ok(bytes);
      return new Response(bytes.slice().buffer);
    },
  });
  await fetchStarted;
  let observedReason: unknown;
  void loading.catch((error: unknown) => {
    observedReason = error;
  });
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    observedReason,
    reason,
    "the caller deadline settles without waiting for an uncooperative fetch",
  );
  releaseFetch();
  await new Promise<void>((resolve) => setImmediate(resolve));
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
