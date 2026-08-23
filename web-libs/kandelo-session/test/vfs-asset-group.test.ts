import { describe, expect, it } from "vitest";

import {
  resolveGroupedAssetUrl,
  validateVfsAssetGroupManifest,
} from "../src/vfs-asset-group";

const IMAGE_SHA256 = "1".repeat(64);
const ASSET_SHA256 = "2".repeat(64);

describe("validateVfsAssetGroupManifest", () => {
  it("accepts a complete source-only group manifest", () => {
    const manifest = validateVfsAssetGroupManifest({
      assets: [
        {
          bytes: 7,
          group: "runtime",
          path: "assets/runtime.wasm",
          sha256: ASSET_SHA256,
        },
      ],
      kind: "kandelo-vfs-asset-group",
      policy: "source-only-v1",
      products: [
        {
          eager_groups: ["runtime"],
          id: "browser-main-shell",
          image: {
            bytes: 11,
            path: "images/shell.vfs.zst",
            sha256: IMAGE_SHA256,
          },
          lazy_groups: [],
        },
      ],
      schema: 1,
    });

    expect(manifest.products[0]?.image.path).toBe("images/shell.vfs.zst");
    expect(manifest.assets[0]?.group).toBe("runtime");
  });

  it("rejects an encoded separator in an inventory path", () => {
    expect(() =>
      validateVfsAssetGroupManifest({
        assets: [
          {
            bytes: 7,
            group: "runtime",
            path: "assets%2fruntime.wasm",
            sha256: ASSET_SHA256,
          },
        ],
        kind: "kandelo-vfs-asset-group",
        policy: "source-only-v1",
        products: [
          {
            eager_groups: ["runtime"],
            id: "browser-main-shell",
            image: {
              bytes: 11,
              path: "images/shell.vfs.zst",
              sha256: IMAGE_SHA256,
            },
            lazy_groups: [],
          },
        ],
        schema: 1,
      }),
    ).toThrow(/invalid/i);
  });

  it("rejects duplicate product IDs", () => {
    expect(() =>
      validateVfsAssetGroupManifest({
        assets: [],
        kind: "kandelo-vfs-asset-group",
        policy: "source-only-v1",
        products: [
          {
            eager_groups: [],
            id: "browser-main-shell",
            image: {
              bytes: 11,
              path: "images/shell.vfs.zst",
              sha256: IMAGE_SHA256,
            },
            lazy_groups: [],
          },
          {
            eager_groups: [],
            id: "browser-main-shell",
            image: {
              bytes: 12,
              path: "images/other.vfs.zst",
              sha256: ASSET_SHA256,
            },
            lazy_groups: [],
          },
        ],
        schema: 1,
      }),
    ).toThrow(/unique/i);
  });
});

describe("resolveGroupedAssetUrl", () => {
  it("resolves a relative asset from the authenticated manifest directory", () => {
    expect(
      resolveGroupedAssetUrl(
        "https://demo.test/a/vfs-groups/release-1/manifest.json",
        "assets/runtime.wasm",
        "/a/",
      ),
    ).toBe("https://demo.test/a/vfs-groups/release-1/assets/runtime.wasm");
  });

  it("rejects an encoded separator before URL resolution", () => {
    expect(() =>
      resolveGroupedAssetUrl(
        "https://demo.test/a/vfs-groups/release-1/manifest.json",
        "assets%2fruntime.wasm",
        "/a/",
      ),
    ).toThrow(/path/i);
  });
});
