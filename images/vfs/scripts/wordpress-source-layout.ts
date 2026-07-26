import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureExtract,
  ensureSourceExtract,
  type ExtractOptions,
} from "./source-extract-helper";
import { walkAndWrite } from "./vfs-image-helpers";

/**
 * `packages/registry/wordpress/setup.sh` creates this host-only alias so the
 * local, unpacked WordPress tree can find the separately unpacked SQLite
 * plugin. Product VFS builders compose their dependencies explicitly instead:
 * the SQLite image copies the pinned plugin source into the VFS, while the
 * MariaDB image must not include it.
 *
 * The setup alias is absolute and names the checkout that created it, so it
 * must never be preserved in a portable VFS image or followed implicitly.
 */
export const WORDPRESS_SETUP_SQLITE_PLUGIN_ALIAS =
  "wp-content/plugins/sqlite-database-integration";
export const WORDPRESS_CORE_GUEST_PATH = "/var/www/html";
export const WORDPRESS_SQLITE_PLUGIN_GUEST_PATH =
  "/var/www/html/wp-content/plugins/sqlite-database-integration";
export const WORDPRESS_SQLITE_PLUGIN_VERSION = "2.1.16";
export const WORDPRESS_SQLITE_PLUGIN_URL =
  `https://downloads.wordpress.org/plugin/sqlite-database-integration.${WORDPRESS_SQLITE_PLUGIN_VERSION}.zip`;
export const WORDPRESS_SQLITE_PLUGIN_SHA256 =
  "ccc69cada05983e6c2dac8c0962b548c437b4c96c00ea41b0e130fc128671391";

type SourceExtract = typeof ensureSourceExtract;
type ArchiveExtract = (options: ExtractOptions) => string;

/** Resolve WordPress core from its package.toml URL and SHA-256 contract. */
export function resolveWordPressCoreSource(
  repoRoot: string,
  resolve: SourceExtract = ensureSourceExtract,
): string {
  return resolve("wordpress", repoRoot);
}

/** Resolve the separately pinned SQLite plugin archive used by WordPress. */
export function resolveWordPressSqlitePluginSource(
  resolve: ArchiveExtract = ensureExtract,
): string {
  return resolve({
    url: WORDPRESS_SQLITE_PLUGIN_URL,
    sha256: WORDPRESS_SQLITE_PLUGIN_SHA256,
    cacheKey:
      `sqlite-database-integration-${WORDPRESS_SQLITE_PLUGIN_VERSION}`,
  });
}

export function isWordPressSetupOnlySourceEntry(relativePath: string): boolean {
  return relativePath === WORDPRESS_SETUP_SQLITE_PLUGIN_ALIAS;
}

/** Product policy for generated and mutable entries outside WordPress core. */
export function isExcludedWordPressCoreSourceEntry(
  relativePath: string,
): boolean {
  return relativePath.endsWith(".db") ||
    relativePath === "wp-config.php" ||
    relativePath === "wp-content/db.php" ||
    isWordPressSetupOnlySourceEntry(relativePath);
}

/** Copy verified WordPress core without local setup or mutable database state. */
export function copyWordPressCoreSource(
  fs: MemoryFileSystem,
  sourceDir: string,
): number {
  return walkAndWrite(fs, sourceDir, WORDPRESS_CORE_GUEST_PATH, {
    exclude: isExcludedWordPressCoreSourceEntry,
  });
}

/**
 * Materialize the verified plugin source at the path WordPress loads. This is
 * deliberately a second source-tree walk rather than following setup.sh's
 * host-only alias through the WordPress core tree.
 */
export function materializeWordPressSqlitePlugin(
  fs: MemoryFileSystem,
  sourceDir: string,
): number {
  return walkAndWrite(
    fs,
    sourceDir,
    WORDPRESS_SQLITE_PLUGIN_GUEST_PATH,
    { exclude: (relativePath) => relativePath.endsWith(".db") },
  );
}
