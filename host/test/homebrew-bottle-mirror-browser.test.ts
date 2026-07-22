import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  loadHomebrewBottleMirrorClosedAssets,
  parseHomebrewBottleMirrorPlan,
} from "../src/homebrew-bottle-mirror-browser";
import { assertHomebrewBottleMirrorPlan } from "../src/homebrew-vfs-composer";
import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
  type HomebrewBottleMirrorPlan,
} from "../src/homebrew-bottle-mirror-plan";
import { homebrewRuntimeLayerPayloadAsset } from "../src/homebrew-runtime-layer-limits";

const bytes = new Uint8Array([1, 2, 3, 4]);

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeRaw(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function plan(): HomebrewBottleMirrorPlan {
  const repository = "example/project";
  const identity = {
    id: "bottle-test",
    package: "example/tap/test",
    asset: homebrewRuntimeLayerPayloadAsset("bottle-test"),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  };
  const collection = sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(repository, [identity]),
  );
  const tag = `homebrew-shell-bottles-sha256-${collection}`;
  const releaseRoot = `https://github.com/${repository}/releases/download/${tag}`;
  return {
    schema: 1,
    kind: HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
    repository,
    collection_sha256: collection,
    tag,
    release_root: releaseRoot,
    manifest_asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    assets: [{ ...identity, url: `${releaseRoot}/${identity.asset}` }],
  };
}

