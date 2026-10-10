// The URI an image records for a deferred file or lazy archive is its
// canonical ADDRESS. A deployment's hashed asset path is TRANSPORT POLICY: the
// kernel relays the address when it asks the host for bytes, and the host maps
// it to where this deployment serves them. So binding a deployment is a
// function applied when bytes are fetched, never a mutation of the image.
//
// Why not rewrite the image: its deferred entries (the SDEF section) are
// written and sealed by the Rust image writer, and rewriting their addresses
// host-side would mean enumerating and re-registering every one of them, which
// is how a deferred tree gets lost or a seal broken. Mapping at fetch time
// leaves the image exactly as it was built.

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
 * entries host-side is exactly what mapping at fetch time avoids, and it is
 * unnecessary — a deployment already knows every asset it serves, because it
 * imported each one to get a URL for it.
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
    // one unmappable entry must not cost every other reference its mapping.
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
 * With grouped lazy assets, every result is resolved inside the authority the
 * authenticated product activation supplied and checked against it. Because
 * nothing in the image is mutated, a reference that fails to resolve cannot
 * leave a partly bound image behind.
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
 * Containment proof for one mapped URL: it must stay on the manifest's origin,
 * inside the asset directory and the deployment base, with no query or
 * fragment. `resolveGroupedAssetUrl` already refuses a path that escapes; this
 * adds the query/fragment refusal it does not make.
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
