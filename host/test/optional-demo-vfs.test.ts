import { describe, expect, it, vi } from "vitest";
import {
  OPTIONAL_DEMO_VFS_PATHS,
  resolveOptionalDemoVfsUrl,
  type OptionalDemoVfsImage,
  type OptionalDemoVfsImporters,
} from "../../apps/browser-demos/pages/kandelo/kernel-host/optional-demo-vfs";

function importerMap(
  values: Partial<Record<OptionalDemoVfsImage, string>>,
  useFallback = false,
): {
  importers: OptionalDemoVfsImporters;
  calls: Record<OptionalDemoVfsImage, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    node: vi.fn(async () => values.node ?? "/node.vfs.zst"),
    wordpress: vi.fn(async () => values.wordpress ?? "/wordpress.vfs.zst"),
    lamp: vi.fn(async () => values.lamp ?? "/lamp.vfs.zst"),
  };
  const importers: OptionalDemoVfsImporters = {};
  for (const image of ["node", "wordpress", "lamp"] as const) {
    const paths = OPTIONAL_DEMO_VFS_PATHS[image].relPaths;
    importers[paths[useFallback ? 1 : 0]] = calls[image];
  }
  return { importers, calls };
}

describe("optional demo VFS imports", () => {
  it.each([
    ["node", "/selected-node.vfs.zst"],
    ["wordpress", "/selected-wordpress.vfs.zst"],
    ["lamp", "/selected-lamp.vfs.zst"],
  ] as const)("loads only the %s VFS importer when that demo is requested", async (
    image,
    expected,
  ) => {
    const { importers, calls } = importerMap({ [image]: expected });

    await expect(resolveOptionalDemoVfsUrl(image, importers)).resolves.toBe(expected);
    for (const candidate of ["node", "wordpress", "lamp"] as const) {
      expect(calls[candidate]).toHaveBeenCalledTimes(candidate === image ? 1 : 0);
    }
  });

  it("does not invoke any importer until a demo asks for its VFS", () => {
    const { calls } = importerMap({});
    expect(calls.node).not.toHaveBeenCalled();
    expect(calls.wordpress).not.toHaveBeenCalled();
    expect(calls.lamp).not.toHaveBeenCalled();
  });

  it("uses the fetched-binary importer when no local artifact exists", async () => {
    const { importers, calls } = importerMap(
      { wordpress: "/fetched-wordpress.vfs.zst" },
      true,
    );
    await expect(resolveOptionalDemoVfsUrl("wordpress", importers)).resolves.toBe(
      "/fetched-wordpress.vfs.zst",
    );
    expect(calls.wordpress).toHaveBeenCalledOnce();
    expect(calls.node).not.toHaveBeenCalled();
    expect(calls.lamp).not.toHaveBeenCalled();
  });

  it("fails truthfully when the requested demo artifact is absent", async () => {
    const { importers, calls } = importerMap({});
    delete importers[OPTIONAL_DEMO_VFS_PATHS.node.relPaths[0]];

    await expect(resolveOptionalDemoVfsUrl("node", importers)).rejects.toThrow(
      "node-vfs.vfs.zst is not built. Run: ./run.sh fetch",
    );
    expect(calls.node).not.toHaveBeenCalled();
    expect(calls.wordpress).not.toHaveBeenCalled();
    expect(calls.lamp).not.toHaveBeenCalled();
  });

  it("prefers a local artifact without touching the fetched fallback", async () => {
    const local = vi.fn(async () => "/local-node.vfs.zst");
    const fetched = vi.fn(async () => "/fetched-node.vfs.zst");
    const [localPath, fetchedPath] = OPTIONAL_DEMO_VFS_PATHS.node.relPaths;

    await expect(resolveOptionalDemoVfsUrl("node", {
      [localPath]: local,
      [fetchedPath]: fetched,
    })).resolves.toBe("/local-node.vfs.zst");
    expect(local).toHaveBeenCalledOnce();
    expect(fetched).not.toHaveBeenCalled();
  });
});
