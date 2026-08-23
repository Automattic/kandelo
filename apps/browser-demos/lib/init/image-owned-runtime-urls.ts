import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { resolveGroupedAssetUrl } from "../../../../web-libs/kandelo-session/src/vfs-asset-group";
import { normalizeImageOwnedLazyReference } from "../../../../web-libs/kandelo-session/src/vfs-asset-group-reference";
import { normalizeDeploymentBase } from "../../../../web-libs/kandelo-session/src/deployment-scope";
import { resolveShellLazyArchiveUrl } from "./lazy-archives";
import {
  assertShellLazyUrlsResolved,
  rewriteShellLazyFileUrls,
} from "./shell-lazy-files";
export { normalizeImageOwnedLazyReference } from "../../../../web-libs/kandelo-session/src/vfs-asset-group-reference";

export interface ImageOwnedRuntimeLazyAssets {
  deploymentBase: string;
  directoryUrl: string;
  manifestUrl: string;
}

/**
 * Bind every build-time lazy URL before accepting an image for serialization.
 */
export function bindImageOwnedRuntimeUrls(
  fs: MemoryFileSystem,
  lazyAssets?: ImageOwnedRuntimeLazyAssets,
): void {
  if (lazyAssets !== undefined) {
    bindGroupedRuntimeUrls(fs, lazyAssets);
    return;
  }
  fs.rewriteLazyArchiveUrls(resolveShellLazyArchiveUrl);
  rewriteShellLazyFileUrls(fs);
  // WHY: this is the commit point for every image-owned transport rewrite.
  // Omitting the final assertion defers a broken build-time URL to users.
  assertShellLazyUrlsResolved(fs);
}

function bindGroupedRuntimeUrls(
  fs: MemoryFileSystem,
  lazyAssets: ImageOwnedRuntimeLazyAssets,
): void {
  const authority = snapshotAuthority(lazyAssets);
  const replacements = new Map<string, string>();
  const resolve = (reference: string): void => {
    if (replacements.has(reference)) return;
    replacements.set(
      reference,
      resolveGroupedAssetUrl(
        authority.manifestUrl,
        normalizeImageOwnedLazyReference(reference),
        authority.deploymentBase,
      ),
    );
  };

  for (const entry of fs.exportLazyEntries()) resolve(entry.url);
  for (const entry of fs.exportLazyArchiveEntries()) {
    for (const transport of entry.content?.transports ?? [entry.url]) {
      resolve(transport);
    }
  }

  // WHY: every transport is validated before the first mutable URL rewrite so
  // one malformed later archive cannot leave a partly-bound image behind.
  fs.rewriteLazyFileUrls((url) => replacementFor(replacements, url));
  fs.rewriteLazyArchiveUrls((url) => replacementFor(replacements, url));
  assertGroupedRuntimeUrlsBound(fs, authority);
}

function snapshotAuthority(
  value: ImageOwnedRuntimeLazyAssets,
): ImageOwnedRuntimeLazyAssets {
  const manifestUrl = String(value.manifestUrl);
  const directoryUrl = String(value.directoryUrl);
  const deploymentBase = normalizeDeploymentBase(String(value.deploymentBase));
  let manifest: URL;
  let directory: URL;
  try {
    manifest = new URL(manifestUrl);
    directory = new URL(directoryUrl);
  } catch {
    throw new Error("Image-owned lazy runtime authority is invalid");
  }
  if (
    manifest.search !== "" ||
    manifest.hash !== "" ||
    directory.href !== new URL("./", manifest).href ||
    !manifest.pathname.startsWith(deploymentBase)
  ) {
    throw new Error("Image-owned lazy runtime authority is invalid");
  }
  return Object.freeze({
    deploymentBase,
    directoryUrl: directory.href,
    manifestUrl: manifest.href,
  });
}

function replacementFor(
  replacements: ReadonlyMap<string, string>,
  reference: string,
): string {
  const replacement = replacements.get(reference);
  if (replacement === undefined) {
    throw new Error("Image-owned lazy runtime reference changed during binding");
  }
  return replacement;
}

function assertGroupedRuntimeUrlsBound(
  fs: MemoryFileSystem,
  authority: ImageOwnedRuntimeLazyAssets,
): void {
  const manifest = new URL(authority.manifestUrl);
  const directory = new URL(authority.directoryUrl);
  const urls = [
    ...fs.exportLazyEntries().map((entry) => entry.url),
    ...fs.exportLazyArchiveEntries().flatMap((entry) =>
      entry.content?.transports ?? [entry.url]
    ),
  ];
  for (const value of urls) {
    const url = new URL(value);
    if (
      url.origin !== manifest.origin ||
      url.search !== "" ||
      url.hash !== "" ||
      !url.pathname.startsWith(directory.pathname) ||
      !url.pathname.startsWith(authority.deploymentBase)
    ) {
      throw new Error("Image-owned lazy runtime URL escaped its authority");
    }
  }
}
