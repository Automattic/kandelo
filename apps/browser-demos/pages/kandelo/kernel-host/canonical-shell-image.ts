/**
 * The canonical shell image's URL, when this server has built it.
 *
 * The canonical shell is optional on the dev server: a worktree that built
 * only a partial image (`./run.sh partial`) or nothing yet still serves the
 * app, and the shell's gallery entry reports it as not built instead of the
 * page failing to load. A module of its own so the app shell can ask without
 * loading the whole kernel host (live-setup.ts, which main.tsx imports on
 * demand).
 *
 * WHY a static import and not a glob: the shell is the Pages registry's eager
 * product (pages-vfs-products.toml), and scripts/check-pages-vfs-product-registry.mjs
 * requires an eager product to be statically imported. The `optional` query
 * lets only the dev server resolve an unbuilt shell to `null`
 * (resolveBinariesAlias in vite.config.ts); a production build without the
 * shell still fails, and the canonical Pages build maps it to its product.
 */
// @ts-expect-error vite/client types `*?url`, not this `?url&optional` form.
import canonicalShellUrl from "@binaries/programs/wasm32/shell.vfs.zst?url&optional";

export const CANONICAL_SHELL_REL_PATHS = [
  "../../../../../local-binaries/programs/wasm32/shell.vfs.zst",
  "../../../../../binaries/programs/wasm32/shell.vfs.zst",
];

export const CANONICAL_SHELL_IMAGE_URL: string | null =
  canonicalShellUrl as string | null;