describe("browser Homebrew bottle mirror bindings", () => {
  it("loads local exact bytes while retaining final immutable URL keys", async () => {
    const mirrorPlan = plan();
    const fetchImpl = vi.fn(async () => new Response(bytes));
    const result = await loadHomebrewBottleMirrorClosedAssets({
      embeddedPlanBytes: encodeHomebrewBottleMirrorPlan(mirrorPlan),
      bundleRoot: "/homebrew-bottles",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/homebrew-bottles/kandelo-homebrew-bottle-test-layer.bin",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    expect(result.plan).toEqual(mirrorPlan);
    expect(result.assets).toEqual([{
      url: mirrorPlan.assets[0]!.url,
      sha256: sha256(bytes),
      size: bytes.byteLength,
      bytes,
    }]);
  });

  it("rejects noncanonical or inconsistent embedded plans", async () => {
    const mirrorPlan = plan();
    await expect(parseHomebrewBottleMirrorPlan(
      new TextEncoder().encode(JSON.stringify(mirrorPlan)),
    )).rejects.toThrow("bytes are not canonical");
    await expect(parseHomebrewBottleMirrorPlan(encodeHomebrewBottleMirrorPlan({
      ...mirrorPlan,
      collection_sha256: "0".repeat(64),
    }))).rejects.toThrow("inconsistent derived identity");
  });

  it.each([
    ["top-level", (base: HomebrewBottleMirrorPlan) => ({
      ...base,
      unexpected: true,
    }), "plan has unknown or missing fields"],
    ["per-asset", (base: HomebrewBottleMirrorPlan) => ({
      ...base,
      assets: [{ ...base.assets[0]!, unexpected: true }],
    }), "asset 0 has unknown or missing fields"],
  ])("rejects an extra %s field identically on Node and browser", async (
    _label,
    mutate,
    message,
  ) => {
    const value = mutate(plan());
    expect(() => assertHomebrewBottleMirrorPlan(
      value as unknown as HomebrewBottleMirrorPlan,
    )).toThrow(message);
    await expect(parseHomebrewBottleMirrorPlan(encodeRaw(value))).rejects.toThrow(
      message,
    );
  });

  it("rejects canonical-looking JSON whose plan or asset keys are reordered", async () => {
    const base = plan();
    const reorderedPlan = {
      assets: base.assets,
      manifest_asset: base.manifest_asset,
      release_root: base.release_root,
      tag: base.tag,
      collection_sha256: base.collection_sha256,
      repository: base.repository,
      kind: base.kind,
      schema: base.schema,
    };
    await expect(parseHomebrewBottleMirrorPlan(
      encodeRaw(reorderedPlan),
    )).rejects.toThrow("bytes are not canonical");

    const asset = base.assets[0]!;
    const reorderedAsset = {
      url: asset.url,
      bytes: asset.bytes,
      sha256: asset.sha256,
      asset: asset.asset,
      package: asset.package,
      id: asset.id,
    };
    await expect(parseHomebrewBottleMirrorPlan(encodeRaw({
      ...base,
      assets: [reorderedAsset],
    }))).rejects.toThrow("bytes are not canonical");
  });

  it("rejects a locally served payload with different bytes", async () => {
    await expect(loadHomebrewBottleMirrorClosedAssets({
      embeddedPlanBytes: encodeHomebrewBottleMirrorPlan(plan()),
      bundleRoot: "/homebrew-bottles",
      fetchImpl: async () => new Response(new Uint8Array([9, 9, 9, 9])),
    })).rejects.toThrow("changed SHA-256");
  });

  it("rejects a non-success local response", async () => {
    await expect(loadHomebrewBottleMirrorClosedAssets({
      embeddedPlanBytes: encodeHomebrewBottleMirrorPlan(plan()),
      bundleRoot: "/homebrew-bottles",
      fetchImpl: async () => new Response(null, { status: 404 }),
    })).rejects.toThrow("HTTP 404");
  });

  it("rejects a locally served payload with the wrong byte count", async () => {
    await expect(loadHomebrewBottleMirrorClosedAssets({
      embeddedPlanBytes: encodeHomebrewBottleMirrorPlan(plan()),
      bundleRoot: "/homebrew-bottles",
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])),
    })).rejects.toThrow("has 3 bytes, expected 4");
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    const getReader = vi.fn();
    const response = {
      ok: true,
      headers: new Headers({ "content-length": "5" }),
      body: { getReader },
    } as unknown as Response;
    await expect(loadHomebrewBottleMirrorClosedAssets({
      embeddedPlanBytes: encodeHomebrewBottleMirrorPlan(plan()),
      bundleRoot: "/homebrew-bottles",
      fetchImpl: async () => response,
    })).rejects.toThrow("declares 5 bytes, expected 4");
    expect(getReader).not.toHaveBeenCalled();
  });

  it("stops a chunked body as soon as it exceeds the planned byte count", async () => {
    let chunk = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunk === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
        else controller.enqueue(new Uint8Array([4, 5]));
        chunk += 1;
      },
      cancel,
    }, { highWaterMark: 0 });
    await expect(loadHomebrewBottleMirrorClosedAssets({
      embeddedPlanBytes: encodeHomebrewBottleMirrorPlan(plan()),
      bundleRoot: "/homebrew-bottles",
      fetchImpl: async () => new Response(body),
    })).rejects.toThrow("exceeds 4 bytes");
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunk).toBe(2);
  });

  it("rejects duplicate and nonsorted ownership identities", async () => {
    const base = plan();
    await expect(parseHomebrewBottleMirrorPlan(encodeHomebrewBottleMirrorPlan({
      ...base,
      assets: [base.assets[0]!, base.assets[0]!],
    }))).rejects.toThrow("ownership is not canonical");

    const second = {
      ...base.assets[0]!,
      id: "bottle-alpha",
      package: "example/tap/alpha",
      asset: homebrewRuntimeLayerPayloadAsset("bottle-alpha"),
      url: `${base.release_root}/${homebrewRuntimeLayerPayloadAsset("bottle-alpha")}`,
    };
    await expect(parseHomebrewBottleMirrorPlan(encodeHomebrewBottleMirrorPlan({
      ...base,
      assets: [base.assets[0]!, second],
    }))).rejects.toThrow("ownership is not canonical");
  });

  it.each([
    ["malformed package", { package: "missing-components" }],
    ["malformed asset", { asset: "../escape.bin" }],
    ["malformed sha", { sha256: "not-a-sha" }],
    ["malformed size", { bytes: 0 }],
    ["malformed URL", { url: "not-an-immutable-url" }],
    ["manifest filename collision", { asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET }],
  ])("rejects %s", async (_label, override) => {
    const base = plan();
    await expect(parseHomebrewBottleMirrorPlan(encodeHomebrewBottleMirrorPlan({
      ...base,
      assets: [{ ...base.assets[0]!, ...override }],
    }))).rejects.toThrow(/invalid fields|inconsistent derived identity/);
  });

  it("rejects empty and over-cap plans", async () => {
    const base = plan();
    await expect(parseHomebrewBottleMirrorPlan(encodeHomebrewBottleMirrorPlan({
      ...base,
      assets: [],
    }))).rejects.toThrow("invalid top-level fields");
    await expect(parseHomebrewBottleMirrorPlan(encodeHomebrewBottleMirrorPlan({
      ...base,
      assets: Array.from({ length: 129 }, (_, index) => ({
        ...base.assets[0]!,
        id: `bottle-${String(index).padStart(3, "0")}`,
        package: `example/tap/pkg${index}`,
        asset: homebrewRuntimeLayerPayloadAsset(
          `bottle-${String(index).padStart(3, "0")}`,
        ),
        url: `${base.release_root}/${homebrewRuntimeLayerPayloadAsset(
          `bottle-${String(index).padStart(3, "0")}`,
        )}`,
      })),
    }))).rejects.toThrow("invalid top-level fields");
    await expect(parseHomebrewBottleMirrorPlan(encodeHomebrewBottleMirrorPlan({
      ...base,
      assets: [{
        ...base.assets[0]!,
        bytes: 512 * 1024 * 1024 + 1,
      }],
    }))).rejects.toThrow("ownership is not canonical");
  });

  it.each(["relative", "/", "/path/../escape", "/path?query=1"])(
    "rejects noncanonical bundle root %s",
    async (bundleRoot) => {
      await expect(loadHomebrewBottleMirrorClosedAssets({
        embeddedPlanBytes: encodeHomebrewBottleMirrorPlan(plan()),
        bundleRoot,
        fetchImpl: async () => new Response(bytes),
      })).rejects.toThrow(/bundle root/);
    },
  );
});
