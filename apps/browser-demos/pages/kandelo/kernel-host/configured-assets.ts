import { writeVfsBinary } from "../../../../../host/src/vfs/image-helpers";
import type { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import type { DemoAssetConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";

const DEV_CORS_PROXY_PATH = import.meta.env.BASE_URL + "__kandelo_cors_proxy";

/** Stage image-declared assets before any privileged product is published. */
export async function stageConfiguredAssets(
  fs: MemoryFileSystem,
  assets: DemoAssetConfig[],
  tick: (message: string) => void,
  assertCurrent: () => void,
): Promise<void> {
  for (const asset of assets) {
    tick(`staging ${asset.path}...`);
    const response = await fetch(demoAssetFetchUrl(asset));
    if (!response.ok) {
      throw new Error(
        `fetch failed for ${asset.path}: ${response.status} ${response.statusText}`,
      );
    }
    const buffer = await response.arrayBuffer();
    assertCurrent();
    if (asset.sha256) {
      const digest = await sha256Hex(buffer);
      assertCurrent();
      if (digest !== asset.sha256) {
        throw new Error(
          `${asset.path} sha256 mismatch: expected ${asset.sha256}, got ${digest}`,
        );
      }
    }
    writeVfsBinary(fs, asset.path, new Uint8Array(buffer), asset.mode ?? 0o644);
  }
}

/**
 * Where to actually fetch an image-declared asset from.
 *
 * The image says only where the bytes live. Whether reaching them needs the
 * dev server's same-origin CORS detour is the HOST's call, and the host has
 * everything it needs to make it: it knows it is a dev server
 * (`import.meta.env.DEV`) and it knows its own origin. So in dev, route every
 * cross-origin asset URL through the proxy and leave same-origin ones alone.
 *
 * This replaced a per-asset `devCorsProxy: true` flag in the image's
 * demo.json. The flag could only help images that knew Kandelo's dev-server
 * convention; deriving it from the URL means a third-party image's
 * cross-origin asset works in dev too. A URL that does not parse is left
 * untouched — `fetch` should report it, not this function.
 */
function demoAssetFetchUrl(asset: DemoAssetConfig): string {
  if (!import.meta.env.DEV) return asset.url;
  let assetOrigin: string;
  try {
    assetOrigin = new URL(asset.url, window.location.href).origin;
  } catch {
    return asset.url;
  }
  if (assetOrigin === window.location.origin) return asset.url;
  const proxyUrl = new URL(DEV_CORS_PROXY_PATH, window.location.href);
  proxyUrl.searchParams.set("url", asset.url);
  return proxyUrl.href;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
