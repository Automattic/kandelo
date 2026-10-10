import type { LazyFetch } from "./lazy-download-event";

export type DeferredByteProgress = (loadedBytes: number, totalBytes?: number) => void;

function progress(listener: DeferredByteProgress | undefined, loaded: number, total?: number): void {
  try { listener?.(loaded, total); } catch { /* observers do not control transport */ }
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;
const TRANSIENT_CODES = new Set([
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETDOWN", "ENETRESET", "ENETUNREACH", "EPIPE", "ETIMEDOUT",
  "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

class HttpFailure extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null, url: string) {
    super(`lazy fetch of ${url} failed: HTTP ${status}`);
  }
}

function chainSome(error: unknown, predicate: (value: any) => boolean): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; error !== undefined && depth < 8; depth++) {
    if (seen.has(error)) break;
    seen.add(error);
    if (predicate(error)) return true;
    error = typeof error === "object" && error !== null
      ? (error as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function retryDelay(error: unknown, attempt: number): number | null {
  if (chainSome(error, (value) => value?.name === "AbortError" || value?.code === "ABORT_ERR")) return null;
  if (error instanceof HttpFailure) {
    if (error.status !== 408 && error.status !== 429 && !(error.status >= 500 && error.status <= 599)) return null;
    const header = error.retryAfter?.trim();
    if (header) {
      const delay = /^\d+$/.test(header)
        ? Number(header) * 1_000 : Math.max(0, Date.parse(header) - Date.now());
      if (Number.isSafeInteger(delay)) return Math.min(delay, MAX_DELAY_MS);
    }
  } else if (!chainSome(error, (value) => value instanceof TypeError
    || value?.name === "NetworkError" || value?.name === "TimeoutError"
    || TRANSIENT_CODES.has(value?.code))) return null;
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

/** Read with the native image's declared transfer bound before retaining chunks.
 * This protects the worker's memory; Rust still verifies size and digest before
 * materializing a file. A stream bound failure is permanent, never retryable.
 */
async function boundedResponseBytes(response: Response, maxBytes?: number, onProgress?: DeferredByteProgress): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  const advertisedLength = lengthHeader !== null && /^\d+$/.test(lengthHeader.trim())
    ? Number(lengthHeader) : undefined;
  const total = advertisedLength !== undefined && Number.isSafeInteger(advertisedLength)
    ? advertisedLength : maxBytes;
  if (maxBytes !== undefined && lengthHeader !== null && /^\d+$/.test(lengthHeader.trim())
    && Number(lengthHeader) > maxBytes) {
    throw new Error(`Lazy response exceeds native byte bound ${maxBytes}`);
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maxBytes !== undefined && bytes.length > maxBytes) {
      throw new Error(`Lazy response exceeds native byte bound ${maxBytes}`);
    }
    progress(onProgress, bytes.length, total);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (!Number.isSafeInteger(length) || (maxBytes !== undefined && length > maxBytes)) {
        throw new Error(`Lazy response exceeds native byte bound ${maxBytes}`);
      }
      chunks.push(value);
      progress(onProgress, length, total);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* preserve read/bound failure */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

/** Main's bounded transport policy, shared by Node and browser native rootfs.
 * Only transient transport errors retry. The kernel verifies the returned
 * bytes' length/digest and never asks this transport to retry integrity errors.
 */
export async function fetchLazyResourceBytes(fetcher: LazyFetch, url: string, maxBytes?: number, onProgress?: DeferredByteProgress): Promise<Uint8Array> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error("Invalid native lazy resource byte bound");
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetcher(url);
      if (!response.ok) throw new HttpFailure(response.status, response.headers.get("retry-after"), url);
      return await boundedResponseBytes(response, maxBytes, onProgress);
    } catch (error) {
      // Discard each failed response before retrying. Cleanup cannot change
      // whether the original failure is transient or turn abort into retry.
      try { await response?.body?.cancel(error); } catch { /* already consumed */ }
      const delay = attempt + 1 < MAX_ATTEMPTS ? retryDelay(error, attempt) : null;
      if (delay === null) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Lazy transport retry state became unreachable");
}
