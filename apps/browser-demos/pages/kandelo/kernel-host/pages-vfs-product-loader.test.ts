import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createPagesVfsProductLoaderForBase,
  type PagesVfsProductEntry,
} from "./pages-vfs-product-loader.ts";

const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function response(body: Uint8Array, contentLength = body.byteLength): Response {
  return new Response(body.slice().buffer, {
    headers: { "content-length": String(contentLength) },
    status: 200,
  });
}

function groupFixture(base: string, directory = "vfs-groups/release-1") {
  const image = encoder.encode("group-owned image\n");
  const manifestPath = `${base}${directory}/manifest.json`;
  const manifest = encoder.encode(
    JSON.stringify({
      assets: [],
      kind: "kandelo-vfs-asset-group",
      policy: "source-only-v1",
      products: [
        {
          eager_groups: [],
          id: "browser-node",
          image: {
            bytes: image.byteLength,
            path: "images/node.vfs.zst",
            sha256: sha256(image),
          },
          lazy_groups: [],
        },
      ],
      schema: 1,
    }),
  );
  const entry: PagesVfsProductEntry = {
    asset_group: {
      bytes: manifest.byteLength,
      path: manifestPath,
      sha256: sha256(manifest),
    },
    bytes: image.byteLength,
    id: "browser-node",
    load: "lazy",
    path: `${base}products/browser-node/sha256-${sha256(image)}/browser-node-42.vfs.zst`,
    sha256: sha256(image),
  };
  const imageUrl = `https://kandelo.invalid${base}${directory}/images/node.vfs.zst`;
  return { entry, image, imageUrl, manifest, manifestPath };
}

test("activates a product from its authenticated group manifest", async () => {
  const fixture = groupFixture("/a/");
  const calls: string[] = [];
  const loader = createPagesVfsProductLoaderForBase(
    [fixture.entry],
    async (url) => {
      calls.push(url);
      if (url === fixture.manifestPath) return response(fixture.manifest);
      if (url === fixture.imageUrl) return response(fixture.image);
      throw new Error(`unexpected URL ${url}`);
    },
    "/a/",
  );

  const activation = await loader.activate("browser-node");

  assert.deepEqual(calls, [fixture.manifestPath, fixture.imageUrl]);
  assert.equal(activation.id, "browser-node");
  assert.equal(activation.imageUrl, fixture.imageUrl);
  assert.deepEqual(new Uint8Array(activation.imageBytes), fixture.image);
  assert.deepEqual(activation.lazyAssets, {
    deploymentBase: "/a/",
    directoryUrl: "https://kandelo.invalid/a/vfs-groups/release-1/",
    manifestUrl: "https://kandelo.invalid/a/vfs-groups/release-1/manifest.json",
  });
});

test("legacy map-only products fetch their canonical authenticated image", async () => {
  const fixture = groupFixture("/a/");
  const { asset_group: _assetGroup, ...legacyEntry } = fixture.entry;
  const calls: string[] = [];
  const loader = createPagesVfsProductLoaderForBase(
    [legacyEntry as PagesVfsProductEntry],
    async (url) => {
      calls.push(url);
      if (url === fixture.entry.path) return response(fixture.image);
      throw new Error(`unexpected URL ${url}`);
    },
    "/a/",
  );

  const activation = await loader.activate("browser-node");

  assert.deepEqual(calls, [fixture.entry.path]);
  assert.equal(activation.imageUrl, `https://kandelo.invalid${fixture.entry.path}`);
  assert.deepEqual(new Uint8Array(activation.imageBytes), fixture.image);
  assert.equal(activation.lazyAssets, undefined);
});

test("rejects mixed grouped and legacy product authority", () => {
  const grouped = groupFixture("/a/").entry;
  const { asset_group: _assetGroup, ...legacy } = {
    ...groupFixture("/a/").entry,
    id: "browser-shell",
    path: `/a/products/browser-shell/sha256-${grouped.sha256}/browser-shell-42.vfs.zst`,
  };

  assert.throws(
    () =>
      createPagesVfsProductLoaderForBase(
        [grouped, legacy as PagesVfsProductEntry],
        async () => {
          throw new Error("mixed authority must fail before fetch");
        },
        "/a/",
      ),
    /all declare one asset group or all omit it/i,
  );
});

