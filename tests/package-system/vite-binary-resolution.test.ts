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
    const mirrorEntryExists = vi.fn(() => false);
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
        mirrorEntryExists,
      },
    );

    expect(resolveBatch).toHaveBeenCalledOnce();
    expect(resolveBatch).toHaveBeenCalledWith([
      "programs/wasm32/present.wasm",
      "programs/wasm32/absent.wasm",
    ]);
    expect(resolution.resolve("programs/present.wasm")).toBe(
      "approved:/cache/present.wasm",
    );
    expect(resolution.resolve("programs/wasm32/present.wasm")).toBe(
      "approved:/cache/present.wasm",
    );
    expect(resolution.resolve("programs/absent.wasm")).toBeNull();
    expect(resolveOne).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledOnce();
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
        mirrorEntryExists: () => installed,
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
    expect(() =>
      createBatchedBrowserBinaryResolution(["one", "two"], {
        normalizeRelPath: (relPath) => relPath,
        resolveBatch: () => ["/cache/one"],
        resolveOne: () => null,
        approve: (file) => file,
        mirrorEntryExists: () => false,
      })
    ).toThrow("wrong number of entries");
  });
});
