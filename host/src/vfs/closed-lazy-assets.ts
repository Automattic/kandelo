/**
 * One exact immutable response available to a closed lazy-VFS fetcher.
 * Supplying this set disables ambient network fallback: any URL absent from
 * the set is rejected. This lets pre-publication acceptance exercise the
 * real worker/VFS path without changing the URLs stored in an image.
 */
export interface ClosedLazyAsset {
  url: string;
  sha256: string;
  size: number;
  bytes: Uint8Array;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
export const MAX_CLOSED_LAZY_ASSETS = 128;
export const MAX_CLOSED_LAZY_ASSET_BYTES = 512 * 1024 * 1024;

/** Validate and snapshot a bounded, canonical HTTPS URL-to-byte binding. */
export function snapshotClosedLazyAssets(
  assets: readonly ClosedLazyAsset[],
): ClosedLazyAsset[] {
  return validateClosedLazyAssets(assets, true);
}

function validateClosedLazyAssets(
  assets: readonly ClosedLazyAsset[],
  copy: boolean,
): ClosedLazyAsset[] {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error("closed lazy assets must contain at least one binding");
  }
  if (assets.length > MAX_CLOSED_LAZY_ASSETS) {
    throw new Error(
      `closed lazy assets exceed ${MAX_CLOSED_LAZY_ASSETS} bindings`,
    );
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  return assets.map((asset, index) => {
    if (typeof asset !== "object" || asset === null) {
      throw new Error(`closed lazy asset ${index} is not an object`);
    }
    const { url, sha256, size, bytes } = asset;
    if (
      typeof url !== "string" || !SHA256_RE.test(sha256) ||
      !Number.isSafeInteger(size) || size <= 0 ||
      !(bytes instanceof Uint8Array)
    ) {
      throw new Error(`closed lazy asset ${index} has invalid fields`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      throw new Error(`closed lazy asset ${index} URL is invalid`, { cause: error });
    }
    if (
      parsed.protocol !== "https:" || parsed.username !== "" ||
      parsed.password !== "" || parsed.hash !== "" || parsed.href !== url
    ) {
      throw new Error(
        `closed lazy asset ${index} must use one canonical credential-free HTTPS URL`,
      );
    }
    if (seen.has(url)) {
      throw new Error(`closed lazy assets duplicate URL ${url}`);
    }
    if (bytes.byteLength !== size) {
      throw new Error(
        `closed lazy asset ${index} has ${bytes.byteLength} bytes, expected ${size}`,
      );
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CLOSED_LAZY_ASSET_BYTES) {
      throw new Error(
        `closed lazy assets exceed ${MAX_CLOSED_LAZY_ASSET_BYTES} bytes`,
      );
    }
    seen.add(url);
    if (
      !copy &&
      (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 ||
        bytes.buffer.byteLength !== bytes.byteLength)
    ) {
      throw new Error(
        `closed lazy asset ${index} ownership requires one whole ordinary ArrayBuffer`,
      );
    }
    return { url, sha256, size, bytes: copy ? copyBytes(bytes) : bytes };
  });
}

/**
 * Construct an exhaustive in-memory fetcher. It never delegates to the
 * network, including for an unbound URL, and verifies identity before it
 * creates a successful Response.
 */
export function createClosedLazyAssetFetcher(
  assets: readonly ClosedLazyAsset[],
): (url: string) => Promise<Response> {
  return createFetcherFromSnapshot(snapshotClosedLazyAssets(assets));
}

/**
 * Worker-only variant for already transferred, exclusively owned bindings.
 * The caller gives up mutation rights; validation retains the buffers without
 * another aggregate-sized copy.
 */
export function createClosedLazyAssetFetcherFromOwnedAssets(
  assets: readonly ClosedLazyAsset[],
): (url: string) => Promise<Response> {
  return createFetcherFromSnapshot(validateClosedLazyAssets(assets, false));
}

function createFetcherFromSnapshot(
  snapshot: readonly ClosedLazyAsset[],
): (url: string) => Promise<Response> {
  const assetByUrl = new Map(snapshot.map((asset) => [asset.url, asset]));
  return async (url: string): Promise<Response> => {
    const asset = assetByUrl.get(url);
    if (asset === undefined) {
      throw new Error(`closed lazy assets do not bind URL ${url}`);
    }
    if (asset.bytes.byteLength !== asset.size) {
      throw new Error(`closed lazy asset ${url} changed size before response`);
    }
    const digestInput = new ArrayBuffer(asset.bytes.byteLength);
    new Uint8Array(digestInput).set(asset.bytes);
    const actualSha256 = hex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput)),
    );
    if (actualSha256 !== asset.sha256) {
      throw new Error(`closed lazy asset ${url} changed SHA-256 before response`);
    }
    const responseBytes = copyBytes(asset.bytes);
    return new Response(responseBytes.buffer, {
      status: 200,
      headers: { "content-length": String(responseBytes.byteLength) },
    });
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
