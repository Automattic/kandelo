/**
 * The canonical shell image's URL, when this server has built it.
 *
 * The canonical shell is optional: a worktree that built only a partial image
 * (`./run.sh partial`) or nothing yet still serves the app, and the shell's
 * gallery entry reports it as not built instead of the page failing to load.
 * A module of its own so the app shell can ask without loading the whole
 * kernel host (live-setup.ts, which main.tsx imports on demand).
 */
export const CANONICAL_SHELL_URL_LOADERS = {
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/shell.vfs.zst", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/shell.vfs.zst", { query: "?url", import: "default" }),
} as Record<string, () => Promise<string>>;

export const CANONICAL_SHELL_REL_PATHS = [
  "../../../../../local-binaries/programs/wasm32/shell.vfs.zst",
  "../../../../../binaries/programs/wasm32/shell.vfs.zst",
];

async function loadCanonicalShellUrl(): Promise<string | null> {
  for (const relPath of CANONICAL_SHELL_REL_PATHS) {
    const loader = CANONICAL_SHELL_URL_LOADERS[relPath];
    if (loader === undefined) continue;
    try {
      return await loader();
    } catch {
      // A glob entry the SourceOnly projection does not publish: not built.
    }
  }
  return null;
}

export const CANONICAL_SHELL_IMAGE_URL: string | null = await loadCanonicalShellUrl();
