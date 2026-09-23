// Resolve a gallery PRODUCT's VFS image URL inside the running app.
//
// WHY THIS EXISTS: the app holds no machine table any more. `?demo=<id>` was
// removed precisely because nothing in the app maps a machine name to an
// image, so a spec that wants one specific machine has to spell the `?vfs=`
// URL itself (see docs/browser-support.md, "Selecting a machine").
//
// Only Vite knows where a product's bytes live in a given deployment: a
// SourceOnly content-addressed snapshot, the `local-binaries/` mirror, or the
// fetched `binaries/` mirror. This module therefore resolves through the exact
// same module specifiers `live-setup.ts` uses, so the URL it returns is
// byte-identical to the one the app's gallery resolves. That matters: the
// loader matches a `?vfs=` URL against the products it ships to decide the
// machine's resource ceiling, and a merely equivalent URL would boot the same
// bytes under the bounded custom-image policy instead of the product's own.
//
// Like the app, missing artifacts are tolerated rather than fatal: an
// unbuilt product rejects when it is asked for, not at module load, so a
// worktree with only some images built can still run the specs for those.

import shellVfsUrl from "@binaries/programs/wasm32/shell.vfs.zst?url";
import {
  resolveOptionalDemoVfsUrl,
  type OptionalDemoVfsImage,
} from "../../pages/kandelo/kernel-host/optional-demo-vfs";

type OptionalBinaryImporters = Record<string, () => Promise<string>>;

// The three products whose images are plain optional binaries. `live-setup.ts`
// keeps its own copy of these globs because the SourceOnly Vite boundary
// rewrites `import.meta.glob` by its literal specifier and importer, so the
// specifier cannot be shared through a variable or a helper.
const OPTIONAL_BINARY_VFS_URLS = {
  ...import.meta.glob(
    "../../../../local-binaries/programs/wasm32/nginx-vfs.vfs.zst",
    { query: "?url", import: "default" },
  ),
  ...import.meta.glob(
    "../../../../binaries/programs/wasm32/nginx-vfs.vfs.zst",
    { query: "?url", import: "default" },
  ),
  ...import.meta.glob(
    "../../../../local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    { query: "?url", import: "default" },
  ),
  ...import.meta.glob(
    "../../../../binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    { query: "?url", import: "default" },
  ),
  ...import.meta.glob(
    "../../../../local-binaries/programs/wasm32/ruby-todo-vfs.vfs.zst",
    { query: "?url", import: "default" },
  ),
  ...import.meta.glob(
    "../../../../binaries/programs/wasm32/ruby-todo-vfs.vfs.zst",
    { query: "?url", import: "default" },
  ),
} as OptionalBinaryImporters;

const OPTIONAL_BINARY_PRODUCTS: Record<
  string,
  { label: string; relPaths: readonly string[] }
> = {
  "browser-nginx": {
    label: "nginx-vfs.vfs.zst",
    relPaths: [
      "../../../../local-binaries/programs/wasm32/nginx-vfs.vfs.zst",
      "../../../../binaries/programs/wasm32/nginx-vfs.vfs.zst",
    ],
  },
  "browser-nginx-php": {
    label: "nginx-php-vfs.vfs.zst",
    relPaths: [
      "../../../../local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
      "../../../../binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    ],
  },
  "browser-ruby-todo": {
    label: "ruby-todo-vfs.vfs.zst",
    relPaths: [
      "../../../../local-binaries/programs/wasm32/ruby-todo-vfs.vfs.zst",
      "../../../../binaries/programs/wasm32/ruby-todo-vfs.vfs.zst",
    ],
  },
};

const OPTIONAL_DEMO_PRODUCTS: Record<string, OptionalDemoVfsImage> = {
  "browser-node": "node",
  "browser-wordpress": "wordpress",
  "browser-lamp": "lamp",
};

/** Thrown when this worktree has not materialized a product's image. */
export class VfsProductImageNotBuiltError extends Error {}

export async function vfsProductImageUrl(productId: string): Promise<string> {
  if (productId === "browser-main-shell") return shellVfsUrl;

  const optionalDemo = OPTIONAL_DEMO_PRODUCTS[productId];
  if (optionalDemo !== undefined) {
    try {
      return await resolveOptionalDemoVfsUrl(optionalDemo);
    } catch (error) {
      throw new VfsProductImageNotBuiltError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const optionalBinary = OPTIONAL_BINARY_PRODUCTS[productId];
  if (optionalBinary === undefined) {
    throw new Error(`unknown gallery product ${JSON.stringify(productId)}`);
  }
  for (const relPath of optionalBinary.relPaths) {
    const importer = OPTIONAL_BINARY_VFS_URLS[relPath];
    if (importer) return importer();
  }
  throw new VfsProductImageNotBuiltError(
    `${optionalBinary.label} is not built. Run: ./run.sh build programs`,
  );
}
