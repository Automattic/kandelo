export type OptionalDemoVfsImage = "node" | "wordpress" | "lamp";

export type OptionalDemoVfsImporter = () => Promise<string>;
export type OptionalDemoVfsImporters = Record<string, OptionalDemoVfsImporter>;

export const OPTIONAL_DEMO_VFS_PATHS: Record<
  OptionalDemoVfsImage,
  { label: string; relPaths: readonly string[] }
> = {
  node: {
    label: "node-vfs.vfs.zst",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/node-vfs.vfs.zst",
      "../../../../../binaries/programs/wasm32/node-vfs.vfs.zst",
    ],
  },
  wordpress: {
    label: "wordpress.vfs.zst",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/wordpress.vfs.zst",
      "../../../../../binaries/programs/wasm32/wordpress.vfs.zst",
    ],
  },
  lamp: {
    label: "lamp.vfs.zst",
    relPaths: [
      "../../../../../local-binaries/programs/wasm32/lamp.vfs.zst",
      "../../../../../binaries/programs/wasm32/lamp.vfs.zst",
    ],
  },
};

// Optional profiles must not make every Kandelo page resolve their VFS bytes.
// `import.meta.glob` tolerates an artifact that has not been materialized and
// returns a loader only for files that exist. The loader itself runs only when
// the corresponding demo is requested.
const OPTIONAL_DEMO_VFS_IMPORTERS = {
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/node-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/node-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/wordpress.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/wordpress.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/lamp.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/lamp.vfs.zst", {
    query: "?url", import: "default",
  }),
} as OptionalDemoVfsImporters;

export async function resolveOptionalDemoVfsUrl(
  image: OptionalDemoVfsImage,
  importers: OptionalDemoVfsImporters = OPTIONAL_DEMO_VFS_IMPORTERS,
): Promise<string> {
  const source = OPTIONAL_DEMO_VFS_PATHS[image];
  for (const relPath of source.relPaths) {
    const importer = importers[relPath];
    if (importer) return importer();
  }
  throw new Error(`${source.label} is not built. Run: ./run.sh fetch`);
}
