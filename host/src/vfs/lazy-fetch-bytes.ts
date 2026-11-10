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

/** A transfer ends as ETIMEDOUT after this long without a received body byte. */
export const LAZY_TRANSFER_IDLE_TIMEOUT_MS = 30_000;

/**
 * Ceiling on a transport's {@link LazyPrepare} step.
 *
 * WHY separate from the idle timeout: preparation is local work that moves no
 * bytes, so "no progress" says nothing about whether it is healthy. On Node it
 * resolves every repository-served asset in the image in one batch, which can
 * regenerate the program index and compile its checker. That has outlasted
 * {@link LAZY_TRANSFER_IDLE_TIMEOUT_MS} on large images. This deadline exists
 * only so a wedged preparation fails as ETIMEDOUT instead of hanging a read.
 */
export const LAZY_PREPARATION_TIMEOUT_MS = 10 * 60_000;

/**
 * Local work a transport must finish before it can fetch an address, such as
 * resolving a repository path. It is not a transfer: the transfer idle
 * timeout starts only after it settles, and it runs once, outside the retry
 * policy.
 */
export type LazyPrepare = (address: string, signal: AbortSignal) => Promise<void>;

/**
 * The timing of one lazy fetch. Every deferred fetch passes through
 * {@link withLazyResponse}, so these deadlines are the only ones a fetch in
 * flight is subject to. Callers that see EAGAIN wait for it to settle rather
 * than keep a clock of their own.
 */
export interface LazyTransferOptions {
  /** A kernel integrity refusal must bypass the rejected HTTP cache entry. */
  cache?: RequestCache;
  prepare?: LazyPrepare;
  /** Cancels the fetch for its owner (for example, a closing spool). */
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  preparationTimeoutMs?: number;
}

interface LazyTransfer {
  readonly signal: AbortSignal;
  /** Received body bytes: restart the idle deadline. */
  progressed(): void;
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { name: "TimeoutError", code: "ETIMEDOUT" });
}

/** Read with the native image's declared transfer bound before retaining chunks.
 * This protects the worker's memory; Rust still verifies size and digest before
 * materializing a file. A stream bound failure is permanent, never retryable.
 */
async function readBoundedResponse(
  response: Response,
  maxBytes: number | undefined,
  sink: { reset(): void; write(bytes: Uint8Array): void },
  onProgress: DeferredByteProgress | undefined,
  transfer: LazyTransfer,
): Promise<number> {
  const { signal } = transfer;
  sink.reset();
  const header = response.headers.get("content-length");
  const advertised = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : undefined;
  if (maxBytes !== undefined && advertised !== undefined && advertised > maxBytes) {
    throw new Error(`Lazy response exceeds native byte bound ${maxBytes}`);
  }
  const total = advertised !== undefined && Number.isSafeInteger(advertised) ? advertised : maxBytes;
  let length = 0;
  if (response.body === null) {
    progress(onProgress, length, total);
    return length;
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await abortable(reader.read(), signal);
      if (signal.aborted) throw signal.reason;
      if (done) break;
      if (value.byteLength === 0) {
        await waitForDeferredTimer(0, signal);
        continue;
      }
      length += value.byteLength;
      if (!Number.isSafeInteger(length) || (maxBytes !== undefined && length > maxBytes)) {
        throw new Error(`Lazy response exceeds native byte bound ${maxBytes}`);
      }
      sink.write(value);
      transfer.progressed();
      progress(onProgress, length, total);
    }
    return length;
  } catch (error) {
    try { await abortable(reader.cancel(error), signal); } catch {}
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

/** Main's bounded transport policy, shared by Node and browser native rootfs.
 * Only transient transport errors retry. The kernel verifies the returned
 * bytes' length/digest and never asks this transport to retry integrity errors.
 *
 * The fetch runs in two phases with their own deadlines: preparation under
 * {@link LAZY_PREPARATION_TIMEOUT_MS}, then the transfer (request, retries,
 * and body) under the idle timeout, which only received body bytes renew.
 * Both deadlines abort through `abortable`, so a fetcher or preparation that
 * ignores its signal still cannot keep the fetch in flight.
 */
async function withLazyResponse<Result>(
  fetcher: LazyFetch,
  url: string,
  maxBytes: number | undefined,
  consume: (response: Response, transfer: LazyTransfer) => Promise<Result>,
  options: LazyTransferOptions = {},
): Promise<Result> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error("Invalid native lazy resource byte bound");
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? LAZY_TRANSFER_IDLE_TIMEOUT_MS;
  const preparationTimeoutMs = options.preparationTimeoutMs ?? LAZY_PREPARATION_TIMEOUT_MS;
  const controller = new AbortController();
  const signal = controller.signal;
  const owner = options.signal;
  const forward = () => controller.abort(owner!.reason);
  owner?.addEventListener("abort", forward, { once: true });
  if (owner?.aborted) forward();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expireAfter = (ms: number, message: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(timeoutError(message)), ms);
  };
  const transfer: LazyTransfer = {
    signal,
    progressed: () => expireAfter(idleTimeoutMs, `Deferred byte transfer made no progress for ${idleTimeoutMs}ms`),
  };
  try {
    const prepare = options.prepare;
    if (prepare !== undefined) {
      expireAfter(preparationTimeoutMs, `Lazy transport preparation for ${url} did not finish within ${preparationTimeoutMs}ms`);
      if (signal.aborted) throw signal.reason;
      await abortable(Promise.resolve().then(() => prepare(url, signal)), signal);
    }
    transfer.progressed();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let response: Response | undefined;
      try {
        if (signal.aborted) throw signal.reason;
        response = await abortable(
          fetcher(url, { signal, ...(options.cache === undefined ? {} : { cache: options.cache }) }),
          signal,
          value => discardResponse(value, signal.reason),
        );
        if (!response.ok) throw new HttpFailure(response.status, response.headers.get("retry-after"), url);
        return await consume(response, transfer);
      } catch (error) {
        // Discard each failed response before retrying. Cleanup cannot change
        // whether the original failure is transient or turn abort into retry.
        try {
          await abortable(Promise.resolve().then(() => response?.body?.cancel(error)), signal);
        } catch { /* already consumed or aborted */ }
        if (signal.aborted) throw signal.reason;
        const delay = attempt + 1 < MAX_ATTEMPTS ? retryDelay(error, attempt) : null;
        if (delay === null) throw error;
        await waitForDeferredTimer(delay, signal);
      }
    }
    throw new Error("Lazy transport retry state became unreachable");
  } finally {
    clearTimeout(timer);
    owner?.removeEventListener("abort", forward);
  }
}

export async function fetchLazyResourceBytes(
  fetcher: LazyFetch,
  url: string,
  maxBytes?: number,
  onProgress?: DeferredByteProgress,
  options?: LazyTransferOptions,
): Promise<Uint8Array> {
  let chunks: Uint8Array[] = [];
  const length = await withLazyResponse(fetcher, url, maxBytes, (response, transfer) =>
    readBoundedResponse(response, maxBytes, {
      reset: () => { chunks = []; },
      write: (bytes) => { chunks.push(bytes); },
    }, onProgress, transfer), options);
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

export async function streamLazyResourceBytes(
  fetcher: LazyFetch,
  url: string,
  maxBytes: number,
  sink: { reset(): void; write(bytes: Uint8Array): void },
  onProgress?: DeferredByteProgress,
  options?: LazyTransferOptions,
): Promise<number> {
  return withLazyResponse(fetcher, url, maxBytes, (response, transfer) =>
    readBoundedResponse(response, maxBytes, sink, onProgress, transfer), options);
}