test("returns an immutable copy of activated lazy asset authority", async () => {
  const fixture = groupFixture("/a/");
  const loader = createPagesVfsProductLoaderForBase(
    [fixture.entry],
    async (url) => {
      if (url === fixture.manifestPath) return response(fixture.manifest);
      if (url === fixture.imageUrl) return response(fixture.image);
      throw new Error(`unexpected URL ${url}`);
    },
    "/a/",
  );

  const activation = await loader.activate("browser-node");

  assert.equal(Object.isFrozen(activation.lazyAssets), true);
  assert.throws(() => {
    activation.lazyAssets.directoryUrl = "https://kandelo.invalid/a/forged/";
  }, /read only|Cannot assign/i);
  assert.equal(
    activation.lazyAssets.directoryUrl,
    "https://kandelo.invalid/a/vfs-groups/release-1/",
  );
});

test("coalesces concurrent group activation and retains the settled manifest", async () => {
  const fixture = groupFixture("/a/");
  let manifestFetches = 0;
  let imageFetches = 0;
  const loader = createPagesVfsProductLoaderForBase(
    [fixture.entry],
    async (url) => {
      if (url === fixture.manifestPath) {
        manifestFetches += 1;
        return response(fixture.manifest);
      }
      if (url === fixture.imageUrl) {
        imageFetches += 1;
        return response(fixture.image);
      }
      throw new Error(`unexpected URL ${url}`);
    },
    "/a/",
  );

  const first = loader.activate("browser-node");
  assert.equal(first, loader.activate("browser-node"));
  await first;
  await loader.bytes("browser-node");

  assert.equal(manifestFetches, 1);
  assert.equal(imageFetches, 1);
});

test("retries transient group and image failures without replacing settled activations", async () => {
  const groupFailure = groupFixture("/a/");
  let groupFetches = 0;
  const groupLoader = createPagesVfsProductLoaderForBase(
    [groupFailure.entry],
    async (url) => {
      if (url === groupFailure.manifestPath) {
        groupFetches += 1;
        if (groupFetches === 1) return new Response(null, { status: 503 });
        return response(groupFailure.manifest);
      }
      if (url === groupFailure.imageUrl) return response(groupFailure.image);
      throw new Error(`unexpected URL ${url}`);
    },
    "/a/",
  );
  await assert.rejects(groupLoader.activate("browser-node"), /503/);
  await groupLoader.activate("browser-node");
  assert.equal(groupFetches, 2);

  const imageFailure = groupFixture("/a/");
  let imageFetches = 0;
  const imageLoader = createPagesVfsProductLoaderForBase(
    [imageFailure.entry],
    async (url) => {
      if (url === imageFailure.manifestPath) return response(imageFailure.manifest);
      if (url === imageFailure.imageUrl) {
        imageFetches += 1;
        if (imageFetches === 1) throw new Error("temporary image failure");
        return response(imageFailure.image);
      }
      throw new Error(`unexpected URL ${url}`);
    },
    "/a/",
  );
  await assert.rejects(imageLoader.activate("browser-node"), /temporary image/);
  await imageLoader.activate("browser-node");
  assert.equal(imageFetches, 2);
});

test("rejects short, oversized, malformed, and mismatched group bodies", async (t) => {
  const fixture = groupFixture("/a/");
  const cases: Array<[string, () => Response, RegExp]> = [
    [
      "short",
      () =>
        response(fixture.manifest.subarray(0, -1), fixture.manifest.byteLength),
      /received length/i,
    ],
    [
      "oversized",
      () =>
        response(
          new Uint8Array([...fixture.manifest, 0]),
          fixture.manifest.byteLength,
        ),
      /exceeds/i,
    ],
    [
      "digest",
      () => response(fixture.manifest, fixture.manifest.byteLength + 1),
      /content-length/i,
    ],
  ];
  for (const [name, groupResponse, message] of cases) {
    await t.test(name, async () => {
      const loader = createPagesVfsProductLoaderForBase(
        [fixture.entry],
        async (url) => {
          if (url === fixture.manifestPath) return groupResponse();
          throw new Error(`image must not fetch after ${name} group failure`);
        },
        "/a/",
      );
      await assert.rejects(loader.activate("browser-node"), message);
    });
  }
});

test("rejects malformed image response bodies after authenticating the group", async (t) => {
  const fixture = groupFixture("/a/");
  const tampered = fixture.image.slice();
  tampered[0] ^= 0x01;
  const cases: Array<[string, () => Response, RegExp]> = [
    [
      "short body",
      () => response(fixture.image.subarray(0, -1), fixture.image.byteLength),
      /received length/i,
    ],
    [
      "oversized body",
      () => response(new Uint8Array([...fixture.image, 0]), fixture.image.byteLength),
      /exceeds/i,
    ],
    [
      "wrong content length",
      () => response(fixture.image, fixture.image.byteLength + 1),
      /content-length/i,
    ],
    ["digest mismatch", () => response(tampered), /SHA-256/i],
  ];
  for (const [name, imageResponse, message] of cases) {
    await t.test(name, async () => {
      const loader = createPagesVfsProductLoaderForBase(
        [fixture.entry],
        async (url) => {
          if (url === fixture.manifestPath) return response(fixture.manifest);
          if (url === fixture.imageUrl) return imageResponse();
          throw new Error(`unexpected URL ${url}`);
        },
        "/a/",
      );
      await assert.rejects(loader.activate("browser-node"), message);
    });
  }
});

