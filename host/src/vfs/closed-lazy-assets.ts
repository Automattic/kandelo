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
 * only the separately declared HTTPS URL, digest, and size survive. A caller
 * abort or first source failure stops new work and closes every active body
 * before the loader rejects with that exact first reason.
 */
export async function loadClosedLazyAssetSources(
  sources: readonly ClosedLazyAssetSource[],
  options: {
    fetchImpl?: FetchLike;
    maxConcurrency?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ClosedLazyAsset[]> {
  const validated = validateClosedLazyAssetSources(sources);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxConcurrency = options.maxConcurrency ?? 4;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
    throw new Error(
      "closed lazy asset source concurrency must be an integer from 1 to 16",
    );
  }

  const controller = new AbortController();
  let firstFailure: { reason: unknown } | undefined;
  const fail = (reason: unknown): void => {
    if (firstFailure !== undefined) return;
    firstFailure = { reason };
    controller.abort(reason);
  };

  const callerSignal = options.signal;
  const onCallerAbort = (): void => fail(callerSignal!.reason);
  let callerListenerAdded = false;
  if (callerSignal?.aborted) {
    fail(callerSignal.reason);
  } else if (callerSignal !== undefined) {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    callerListenerAdded = true;
  }

  const output = new Array<ClosedLazyAsset>(validated.length);
  let next = 0;
  const loadOne = async (
    source: ClosedLazyAssetSource,
  ): Promise<ClosedLazyAsset> => {
    const diagnosticUrl = redactSourceUrl(source.sourceUrl);
    try {
      throwIfAborted(controller.signal);
      const response = await fetchImpl(source.sourceUrl, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        await cancelResponseBody(response, controller.signal.reason);
        throw controller.signal.reason;
      }
      if (response.redirected) {
        const error = new Error(
          `closed lazy asset source ${diagnosticUrl} followed a redirect`,
        );
        fail(error);
        await cancelResponseBody(response, error);
        throw error;
      }
      if (!response.ok) {
        const error = new Error(
          `closed lazy asset source ${diagnosticUrl} returned HTTP ${response.status}`,
        );
        fail(error);
        await cancelResponseBody(response, error);
        throw error;
      }
      const bytes = await readExactResponseBytes(
        response,
        source.size,
        diagnosticUrl,
        controller.signal,
        fail,
      );
      throwIfAborted(controller.signal);
      const actualSha256 = hex(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes.buffer),
        ),
      );
      throwIfAborted(controller.signal);
      if (actualSha256 !== source.sha256) {
        const error = new Error(
          `closed lazy asset source ${diagnosticUrl} changed SHA-256`,
        );
        fail(error);
        throw error;
      }
      return {
        url: source.url,
        sha256: source.sha256,
        size: source.size,
        bytes,
      };
    } catch (reason) {
      fail(reason);
      throw reason;
    }
  };

  try {
    const workers = Array.from(
      { length: Math.min(maxConcurrency, validated.length) },
      async () => {
        while (firstFailure === undefined) {
          const index = next;
          next += 1;
          if (index >= validated.length) return;
          try {
            output[index] = await loadOne(validated[index]!);
          } catch (reason) {
            fail(reason);
            return;
          }
        }
      },
    );
    await Promise.all(workers);
    if (firstFailure !== undefined) throw firstFailure.reason;
    return output;
  } finally {
    if (callerListenerAdded) {
      callerSignal!.removeEventListener("abort", onCallerAbort);
    }
  }
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
  const validated = new Array<ClosedLazyAsset>(assets.length);
  for (let index = 0; index < assets.length; index += 1) {
    if (!Object.hasOwn(assets, index)) {
      throw new Error(`closed lazy asset ${index} is missing`);
    }
    const asset = assets[index];
    if (typeof asset !== "object" || asset === null) {
      throw new Error(`closed lazy asset ${index} is not an object`);
    }
    const { url, sha256, size, bytes } = asset;
    if (
      typeof url !== "string" || typeof sha256 !== "string" ||
      !SHA256_RE.test(sha256) ||
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
    validated[index] = { url, sha256, size, bytes };
  }
  if (!copy) return validated;
  return validated.map(({ url, sha256, size, bytes }) => ({
    url,
    sha256,
    size,
    bytes: copyBytes(bytes),
  }));
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
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("closed lazy asset sources must contain at least one binding");
  }
  if (sources.length > MAX_CLOSED_LAZY_ASSETS) {
    throw new Error(
      `closed lazy asset sources exceed ${MAX_CLOSED_LAZY_ASSETS} bindings`,
    );
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const validated = new Array<ClosedLazyAssetSource>(sources.length);
  for (let index = 0; index < sources.length; index += 1) {
    if (!Object.hasOwn(sources, index)) {
      throw new Error(`closed lazy asset source ${index} is missing`);
    }
    const source = sources[index];
    if (typeof source !== "object" || source === null) {
      throw new Error(`closed lazy asset source ${index} is not an object`);
    }
    const { url, sourceUrl, sha256, size } = source;
    if (
      typeof url !== "string" || typeof sourceUrl !== "string" ||
      sourceUrl.length === 0 || typeof sha256 !== "string" ||
      !SHA256_RE.test(sha256) ||
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
    validated[index] = { url, sourceUrl, sha256, size };
  }
  return validated;
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
    parsed.password !== "" || parsed.hash !== "" || url.includes("#") ||
    parsed.href !== url
  ) {
    throw new Error(
      `${label} must use one canonical credential-free HTTPS URL`,
    );
  }
}

