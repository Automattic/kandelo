import { afterEach, expect, it, vi } from "vitest";
import { openOpfsFileReference, referenceOpfsFile, snapshotOpfsFileReference } from "../src/vfs/opfs-file-reference";

afterEach(() => vi.unstubAllGlobals());

it.each([null, {}, { path: [] }, { path: "file" }, { path: ["..", "file"] }, { path: ["."] },
  { path: [""] }, { path: ["a/b"] }, { path: ["a\\b"] }, { path: ["a\0b"] }, { path: [19] },
  { path: ["x".repeat(256)] }, { path: ["é".repeat(128)] }, { path: Array(33).fill("a") }, { path: Array(32).fill("x".repeat(200)) }])(
  "rejects malformed or oversized OPFS references: %j", async reference => {
    const getDirectory = vi.fn();
    vi.stubGlobal("navigator", { storage: { getDirectory } });
    expect(() => snapshotOpfsFileReference(reference)).toThrow("Invalid OPFS file reference");
    await expect(openOpfsFileReference(reference as never)).rejects.toThrow("Invalid OPFS file reference");
    expect(getDirectory).not.toHaveBeenCalled();
  },
);

it("reopens a copied origin-relative path without creating directories or files", async () => {
  const file = {};
  const getFileHandle = vi.fn(async () => file);
  const getDirectoryHandle = vi.fn(async () => ({ getFileHandle }));
  const root = { resolve: vi.fn(async () => ["machine", "image.vfs"]), getDirectoryHandle };
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  const reference = await referenceOpfsFile(file as FileSystemFileHandle);
  expect(reference).toEqual({ path: ["machine", "image.vfs"] });
  expect(structuredClone(reference)).toEqual(reference);
  const opening = openOpfsFileReference(reference);
  (reference.path as string[])[0] = "replacement";
  expect(await opening).toBe(file);
  expect(getDirectoryHandle).toHaveBeenCalledExactlyOnceWith("machine");
  expect(getFileHandle).toHaveBeenCalledExactlyOnceWith("image.vfs");
});

it("refuses handles outside the origin-private filesystem", async () => {
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ resolve: async () => null }) } });
  await expect(referenceOpfsFile({} as FileSystemFileHandle)).rejects.toThrow("Invalid OPFS file reference");
});
