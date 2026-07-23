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

/**
 * One acceptance-only transport source whose bytes are bound to the canonical
 * HTTPS URL stored in a deferred VFS tree only after verification. `sourceUrl`
 * may be a canonical root-relative URL or a canonical absolute HTTP(S) URL.
 * Fetches omit credentials and reject redirects; the exact size and SHA-256
 * declared here remain the authority.
 */
export interface ClosedLazyAssetSource {
  url: string;
  sourceUrl: string;
  sha256: string;
  size: number;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const SHA256_RE = /^[0-9a-f]{64}$/;
export const MAX_CLOSED_LAZY_ASSETS = 128;
export const MAX_CLOSED_LAZY_ASSET_BYTES = 512 * 1024 * 1024;

/**
 * Fetch and verify acceptance-only sources before giving them canonical lazy
 * transport identities. This never treats the source URL as VFS authority:
 * only the separately declared HTTPS URL, digest, and size survive.
 */
export async function loadClosedLazyAssetSources(
  sources: readonly ClosedLazyAssetSource[],
  options: { fetchImpl?: FetchLike; maxConcurrency?: number } = {},
): Promise<ClosedLazyAsset[]> {
  const validated = validateClosedLazyAssetSources(sources);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxConcurrency = options.maxConcurrency ?? 4;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
    throw new Error(
      "closed lazy asset source concurrency must be an integer from 1 to 16",
    );
  }
  return mapWithConcurrency(validated, maxConcurrency, async (source) => {
    const response = await fetchImpl(source.sourceUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(
        `closed lazy asset source ${source.sourceUrl} returned HTTP ${response.status}`,
      );
    }
    const bytes = await readExactResponseBytes(response, source.size, source.sourceUrl);
    const actualSha256 = hex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", copyBytes(bytes).buffer)),
    );
    if (actualSha256 !== source.sha256) {
      throw new Error(`closed lazy asset source ${source.sourceUrl} changed SHA-256`);
    }
    return {
      url: source.url,
      sha256: source.sha256,
      size: source.size,
      bytes,
    };
  });
}

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
    validateCanonicalClosedUrl(url, `closed lazy asset ${index}`);
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

function validateClosedLazyAssetSources(
  sources: readonly ClosedLazyAssetSource[],
): ClosedLazyAssetSource[] {
  if (!Array.isArray(sources)) {
    throw new Error("closed lazy asset sources must be an array");
  }
  if (sources.length > MAX_CLOSED_LAZY_ASSETS) {
    throw new Error(
      `closed lazy asset sources exceed ${MAX_CLOSED_LAZY_ASSETS} bindings`,
    );
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  return sources.map((source, index) => {
    if (typeof source !== "object" || source === null) {
      throw new Error(`closed lazy asset source ${index} is not an object`);
    }
    const { url, sourceUrl, sha256, size } = source;
    if (
      typeof url !== "string" || typeof sourceUrl !== "string" ||
      sourceUrl.length === 0 || !SHA256_RE.test(sha256) ||
      !Number.isSafeInteger(size) || size <= 0
    ) {
      throw new Error(`closed lazy asset source ${index} has invalid fields`);
    }
    validateCanonicalClosedUrl(url, `closed lazy asset source ${index}`);
    validateClosedSourceUrl(sourceUrl, index);
    if (seen.has(url)) {
      throw new Error(`closed lazy asset sources duplicate URL ${url}`);
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CLOSED_LAZY_ASSET_BYTES) {
      throw new Error(
        `closed lazy asset sources exceed ${MAX_CLOSED_LAZY_ASSET_BYTES} bytes`,
      );
    }
    seen.add(url);
    return { url, sourceUrl, sha256, size };
  });
}

function validateCanonicalClosedUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`${label} URL is invalid`, { cause: error });
  }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" ||
    parsed.password !== "" || parsed.hash !== "" || parsed.href !== url
  ) {
    throw new Error(
      `${label} must use one canonical credential-free HTTPS URL`,
    );
  }
}

function validateClosedSourceUrl(sourceUrl: string, index: number): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl, "https://closed-source.invalid/");
  } catch (error) {
    throw new Error(`closed lazy asset source ${index} fetch URL is invalid`, {
      cause: error,
    });
  }
  const relative = sourceUrl.startsWith("/");
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" ||
    (relative
      ? `${parsed.pathname}${parsed.search}` !== sourceUrl
      : parsed.href !== sourceUrl)
  ) {
    throw new Error(
      `closed lazy asset source ${index} fetch URL must be canonical HTTP(S)`,
    );
  }
}

async function readExactResponseBytes(
  response: Response,
  expectedBytes: number,
  sourceUrl: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new Error(
        `closed lazy asset source ${sourceUrl} has invalid Content-Length`,
      );
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength !== expectedBytes) {
      throw new Error(
        `closed lazy asset source ${sourceUrl} declares ${declaredLength} bytes, ` +
          `expected ${expectedBytes}`,
      );
    }
  }
  if (response.body === null) {
    throw new Error(
      `closed lazy asset source ${sourceUrl} has no response body`,
    );
  }
  const output = new Uint8Array(expectedBytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > expectedBytes - offset) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `closed lazy asset source ${sourceUrl} exceeds ${expectedBytes} bytes`,
        );
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) {
    throw new Error(
      `closed lazy asset source ${sourceUrl} has ${offset} bytes, ` +
        `expected ${expectedBytes}`,
    );
  }
  return output;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        output[index] = await map(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