function validateClosedSourceUrl(sourceUrl: string, index: number): void {
  const validationOrigin = "https://closed-source.invalid";
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl, `${validationOrigin}/`);
  } catch (error) {
    throw new Error(`closed lazy asset source ${index} fetch URL is invalid`, {
      cause: error,
    });
  }
  const relative = sourceUrl.startsWith("/");
  const serializedRelative = parsed.href.slice(validationOrigin.length);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" ||
    sourceUrl.includes("#") ||
    (relative
      ? parsed.origin !== validationOrigin || serializedRelative !== sourceUrl
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
  diagnosticUrl: string,
  signal: AbortSignal,
  fail: (reason: unknown) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) {
    const error = new Error(
      `closed lazy asset source ${diagnosticUrl} has no response body`,
    );
    fail(error);
    throw error;
  }
  const output = new Uint8Array(expectedBytes);
  const reader = response.body.getReader();
  let cancelPromise: Promise<void> | undefined;
  const cancel = (reason: unknown): Promise<void> => {
    if (cancelPromise !== undefined) return cancelPromise;
    try {
      cancelPromise = reader.cancel(reason).then(
        () => {},
        () => {},
      );
    } catch {
      cancelPromise = Promise.resolve();
    }
    return cancelPromise;
  };
  const onAbort = (): void => {
    void cancel(signal.reason);
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  let offset = 0;
  try {
    throwIfAborted(signal);
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (value.byteLength > expectedBytes - offset) {
        const error = new Error(
          `closed lazy asset source ${diagnosticUrl} exceeds ${expectedBytes} bytes`,
        );
        fail(error);
        await cancel(error);
        throw error;
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== expectedBytes) {
      const error = new Error(
        `closed lazy asset source ${diagnosticUrl} has ${offset} bytes, ` +
          `expected ${expectedBytes}`,
      );
      fail(error);
      throw error;
    }
    return output;
  } catch (reason) {
    fail(reason);
    throw reason;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) await cancel(signal.reason);
    if (cancelPromise !== undefined) await cancelPromise;
    reader.releaseLock();
  }
}

async function cancelResponseBody(
  response: Response,
  reason: unknown,
): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel(reason);
  } catch {
    // Cleanup failures must not replace the original transport failure.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function redactSourceUrl(sourceUrl: string): string {
  const queryIndex = sourceUrl.indexOf("?");
  if (queryIndex === -1) return sourceUrl;
  return `${sourceUrl.slice(0, queryIndex)}?<redacted>`;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
