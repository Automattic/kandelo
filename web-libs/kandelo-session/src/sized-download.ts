/**
 * Streaming reader for a response body whose exact decoded size is already
 * known from an authenticated manifest, with optional progress reporting.
 *
 * Boot-time VFS image loads are the long silent wait on a cold start, so the
 * boot screen needs incremental byte counts rather than one `arrayBuffer()`
 * that resolves only when the whole image has landed.
 *
 * The result is always allocated in ordinary (non-shared) memory. The main
 * thread must never take ownership of a SharedArrayBuffer — the live VFS is
 * worker-owned so WebKit reclaims it on `Worker.terminate()` instead of lazy
 * GC (see the Safari image-switch OOM).
 */

/** Cumulative decoded bytes read so far, against the expected total. */
export type SizedDownloadProgress = (
  loadedBytes: number,
  totalBytes: number,
) => void;

/**
 * Read `response` into exactly `expectedBytes` bytes, reporting cumulative
 * progress per chunk. Rejects an over- or under-length body; callers
 * authenticate the returned bytes separately.
 */
export async function readExactSizedBody(
  response: Response,
  expectedBytes: number,
  label: string,
  onProgress?: SizedDownloadProgress,
): Promise<Uint8Array> {
  if (response.body === null) throw new Error(`${label} has no response body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      // WHY: check before retaining the chunk so an oversized body cannot make
      // this reader buffer past the size its manifest authorized.
      if (length > expectedBytes)
        throw new Error(`${label} received length exceeds ${expectedBytes}`);
      chunks.push(value);
      onProgress?.(length, expectedBytes);
    }
  } finally {
    reader.releaseLock();
  }
  if (length !== expectedBytes)
    throw new Error(`${label} received length differs from ${expectedBytes}`);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Read a response whose size is not declared by any authenticated manifest,
 * reporting progress against `Content-Length` when that header is usable.
 *
 * This is the lenient peer of {@link readExactSizedBody}, for user-supplied
 * `?vfs=` images. It deliberately does not enforce the advertised length: a
 * header is not an authenticated identity, and failing a boot that previously
 * worked because a server mis-reports its own body would be a regression.
 */
export async function readStreamedBody(
  response: Response,
  label: string,
  onProgress?: (loadedBytes: number, totalBytes: number | undefined) => void,
): Promise<Uint8Array> {
  if (response.body === null) throw new Error(`${label} has no response body`);
  const totalBytes = identityEncodedContentLength(response);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      chunks.push(value);
      onProgress?.(length, totalBytes);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * The advertised body length, but only when the response is identity-encoded.
 *
 * `Content-Length` describes the transferred representation. A CDN that
 * compresses the response reports the compressed length while the reader
 * observes decoded bytes, so trusting it would run a progress bar past 100%.
 * An unusable header yields `undefined`, which callers show as indeterminate
 * progress rather than an invented total.
 */
export function identityEncodedContentLength(
  response: Response,
): number | undefined {
  const encoding = response.headers.get("content-encoding")?.trim()
    .toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    return undefined;
  }
  const length = response.headers.get("content-length");
  if (length === null || !/^[0-9]+$/u.test(length)) return undefined;
  const parsed = Number(length);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
