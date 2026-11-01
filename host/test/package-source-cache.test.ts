import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ metadata: "", prefix: ["kandelo", "computers", "11111111-1111-4111-8111-111111111111", "software"],
  open: vi.fn(), resolveFile: vi.fn(), published: false, failPublication: false,
  readBody: vi.fn(), release: vi.fn(), remove: vi.fn(), abort: vi.fn() }));
const computerId = state.prefix[2];
const targetName = "target-22222222-2222-4222-8222-222222222222";
const fileName = "source-33333333-3333-4333-8333-333333333333.vfs";
const file = {} as FileSystemFileHandle;
const directory = `https://example.test/vfs-groups/${"a".repeat(64)}/`;

vi.mock("../src/browser-computer-storage", () => ({ browserComputerDirectory: async () => ({ getDirectoryHandle: async () => software }) }));
vi.mock("../src/vfs/opfs-file-reference", async importActual => ({ ...await importActual<typeof import("../src/vfs/opfs-file-reference")>(),
  openOpfsFileReference: (...args: unknown[]) => state.resolveFile(...args) }));
vi.mock("../../apps/browser-demos/lib/kernel-owned-boot", () => ({ loadPositionedImageWriterModuleBytes: async () => Uint8Array.of(1) }));
vi.mock("../../apps/browser-demos/pages/kandelo/kernel-host/package-image-source", () => ({ BrowserPackageImageSource: { open: (...args: unknown[]) => state.open(...args) } }));

import { openSavedPackageSource, stageCurrentPackageSource } from "../../apps/browser-demos/pages/kandelo/kernel-host/package-source-cache";
import type { PagesVfsProductLoader } from "../../apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-loader";

const software = {
  getDirectoryHandle: async () => ({}),
  getFileHandle: async () => ({
    getFile: async () => ({ size: new TextEncoder().encode(state.metadata).length,
      arrayBuffer: async () => { state.readBody(); return new TextEncoder().encode(state.metadata).buffer; } }),
    createWritable: async () => {
      let next = "";
      return { write: async (bytes: Uint8Array) => { next = new TextDecoder().decode(bytes); },
        close: async () => { if (state.failPublication) throw new Error("metadata publication failed"); state.metadata = next; state.published = true; }, abort: state.abort };
    },
  }),
};

function receipt() {
  return { version: 1, productId: "browser-wordpress-family", file: { path: [...state.prefix, targetName, fileName] },
    length: 1000, sha256: "b".repeat(64), directory };
}

function setup() {
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ resolve: async () => [...state.prefix] }) } });
  state.open.mockResolvedValue({ inventoryBytes: 4, close: vi.fn(async () => {}) });
  state.resolveFile.mockResolvedValue(file);
  state.metadata = JSON.stringify(receipt());
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); state.published = false; state.failPublication = false; });

describe("computer-owned package source receipt", () => {
  it("keeps the authenticated compressed transport identity distinct from the retained decoded image", async () => {
    setup();
    const value = receipt();
    const compressed = { bytes: 100, sha256: "c".repeat(64) };
    const loader = { softwareTarget: async () => ({ ...compressed, directory }),
      activatePositioned: async () => ({ transportIdentity: compressed, source: { reference: value.file,
        integrity: { length: value.length, imageSha256: value.sha256 }, release: state.release, remove: state.remove } }) } as unknown as PagesVfsProductLoader;
    const source = await stageCurrentPackageSource(computerId, value.productId, loader, new AbortController().signal);
    expect(JSON.parse(state.metadata)).toEqual(value);
    expect(state.open).toHaveBeenCalledWith(Uint8Array.of(1), file, value, expect.any(AbortSignal));
    await source.close();
  });

  it.each(["bytes", "sha256"] as const)("refuses substituted transport %s before publishing the decoded source receipt", async mismatch => {
    setup();
    const value = receipt();
    const transport = { bytes: value.length, sha256: value.sha256 };
    const substituted = { ...transport, [mismatch]: mismatch === "bytes" ? value.length + 1 : "c".repeat(64) };
    const loader = { softwareTarget: async () => ({ ...transport, directory }),
      activatePositioned: async () => ({ transportIdentity: substituted, source: { reference: value.file,
        integrity: { length: value.length, imageSha256: value.sha256 }, release: state.release, remove: state.remove } }) } as unknown as PagesVfsProductLoader;
    await expect(stageCurrentPackageSource(computerId, value.productId, loader, new AbortController().signal)).rejects.toThrow("differs from the verified release identity");
    expect(state.published).toBe(false);
    expect(state.release).not.toHaveBeenCalled();
    expect(state.remove).toHaveBeenCalledOnce();
  });

  it("opens only the bounded retained source belonging to the selected computer", async () => {
    setup();
    const signal = new AbortController().signal;
    const source = await openSavedPackageSource(computerId, signal);
    expect(state.resolveFile).toHaveBeenCalledWith(receipt().file);
    expect(state.open).toHaveBeenCalledWith(Uint8Array.of(1), file, receipt(), signal);
    await source.close();
    expect((await state.open.mock.results[0].value).close).toHaveBeenCalledOnce();
  });

  it.each(["foreign", "future", "escape", "oversized"] as const)("refuses %s metadata before opening a target worker", async scenario => {
    setup();
    const value = receipt();
    if (scenario === "foreign") value.file.path[2] = "44444444-4444-4444-8444-444444444444";
    if (scenario === "future") value.version = 2;
    if (scenario === "escape") value.file.path.push("..");
    state.metadata = scenario === "oversized" ? "x".repeat(16385) : JSON.stringify(value);
    await expect(openSavedPackageSource(computerId, new AbortController().signal)).rejects.toThrow();
    expect(state.open).not.toHaveBeenCalled();
    expect(state.resolveFile).not.toHaveBeenCalled();
    if (scenario === "oversized") expect(state.readBody).not.toHaveBeenCalled();
  });

  it.each([false, true])("publishes the source receipt before transferring its staging lease (%s)", async fail => {
    setup();
    const previous = state.metadata;
    state.failPublication = fail;
    const value = receipt();
    state.release.mockImplementation(async () => { expect(state.published).toBe(true); });
    const loader = { softwareTarget: async () => ({ bytes: value.length, sha256: value.sha256, directory }),
      activatePositioned: async () => ({ transportIdentity: { bytes: value.length, sha256: value.sha256 }, source: { reference: value.file,
        integrity: { length: value.length, imageSha256: value.sha256 }, release: state.release, remove: state.remove } }) } as unknown as PagesVfsProductLoader;
    const pending = stageCurrentPackageSource(computerId, value.productId, loader, new AbortController().signal);
    if (fail) {
      await expect(pending).rejects.toThrow("metadata publication failed");
      expect(state.metadata).toBe(previous);
      expect(state.release).not.toHaveBeenCalled();
      expect(state.remove).toHaveBeenCalledOnce();
      expect(state.abort).toHaveBeenCalledOnce();
    } else {
      const owned = await pending;
      expect(JSON.parse(state.metadata)).toEqual(value);
      expect(state.release).toHaveBeenCalledOnce();
      expect(state.remove).not.toHaveBeenCalled();
      await owned.close();
    }
  });
});