test("rejects a size- and digest-authenticated malformed group manifest", async () => {
  const fixture = groupFixture("/a/");
  const malformed = new Uint8Array(fixture.manifest.byteLength);
  malformed.fill(0x20);
  malformed[0] = 0x5b;
  const entry: PagesVfsProductEntry = {
    ...fixture.entry,
    asset_group: {
      bytes: malformed.byteLength,
      path: fixture.manifestPath,
      sha256: sha256(malformed),
    },
  };
  const loader = createPagesVfsProductLoaderForBase(
    [entry],
    async (url) => {
      if (url === fixture.manifestPath) return response(malformed);
      throw new Error("malformed group must not fetch an image");
    },
    "/a/",
  );
  await assert.rejects(loader.activate("browser-node"), /not JSON/i);
});

test("rejects an image identity that disagrees with the authenticated group", async () => {
  const fixture = groupFixture("/a/");
  const mismatched = { ...fixture.entry, bytes: fixture.entry.bytes + 1 };
  const loader = createPagesVfsProductLoaderForBase(
    [mismatched],
    async (url) => {
      if (url === fixture.manifestPath) return response(fixture.manifest);
      throw new Error("mismatched group image must not fetch");
    },
    "/a/",
  );
  await assert.rejects(loader.activate("browser-node"), /identity/i);
});

test("rejects missing, tampered, and unavailable group product data", async () => {
  const fixture = groupFixture("/a/");
  const missingProduct = encoder.encode(
    JSON.stringify({
      assets: [],
      kind: "kandelo-vfs-asset-group",
      policy: "source-only-v1",
      products: [],
      schema: 1,
    }),
  );
  const missingLoader = createPagesVfsProductLoaderForBase(
    [
      {
        ...fixture.entry,
        asset_group: {
          ...fixture.entry.asset_group,
          bytes: missingProduct.byteLength,
          sha256: sha256(missingProduct),
        },
      },
    ],
    async () => response(missingProduct),
    "/a/",
  );
  await assert.rejects(missingLoader.activate("browser-node"), /lacks product/i);

  const digestLoader = createPagesVfsProductLoaderForBase(
    [
      {
        ...fixture.entry,
        asset_group: {
          ...fixture.entry.asset_group,
          sha256: "0".repeat(64),
        },
      },
    ],
    async () => response(fixture.manifest),
    "/a/",
  );
  await assert.rejects(digestLoader.activate("browser-node"), /SHA-256/i);

  const rejectedImageLoader = createPagesVfsProductLoaderForBase(
    [fixture.entry],
    async (url) => {
      if (url === fixture.manifestPath) return response(fixture.manifest);
      if (url === fixture.imageUrl) throw new Error("image transport rejected");
      throw new Error(`unexpected URL ${url}`);
    },
    "/a/",
  );
  await assert.rejects(
    rejectedImageLoader.activate("browser-node"),
    /image transport rejected/,
  );
});

test("relocates an unchanged internal group layout with only its map identity", async () => {
  const first = groupFixture("/a/", "vfs-groups/release-1");
  const moved = groupFixture("/a/", "nested/release-2");
  for (const fixture of [first, moved]) {
    const loader = createPagesVfsProductLoaderForBase(
      [fixture.entry],
      async (url) => {
        if (url === fixture.manifestPath) return response(fixture.manifest);
        if (url === fixture.imageUrl) return response(fixture.image);
        throw new Error(`unexpected URL ${url}`);
      },
      "/a/",
    );
    assert.equal(
      (await loader.activate("browser-node")).imageUrl,
      fixture.imageUrl,
    );
  }
});

test("rejects a group manifest outside the deployment base before fetch", () => {
  const fixture = groupFixture("/a/");
  assert.throws(
    () =>
      createPagesVfsProductLoaderForBase(
        [
          {
            ...fixture.entry,
            asset_group: {
              ...fixture.entry.asset_group,
              path: "/outside/manifest.json",
            },
          },
        ],
        async () => response(fixture.manifest),
        "/a/",
      ),
    /group path/i,
  );
});
