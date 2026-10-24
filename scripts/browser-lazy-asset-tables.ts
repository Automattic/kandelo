/**
 * The lazy files and lazy archives Kandelo's VFS images record, as the
 * browser deployment must serve them: one entry per address an image stores,
 * naming the package-mirror path whose bytes answer it.
 *
 *   images/rootfs/PACKAGES.toml             -> rootfs
 *   SHELL_LAZY_BINARY_SPECS                 -> shell
 *   SHELL_LAZY_ARCHIVE_SPECS (+ data specs) -> archives
 *
 * scripts/generate-browser-lazy-asset-urls.ts renders these into the browser's
 * URL tables, and scripts/check-browser-binary-supply.ts checks that the
 * supported package graph produces every path they name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHELL_LAZY_BINARY_SPECS } from "../images/vfs/lib/init/shell-binaries";
import {
  SHELL_LAZY_ARCHIVE_SPECS,
  SHELL_LAZY_DATA_ARCHIVE_SPECS,
} from "../images/vfs/scripts/shell-lazy-archives";
import { parsePackagesToml, rootfsLazyOutputs } from "./rootfs-packages-toml.mjs";

export interface LazyAssetEntry {
  /** The address the image records, and the table key. */
  key: string;
  /** The package-mirror path whose bytes the address names. */
  binary: string;
  /** Where the entry is declared, for diagnostics. */
  declaredBy: string;
}

export interface LazyAssetTables {
  rootfs: LazyAssetEntry[];
  shell: LazyAssetEntry[];
  archives: LazyAssetEntry[];
}

/** `programs/x` and `programs/wasm32/x` name the same mirror path; spell the
 *  architecture, as the browser binary scanner and the package index do. */
export function mirrorPath(resolverPath: string): string {
  if (!resolverPath.startsWith("programs/")) return resolverPath;
  const tail = resolverPath.slice("programs/".length);
  const arch = tail.split("/", 1)[0];
  return arch === "wasm32" || arch === "wasm64"
    ? resolverPath
    : `programs/wasm32/${tail}`;
}

function requireUniqueKeys(entries: readonly LazyAssetEntry[], source: string): void {
  const seen = new Set<string>();
  for (const { key } of entries) {
    if (seen.has(key)) throw new Error(`${source} declares ${key} twice`);
    seen.add(key);
  }
}

export function lazyAssetTables(repoRoot: string): LazyAssetTables {
  const mapping = parsePackagesToml(
    readFileSync(join(repoRoot, "images/rootfs/PACKAGES.toml"), "utf8"),
  );
  const rootfs = rootfsLazyOutputs(mapping).map(({ packageName, binary, lazyUrl }) => ({
    key: lazyUrl,
    binary,
    declaredBy: `images/rootfs/PACKAGES.toml package ${packageName}`,
  }));
  const shell = SHELL_LAZY_BINARY_SPECS.map((spec) => ({
    key: spec.resolverPath,
    binary: mirrorPath(spec.resolverPath),
    declaredBy: `SHELL_LAZY_BINARY_SPECS ${spec.id}`,
  }));
  const archives = [...SHELL_LAZY_ARCHIVE_SPECS, ...SHELL_LAZY_DATA_ARCHIVE_SPECS].map(
    (spec) => ({
      key: spec.archiveUrl,
      binary: mirrorPath(spec.resolverPath),
      declaredBy: `shell lazy archive ${spec.id}`,
    }),
  );
  requireUniqueKeys(rootfs, "images/rootfs/PACKAGES.toml");
  requireUniqueKeys(shell, "SHELL_LAZY_BINARY_SPECS");
  requireUniqueKeys(archives, "the shell lazy archive specs");
  return { rootfs, shell, archives };
}
