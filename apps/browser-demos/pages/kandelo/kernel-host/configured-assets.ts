import { ensureDirRecursive } from "../../../../../host/src/vfs/image-helpers";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { KandeloImageFs } from "../../../../../images/vfs/lib/kandelo-image-fs";
import type { DemoAssetConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import { ERRNO } from "../../../../../host/src/generated/abi";

export const MAX_CONFIGURED_ASSET_BYTES = 32 * 1024 * 1024;

const DEV_CORS_PROXY_PATH = import.meta.env.BASE_URL + "__kandelo_cors_proxy";

/** Stage image-declared assets before any privileged product is published. */
export async function stageConfiguredAssets(
  fs: KandeloImageFs,
  assets: DemoAssetConfig[],
  tick: (message: string) => void,
  assertCurrent: () => void,
): Promise<void> {
  let stagedBytes = 0;
  for (const asset of assets) {
    tick(`staging ${asset.path}...`);
    const response = await fetch(demoAssetFetchUrl(asset));
    if (!response.ok) {
      const failure = new Error(
        `fetch failed for ${asset.path}: ${response.status} ${response.statusText}`,
      );
      try { await response.body?.cancel(failure); }
      catch (cleanup) { throw new AggregateError([failure, cleanup], "Asset response and cancellation failed"); }
      throw failure;
    }
    const reader = response.body?.getReader();
    const hash = sha256.create();
    let offset = 0;
    try {
      assertCurrent();
      const parent = asset.path.slice(0, asset.path.lastIndexOf("/")) || "/";
      ensureDirRecursive(fs, parent);
      if (reader !== undefined) for (;;) {
        const next = await reader.read();
        assertCurrent();
        if (next.done) break;
        for (let start = 0; start < next.value.byteLength; start += 64 * 1024) {
          const chunk = next.value.subarray(start, start + 64 * 1024);
          if (!Number.isSafeInteger(offset + chunk.byteLength)) throw new Error(`Asset ${asset.path} is too large`);
          if (chunk.byteLength > MAX_CONFIGURED_ASSET_BYTES - stagedBytes) {
            throw Object.assign(new Error(`Configured assets exceed the ${MAX_CONFIGURED_ASSET_BYTES}-byte resident staging limit`),
              { code: "ENOMEM", errno: ERRNO.ENOMEM });
          }
          stagedBytes += chunk.byteLength;
          hash.update(chunk);
          fs.writeFileChunk(asset.path, offset, chunk, asset.mode ?? 0o644, offset === 0);
          offset += chunk.byteLength;
        }
      }
      if (offset === 0) fs.writeFileChunk(asset.path, 0, new Uint8Array(0), asset.mode ?? 0o644, true);
      const digest = bytesToHex(hash.digest());
      assertCurrent();
      if (asset.sha256 !== undefined && digest !== asset.sha256) {
        throw new Error(
          `${asset.path} sha256 mismatch: expected ${asset.sha256}, got ${digest}`,
        );
      }
    } catch (error) {
      try { await reader?.cancel(error); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Asset intake and cancellation failed"); }
      throw error;
    } finally {
      reader?.releaseLock();
    }
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
export function demoAssetFetchUrl(asset: DemoAssetConfig): string {
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
