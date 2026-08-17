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

function demoAssetFetchUrl(asset: DemoAssetConfig): string {
  if (!asset.devCorsProxy || !import.meta.env.DEV) return asset.url;
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
