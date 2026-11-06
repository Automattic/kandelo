// The URI an image records for a deferred file or lazy archive is its
// canonical ADDRESS. A deployment's asset path is TRANSPORT POLICY: the kernel
// relays the address when it asks the host for bytes, and the host maps it to
// where this deployment serves them. So binding a deployment is a function
// applied when bytes are fetched, never a mutation of the image.
//
// Why not rewrite the image: its deferred entries (the SDEF section) are
// written and sealed by the Rust image writer, and rewriting their addresses
// host-side would mean enumerating and re-registering every one of them, which
// is how a deferred tree gets lost or a seal broken. Mapping at fetch time
// leaves the image exactly as it was built.
//
// The mapping is a rule, not a table: every address in the image-owned grammar
// names its package member (`normalizeImageOwnedLazyReference`), and the
// kernel worker resolves that member under the directory returned here
// (`resolveImageOwnedLazyAsset`). So the browser app lists nothing an image
// might carry; whatever the built images reference is what gets fetched.

import { normalizeDeploymentBase } from "../../../../web-libs/kandelo-session/src/deployment-scope";
import { DEV_LAZY_ASSET_ROUTE } from "./dev-lazy-asset-route";
export { normalizeImageOwnedLazyReference } from "../../../../web-libs/kandelo-session/src/vfs-asset-group-reference";

export interface ImageOwnedRuntimeLazyAssets {
  deploymentBase: string;
  directoryUrl: string;
  manifestUrl: string;
}

/**
 * Where this deployment serves the package members images reference: the
 * authenticated asset group's directory when an authority is supplied (a
 * product activation's, or the deployment's own for other images), or the
 * dev server's lazy-asset route.
 *
 * A production build without an asset group has no directory. The kernel
 * then resolves each address against the deployment base as written, so a
 * body this deployment does not serve fails as an I/O error on the read that
 * needs it, while an image without lazy bodies boots normally.
 * `./run.sh build-browser` builds the group from the images' own lazy
 * entries.
 */
export function imageOwnedLazyAssetDirectory(
  lazyAssets?: ImageOwnedRuntimeLazyAssets,
): string | undefined {
  if (lazyAssets !== undefined) return snapshotAuthority(lazyAssets).directoryUrl;
  if (import.meta.env.DEV) {
    return new URL(
      `${import.meta.env.BASE_URL}${DEV_LAZY_ASSET_ROUTE}`,
      globalThis.location.href,
    ).href;
  }
  return undefined;
}

/**
 * Validate the activation's authority: the manifest is on the directory it
 * names, without query or fragment, inside the deployment base. The kernel
 * worker then keeps every resolved member inside that directory.
 */
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
