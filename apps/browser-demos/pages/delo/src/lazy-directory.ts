// Where this deployment serves the lazy files and archives of a delo
// computer: the directory of an image's own asset group when it has one,
// else the deployment's asset group, as Kandelo's computer page chooses
// (pages/kandelo/kernel-host/live-setup.ts), else the dev server's route.

import { imageOwnedLazyAssetDirectory, type ImageOwnedRuntimeLazyAssets } from "../../../lib/init/image-owned-runtime-urls";
import { createPagesVfsProductLoader, type PagesVfsProductEntry } from "../../kandelo/kernel-host/pages-vfs-product-loader";
// @ts-expect-error Vite owns this virtual module in both canonical and normal mode.
import canonicalPagesVfsProducts from "virtual:kandelo-pages-vfs-products";

const PRODUCTS = canonicalPagesVfsProducts as readonly PagesVfsProductEntry[] | null;
const LOADER = PRODUCTS === null ? undefined : createPagesVfsProductLoader(PRODUCTS, (url, init) => fetch(url, init), { prefetchEager: false });

export function deloLazyDirectory(lazyAssets?: ImageOwnedRuntimeLazyAssets): string | undefined {
  return imageOwnedLazyAssetDirectory(lazyAssets ?? LOADER?.deploymentLazyAssets());
}
