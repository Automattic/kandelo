// The image's URI is the canonical ADDRESS. A deployment's hashed asset path is
// TRANSPORT POLICY, and since the URI relay the host already holds transport
// policy keyed by address (`buildRootfsLazyWiring`). So this stops being a
// mutation of the image and becomes a function applied when bytes are fetched.
//
// What that buys, beyond fixing B45: the host no longer enumerates the image's
// deferred entries anywhere, which is the operation an SDEF image cannot answer
// through the legacy reader and the last reason this path touched it at all.

import { resolveGroupedAssetUrl } from "../../../../web-libs/kandelo-session/src/vfs-asset-group";
import { normalizeImageOwnedLazyReference } from "../../../../web-libs/kandelo-session/src/vfs-asset-group-reference";
import { normalizeDeploymentBase } from "../../../../web-libs/kandelo-session/src/deployment-scope";
import { resolveShellLazyArchiveUrl, SHELL_LAZY_ARCHIVES } from "./lazy-archives";
import { ROOTFS_LAZY_ASSET_URLS } from "./rootfs-lazy-files";
import { SHELL_LAZY_PLACEHOLDER_URLS } from "./shell-lazy-files";
export { normalizeImageOwnedLazyReference } from "../../../../web-libs/kandelo-session/src/vfs-asset-group-reference";

export interface ImageOwnedRuntimeLazyAssets {
  deploymentBase: string;
  directoryUrl: string;
  manifestUrl: string;
}

/** Map an address the IMAGE recorded to the URL this deployment serves it at. */
export type ImageOwnedRuntimeUrlMapper = (reference: string) => string;

/**
 * The mapping as a plain object, ready to hand to a kernel worker.
 *
 * The keys come from what this DEPLOYMENT imports, not from what the image
 * contains. That is the whole point: asking an image to enumerate its deferred
 * entries host-side is the operation B45 is about, and it is unnecessary —
 * a deployment already knows every asset it serves, because it imported each
 * one to get a URL for it.
 *
 * A reference absent from the result is fetched as the image wrote it.
 */
export function imageOwnedRuntimeUrlTable(
  lazyAssets?: ImageOwnedRuntimeLazyAssets,
): Record<string, string> {
  const map = imageOwnedRuntimeUrlMapper(lazyAssets);
  const table: Record<string, string> = {};
  const references = [
    ...ROOTFS_LAZY_ASSET_URLS.keys(),
    ...SHELL_LAZY_PLACEHOLDER_URLS.keys(),
    ...Object.keys(SHELL_LAZY_ARCHIVES),
  ];
  for (const reference of references) {
    // A reference this deployment cannot express is skipped rather than
    // fatal. The grouped branch throws for anything outside its grammar, and
    // one unmappable entry must not cost the other sixty-four their mapping.
    try {
      table[reference] = map(reference);
    } catch {
      continue;
    }
  }
  return table;
}

/**
 * Build the mapper for this boot.
 *
 * Was `bindImageOwnedRuntimeUrls(fs, lazyAssets)`, which rewrote every lazy URL
 * inside the image. Nothing is rewritten now, which also dissolves that
 * function's own hazard: it validated every reference before the first mutation
 * so a malformed later archive could not leave a PARTLY BOUND image behind.
 * There is no partial state to leave.
 */
export function imageOwnedRuntimeUrlMapper(
  lazyAssets?: ImageOwnedRuntimeLazyAssets,
): ImageOwnedRuntimeUrlMapper {
  if (lazyAssets === undefined) return shellMapper;
  const authority = snapshotAuthority(lazyAssets);
  return (reference) => {
    const resolved = resolveGroupedAssetUrl(
      authority.manifestUrl,
      normalizeImageOwnedLazyReference(reference),
      authority.deploymentBase,
    );
    assertWithinAuthority(resolved, authority);
    return resolved;
  };
}

/**
 * The no-asset-group deployment: two literal tables built from vite `?url`
 * imports, then the archive resolver, which is already total — it falls back to
 * BASE_URL for a reference it does not recognise.
 */
const shellMapper: ImageOwnedRuntimeUrlMapper = (reference) =>
  ROOTFS_LAZY_ASSET_URLS.get(reference)
    ?? SHELL_LAZY_PLACEHOLDER_URLS.get(reference)
    ?? resolveShellLazyArchiveUrl(reference);

/**
 * The containment proof that `assertGroupedRuntimeUrlsBound` used to make over
 * the whole image after rewriting it. Per result now, which is the same check
 * at the only moment it can matter: `resolveGroupedAssetUrl` already refuses a
 * path that escapes, and this adds the query/fragment refusal it does not make.
 */
function assertWithinAuthority(
  value: string,
  authority: ImageOwnedRuntimeLazyAssets,
): void {
  const manifest = new URL(authority.manifestUrl);
  const directory = new URL(authority.directoryUrl);
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
