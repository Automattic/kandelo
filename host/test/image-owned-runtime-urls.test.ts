import { describe, expect, it, vi } from "vitest";
import {
  imageOwnedLazyAssetDirectory,
  normalizeImageOwnedLazyReference,
} from "../../apps/browser-demos/lib/init/image-owned-runtime-urls";
import { resolveImageOwnedLazyAsset } from "../src/vfs/vfs-asset-group-reference";
import { createPagesVfsProductLoaderForBase } from "../../apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-loader";

/**
 * Nothing rewrites the image: it keeps the canonical address, and the kernel
 * worker resolves that address to its package member under the deployment's
 * lazy-asset directory when it fetches. So the subjects are pure functions,
 * and the tests need no image at all — "where would this URL end up" never
 * depends on the image.
 */
describe("image-owned grouped runtime URLs", () => {
  const AUTHORITY = {
    deploymentBase: "/a/",
    directoryUrl: "https://demo.invalid/a/assets-group/",
    manifestUrl: "https://demo.invalid/a/assets-group/manifest.json",
  };

  it("resolves legacy references into the group manifest directory", () => {
    const directory = imageOwnedLazyAssetDirectory(AUTHORITY);
    expect(directory).toBe("https://demo.invalid/a/assets-group/");
    expect(resolveImageOwnedLazyAsset(directory, "binaries/programs/wasm32/program.wasm")).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
    );
    expect(resolveImageOwnedLazyAsset(directory, "kandelo-lazy:programs/lazy-program.wasm")).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/lazy-program.wasm",
    );
    expect(resolveImageOwnedLazyAsset(directory, "kandelo-lazy:programs/wasm32/vim.zip")).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/vim.zip",
    );
    expect(
      resolveImageOwnedLazyAsset(directory, "kandelo-lazy:programs/love/share/love-examples.zip"),
    ).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/love/share/love-examples.zip",
    );
    expect(
      resolveImageOwnedLazyAsset(
        directory,
        "kandelo-lazy:programs/wasm32/freeciv-browser-bundle/freeciv.zip",
      ),
    ).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/freeciv-browser-bundle/freeciv.zip",
    );
    // An archive's bare name is not an address: nothing maps names to packages.
    expect(resolveImageOwnedLazyAsset(directory, "vim.zip")).toBeNull();
  });

  it("gives /a/ and /candidate-b/ their own exact manifest directories", () => {
    const reference = "binaries/programs/wasm32/program.wasm";
    const primary = imageOwnedLazyAssetDirectory(AUTHORITY);
    const candidate = imageOwnedLazyAssetDirectory({
      deploymentBase: "/candidate-b/",
      directoryUrl: "https://demo.invalid/candidate-b/assets-group/",
      manifestUrl: "https://demo.invalid/candidate-b/assets-group/manifest.json",
    });
    expect(resolveImageOwnedLazyAsset(primary, reference)).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
    );
    expect(resolveImageOwnedLazyAsset(candidate, reference)).toBe(
      "https://demo.invalid/candidate-b/assets-group/assets/programs/wasm32/program.wasm",
    );
  });

  // The old file asserted that a malformed transport did not mutate a PRECEDING
  // valid one, because binding walked the image and wrote as it went, so a
  // failure halfway could leave the image partly bound. A resolver has no
  // partial state to leave: one reference failing is one call returning null.
  it("leaves a reference outside the grammar unresolved, per call", () => {
    const directory = imageOwnedLazyAssetDirectory(AUTHORITY);
    expect(resolveImageOwnedLazyAsset(directory, "https://demo.invalid/a/forged.wasm")).toBeNull();
    expect(resolveImageOwnedLazyAsset(directory, "binaries/programs/wasm32/program.wasm")).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
    );
  });

  it("does not retain caller-mutable authority", () => {
    const mutable = { ...AUTHORITY };
    const directory = imageOwnedLazyAssetDirectory(mutable);
    mutable.manifestUrl = "https://evil.invalid/a/assets-group/manifest.json";
    mutable.directoryUrl = "https://evil.invalid/a/assets-group/";
    expect(directory).toBe("https://demo.invalid/a/assets-group/");
  });

  it("gives a non-product image the deployment's own asset group", () => {
    const sha = "a".repeat(64);
    const entry = {
      id: "browser-main-shell",
      load: "lazy" as const,
      path: `/a/products/browser-main-shell/sha256-${sha}/browser-main-shell-1.vfs.zst`,
      bytes: 1,
      sha256: sha,
    };
    const fetcher = () => Promise.reject(new Error("no fetch expected"));
    const grouped = createPagesVfsProductLoaderForBase(
      [{ ...entry, asset_group: { path: "/a/vfs-groups/release-1/manifest.json", bytes: 1, sha256: sha } }],
      fetcher,
      "/a/",
    );
    const directory = imageOwnedLazyAssetDirectory(grouped.deploymentLazyAssets())!;
    expect(resolveImageOwnedLazyAsset(directory, "kandelo-lazy:programs/wasm32/vim.zip")).toBe(
      new URL("/a/vfs-groups/release-1/assets/programs/wasm32/vim.zip", directory).href,
    );
    // Without a group there is no deployment authority to fall back to.
    expect(createPagesVfsProductLoaderForBase([entry], fetcher, "/a/").deploymentLazyAssets())
      .toBeUndefined();
  });

  it("points the dev server's kernel at its lazy-asset route without an asset group", () => {
    // Vitest serves modules like the Vite dev server: import.meta.env.DEV.
    vi.stubGlobal("location", new URL("http://127.0.0.1:5401/pages/kandelo/"));
    let directory: string;
    try {
      directory = imageOwnedLazyAssetDirectory(undefined);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(directory).toBe("http://127.0.0.1:5401/@kandelo-lazy/");
    expect(resolveImageOwnedLazyAsset(directory, "kandelo-lazy:programs/tmux.wasm")).toBe(
      new URL("/@kandelo-lazy/assets/programs/wasm32/tmux.wasm", directory).href,
    );
  });

  // Authority validation, kept because it is the security half of this module
  // and unchanged by the move: an authority is still snapshotted and refused up
  // front. What is gone from the NAME is "before any transport mutation" —
  // there are no transport mutations now, so the refusal is simply at
  // construction, which is earlier and unconditional rather than merely first.
  it.each([
    ["mismatched directory", { directoryUrl: "https://demo.invalid/a/other/" }],
    ["cross-origin directory", { directoryUrl: "https://other.invalid/a/assets-group/" }],
    ["outside deployment base", {
      directoryUrl: "https://demo.invalid/other/assets-group/",
      manifestUrl: "https://demo.invalid/other/assets-group/manifest.json",
    }],
    ["manifest query", {
      manifestUrl: "https://demo.invalid/a/assets-group/manifest.json?x=1",
    }],
    ["manifest fragment", {
      manifestUrl: "https://demo.invalid/a/assets-group/manifest.json#part",
    }],
  ])("refuses %s authority at construction", (_label, patch) => {
    expect(() => imageOwnedLazyAssetDirectory({ ...AUTHORITY, ...patch }))
      .toThrow(/authority is invalid/);
  });

  it.each([
    "/a/assets/programs/wasm32/program.wasm",
    "//demo.invalid/a/assets/programs/wasm32/program.wasm",
    "https://demo.invalid/a/assets/programs/wasm32/program.wasm",
    "binaries/programs/wasm32/../program.wasm",
    "binaries/programs/wasm32/program%2fwrapper.wasm",
    "binaries/programs/wasm32/program%252fwrapper.wasm",
    "binaries/programs/wasm32/program.wasm?version=1",
    "binaries/programs/wasm32/program.wasm#fragment",
    "binaries\\programs\\wasm32\\program.wasm",
    "kandelo-lazy:programs/../program.wasm",
    "kandelo-lazy:programs/program%2fwrapper.wasm",
    "kandelo-lazy:programs/program.wasm?version=1",
    "program.zip",
    "vim.zip#fragment",
    "freeciv.zip#fragment",
    "nethack.zip\0",
  ])("rejects unsafe grouped legacy reference %j", (reference) => {
    expect(() => normalizeImageOwnedLazyReference(reference)).toThrow(
      /reference is invalid|path is invalid/,
    );
  });
});
