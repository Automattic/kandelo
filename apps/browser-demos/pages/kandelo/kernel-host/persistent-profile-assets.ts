import type { BrowserKernel } from "@host/browser-kernel-host";
import type { DemoAssetConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";

export const MAX_PROFILE_ASSET_BYTES = 32 * 1024 * 1024;

export async function ensurePersistentProfileAssets(
  kernel: Pick<BrowserKernel, "statVfsPath" | "writeFileToVfs" | "unlinkFileFromVfs">,
  assets: DemoAssetConfig[],
  tick: (message: string) => void,
  assertCurrent: () => void,
  fetchUrl: (asset: DemoAssetConfig) => string = asset => asset.url,
): Promise<void> {
  let remaining = MAX_PROFILE_ASSET_BYTES;
  for (const asset of assets) {
    assertCurrent();
    if (await kernel.statVfsPath(asset.path) !== null) continue;
    assertCurrent();
    tick(`installing activity asset ${asset.path}...`);
    const response = await fetch(fetchUrl(asset));
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`fetch failed for ${asset.path}: ${response.status} ${response.statusText}`);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      if (reader !== undefined) for (;;) {
        const next = await reader.read();
        assertCurrent();
        if (next.done) break;
        if (next.value.byteLength > remaining - length) throw new Error("Boot profile assets exceed the 32 MiB staging limit");
        chunks.push(next.value);
        length += next.value.byteLength;
      }
    } catch (error) {
      try { await reader?.cancel(error); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Boot asset intake and cancellation failed"); }
      throw error;
    } finally { reader?.releaseLock(); }
    remaining -= length;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    chunks.length = 0;
    if (asset.sha256 !== undefined) {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      if (digest !== asset.sha256) throw new Error(`${asset.path} sha256 mismatch: expected ${asset.sha256}, got ${digest}`);
    }
    assertCurrent();
    try { await kernel.writeFileToVfs(asset.path, bytes, asset.mode ?? 0o644); }
    catch (error) {
      try { await kernel.unlinkFileFromVfs(asset.path); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `Boot asset installation and cleanup failed for ${asset.path}`); }
      throw error;
    }
    assertCurrent();
  }
}
