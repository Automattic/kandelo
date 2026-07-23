import { describe, expect, it, vi } from "vitest";
import {
  createBatchedBrowserBinaryResolution,
} from "../../apps/browser-demos/vite-binary-resolution";

describe("Vite browser binary resolution", () => {
  it("checks the complete authored graph in one batch and reuses exact capabilities", () => {
    const resolveBatch = vi.fn(
      (relPaths: readonly string[]) =>
        relPaths.map((relPath) =>
          relPath.endsWith("present.wasm") ? "/cache/present.wasm" : null
        ),
    );
    const resolveOne = vi.fn(() => {
      throw new Error("cached graph entries must not use scalar resolution");
    });
    const approve = vi.fn((file: string) => `approved:${file}`);
    const candidateEntryExists = vi.fn((relPath: string) =>
      relPath.endsWith("present.wasm")
    );
    const resolution = createBatchedBrowserBinaryResolution(
      [
        "programs/present.wasm",
        "programs/absent.wasm",
        "programs/wasm32/present.wasm",
      ],
      {
        normalizeRelPath: (relPath) =>
          relPath.startsWith("programs/wasm32/")
            ? relPath
            : relPath.replace("programs/", "programs/wasm32/"),
        resolveBatch,
        resolveOne,
        approve,
        candidateEntryExists,
      },
    );

    expect(resolveBatch).not.toHaveBeenCalled();
    expect(resolution.resolve("programs/present.wasm")).toBe(
      "approved:/cache/present.wasm",
    );
    expect(resolveBatch).toHaveBeenCalledOnce();
    expect(resolveBatch).toHaveBeenCalledWith([
      "programs/wasm32/present.wasm",
      "programs/wasm32/absent.wasm",
    ]);
    expect(resolution.resolve("programs/wasm32/present.wasm")).toBe(
      "approved:/cache/present.wasm",
    );
    expect(resolution.resolve("programs/absent.wasm")).toBeNull();
    expect(resolveOne).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledOnce();
  });

  it("does not run the package checker when no package bytes exist", () => {
    const resolveBatch = vi.fn(() => {
      throw new Error("an empty browser session must not run the checker");
    });
    const resolution = createBatchedBrowserBinaryResolution(
      ["one", "two"],
      {
        normalizeRelPath: (relPath) => relPath,
        resolveBatch,
        resolveOne: () => null,
        approve: (file) => file,
        candidateEntryExists: () => false,
      },
    );

    expect(resolution.resolve("one")).toBeNull();
    expect(resolution.resolve("two")).toBeNull();
    expect(resolveBatch).not.toHaveBeenCalled();
  });

  it("shares one synchronous batch across back-to-back first requests", () => {
    const resolveBatch = vi.fn(() => ["/cache/one", "/cache/two"]);
    const resolution = createBatchedBrowserBinaryResolution(
      ["one", "two"],
      {
        normalizeRelPath: (relPath) => relPath,
        resolveBatch,
        resolveOne: () => null,
        approve: (file) => file,
        candidateEntryExists: () => true,
      },
    );

    // resolve() and the underlying filesystem resolver are synchronous, so
    // Vite cannot interleave two first calls in one config isolate. These
    // adjacent calls are the strongest possible first-request concurrency.
    expect([
      resolution.resolve("one"),
      resolution.resolve("two"),
    ]).toEqual(["/cache/one", "/cache/two"]);
    expect(resolveBatch).toHaveBeenCalledOnce();
  });

  it("rechecks only an optional artifact whose mirror appears after startup", () => {
    let installed = false;
    const resolveBatch = vi.fn(() => [null]);
    const resolveOne = vi.fn(() => "/cache/optional.vfs.zst");
    const approve = vi.fn((file: string) => `approved:${file}`);
    const resolution = createBatchedBrowserBinaryResolution(
      ["programs/wasm32/optional.vfs.zst"],
      {
        normalizeRelPath: (relPath) => relPath,
        resolveBatch,
        resolveOne,
        approve,
        candidateEntryExists: () => installed,
      },
    );

    expect(resolution.resolve("programs/wasm32/optional.vfs.zst")).toBeNull();
    expect(resolveOne).not.toHaveBeenCalled();

    installed = true;
    expect(resolution.resolve("programs/wasm32/optional.vfs.zst")).toBe(
      "approved:/cache/optional.vfs.zst",
    );
    expect(resolveOne).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledOnce();

    expect(resolution.resolve("programs/wasm32/optional.vfs.zst")).toBe(
      "approved:/cache/optional.vfs.zst",
    );
    expect(resolveOne).toHaveBeenCalledOnce();
  });

  it("rejects a malformed batch result instead of misassigning capabilities", () => {
    const resolution = createBatchedBrowserBinaryResolution(
      ["one", "two"],
      {
        normalizeRelPath: (relPath) => relPath,
        resolveBatch: () => ["/cache/one"],
        resolveOne: () => null,
        approve: (file) => file,
        candidateEntryExists: () => true,
      },
    );

    expect(() => resolution.resolve("one")).toThrow(
      "wrong number of entries",
    );
  });

  it("keeps a failed first batch closed and retries the whole graph", () => {
    let attempt = 0;
    const resolveBatch = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("projection unavailable");
      return ["/cache/one", "/cache/two"];
    });
    const resolution = createBatchedBrowserBinaryResolution(
      ["one", "two"],
      {
        normalizeRelPath: (relPath) => relPath,
        resolveBatch,
        resolveOne: () => null,
        approve: (file) => file,
        candidateEntryExists: () => true,
      },
    );

    expect(() => resolution.resolve("one")).toThrow(
      "projection unavailable",
    );
    expect(resolution.resolve("two")).toBe("/cache/two");
    expect(resolveBatch).toHaveBeenCalledTimes(2);
  });
});
