import type { LazyFetch } from "./lazy-download-event";

export type DeferredByteProgress = (loadedBytes: number, totalBytes?: number) => void;

function progress(listener: DeferredByteProgress | undefined, loaded: number, total?: number): void {
  try { listener?.(loaded, total); } catch { /* observers do not control transport */ }
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;

function abortable<Result>(
  operation: Promise<Result>,
  signal?: AbortSignal,
  discard?: (value: Result) => void,
): Promise<Result> {
  if (signal === undefined) return operation;
  return new Promise<Result>((resolve, reject) => {
    let abandoned = false;
    const abort = () => {
      abandoned = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => {
      signal.removeEventListener("abort", abort);
      if (abandoned) {
        try { discard?.(value); } catch {}
      } else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      if (!abandoned) reject(error);
    });
    if (signal.aborted) abort();
  });
}

function discardResponse(response: Response, reason: unknown): void {
  void Promise.resolve().then(() => response.body?.cancel(reason)).catch(() => {});
}

function waitForDeferredTimer(duration: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, duration);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
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
async function withLazyResponse<Result>(
  fetcher: LazyFetch,
  url: string,
  maxBytes: number | undefined,
  consume: (response: Response) => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error("Invalid native lazy resource byte bound");
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response | undefined;
    try {
      if (signal?.aborted) throw signal.reason;
      response = await abortable(
        signal === undefined ? fetcher(url) : fetcher(url, { signal }),
        signal,
        value => discardResponse(value, signal?.reason),
      );
      if (!response.ok) throw new HttpFailure(response.status, response.headers.get("retry-after"), url);
      return await consume(response);
    } catch (error) {
      // Discard each failed response before retrying. Cleanup cannot change
      // whether the original failure is transient or turn abort into retry.
      try {
        await abortable(Promise.resolve().then(() => response?.body?.cancel(error)), signal);
      } catch { /* already consumed or aborted */ }
      if (signal?.aborted) throw signal.reason;
      const delay = attempt + 1 < MAX_ATTEMPTS ? retryDelay(error, attempt) : null;
      if (delay === null) throw error;
      await waitForDeferredTimer(delay, signal);
    }
  }
  throw new Error("Lazy transport retry state became unreachable");
}

export async function fetchLazyResourceBytes(fetcher: LazyFetch, url: string, maxBytes?: number, onProgress?: DeferredByteProgress): Promise<Uint8Array> {
  return withLazyResponse(fetcher, url, maxBytes,
    response => boundedResponseBytes(response, maxBytes, onProgress));
}

export async function streamLazyResourceBytes(
  fetcher: LazyFetch,
  url: string,
  maxBytes: number,
  sink: { reset(): void; write(bytes: Uint8Array): void },
  onProgress?: DeferredByteProgress,
  signal?: AbortSignal,
): Promise<number> {
  return withLazyResponse(fetcher, url, maxBytes, async (response) => {
    sink.reset();
    const header = response.headers.get("content-length");
    const advertised = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : undefined;
    if (advertised !== undefined && advertised > maxBytes) {
      throw new Error(`Lazy response exceeds native byte bound ${maxBytes}`);
    }
    const total = advertised !== undefined && Number.isSafeInteger(advertised) ? advertised : maxBytes;
    let length = 0;
    if (response.body === null) {
      progress(onProgress, length, total);
      return length;
    }
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason;
        const { value, done } = await abortable(reader.read(), signal);
        if (signal?.aborted) throw signal.reason;
        if (done) break;
        if (value.byteLength === 0) {
          await waitForDeferredTimer(0, signal);
          continue;
        }
        length += value.byteLength;
        if (!Number.isSafeInteger(length) || length > maxBytes) {
          throw new Error(`Lazy response exceeds native byte bound ${maxBytes}`);
        }
        sink.write(value);
        progress(onProgress, length, total);
      }
      return length;
    } catch (error) {
      try { await abortable(reader.cancel(error), signal); } catch {}
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      try { reader.releaseLock(); } catch (error) {
        if (!signal?.aborted) throw error;
      }
    }
  }, signal);
}
