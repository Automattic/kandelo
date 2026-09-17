import { describe, expect, it } from "vitest";
import {
  imageOwnedRuntimeUrlMapper,
  imageOwnedRuntimeUrlTable,
  normalizeImageOwnedLazyReference,
} from "../../apps/browser-demos/lib/init/image-owned-runtime-urls";

/**
 * These used to build a `MemoryFileSystem`, bind every lazy URL INTO it, and
 * read the stored records back. They do not any more, because nothing rewrites
 * the image: the image keeps the canonical address and the deployment maps it
 * when it fetches (defect B45 — the rewriting was a host-side write to the
 * image's deferred half, which the legacy writer silently erased once
 * `tools/mkrootfs` began emitting `SDEF`).
 *
 * So the subject is a pure function now, and the tests need no image at all.
 * That is worth noticing rather than just accepting: the old file had to build
 * a two-archive, two-file fixture to ask "where would this URL end up", and the
 * answer never depended on the image.
 */
describe("image-owned grouped runtime URLs", () => {
  const AUTHORITY = {
    deploymentBase: "/a/",
    directoryUrl: "https://demo.invalid/a/assets-group/",
    manifestUrl: "https://demo.invalid/a/assets-group/manifest.json",
  };

  it("maps a legacy reference into the group manifest directory", () => {
    const map = imageOwnedRuntimeUrlMapper(AUTHORITY);
    expect(map("binaries/programs/wasm32/program.wasm")).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
    );
    expect(map("kandelo-lazy:programs/lazy-program.wasm")).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/lazy-program.wasm",
    );
    expect(map("vim.zip")).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/vim.zip",
    );
  });

  it("maps /a/ and /candidate-b/ to their own exact manifest directories", () => {
    const primary = imageOwnedRuntimeUrlMapper(AUTHORITY);
    const candidate = imageOwnedRuntimeUrlMapper({
      deploymentBase: "/candidate-b/",
      directoryUrl: "https://demo.invalid/candidate-b/assets-group/",
      manifestUrl: "https://demo.invalid/candidate-b/assets-group/manifest.json",
    });
    const reference = "binaries/programs/wasm32/program.wasm";
    expect(primary(reference)).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
    );
    expect(candidate(reference)).toBe(
      "https://demo.invalid/candidate-b/assets-group/assets/programs/wasm32/program.wasm",
    );
  });

  // The old file asserted that a malformed transport did not mutate a PRECEDING
  // valid one, because binding walked the image and wrote as it went, so a
  // failure halfway could leave the image partly bound. A mapper has no
  // partial state to leave: one reference failing is one call throwing.
  it("refuses a reference outside the grammar, and the refusal is per call", () => {
    const map = imageOwnedRuntimeUrlMapper(AUTHORITY);
    expect(() => map("https://demo.invalid/a/forged.wasm")).toThrow();
    // The next call is unaffected. There is nothing to leave half-written.
    expect(map("binaries/programs/wasm32/program.wasm")).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
    );
  });

  it("does not retain caller-mutable authority", () => {
    const mutable = { ...AUTHORITY };
    const map = imageOwnedRuntimeUrlMapper(mutable);
    mutable.manifestUrl = "https://evil.invalid/a/assets-group/manifest.json";
    mutable.directoryUrl = "https://evil.invalid/a/assets-group/";
    expect(map("binaries/programs/wasm32/program.wasm")).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/program.wasm",
    );
  });

  it("builds a table whose keys come from the DEPLOYMENT, not from an image", () => {
    // The point of the table: a worker can be handed the whole mapping without
    // anyone enumerating an image's deferred entries, which is the operation
    // that made B45 silent. The deployment imports every asset it serves, so
    // it already knows the key set.
    const table = imageOwnedRuntimeUrlTable(AUTHORITY);
    const keys = Object.keys(table);
    expect(keys.length).toBeGreaterThan(0);
    for (const [reference, url] of Object.entries(table)) {
      expect(url, `${reference} must stay inside the deployment`)
        .toMatch(/^https:\/\/demo\.invalid\/a\/assets-group\//);
    }
    // And a known rootfs binary is in it, so the table is not merely non-empty.
    expect(table["binaries/programs/wasm32/dash.wasm"]).toBe(
      "https://demo.invalid/a/assets-group/assets/programs/wasm32/dash.wasm",
    );
  });

  it("falls back to the deployment's own asset URLs when there is no asset group", () => {
    const table = imageOwnedRuntimeUrlTable(undefined);
    // No authority to resolve against, so the values are whatever this build
    // emitted for each import. What must hold is that every key resolves to
    // SOMETHING rather than being dropped.
    expect(Object.keys(table).length).toBeGreaterThan(0);
    for (const [reference, url] of Object.entries(table)) {
      expect(typeof url, `${reference} must map to a string`).toBe("string");
      expect(url.length).toBeGreaterThan(0);
    }
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
    expect(() => imageOwnedRuntimeUrlMapper({ ...AUTHORITY, ...patch }))
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
    "nethack.zip\0",
  ])("rejects unsafe grouped legacy reference %j", (reference) => {
    expect(() => normalizeImageOwnedLazyReference(reference)).toThrow(
      /reference is invalid|path is invalid/,
    );
  });
});
