/**
 * One HTTP byte-range read whose answer cannot be mistaken for another.
 *
 * WHY: HTTP lets any hop ignore `Range` and answer `200` with the whole
 * representation, and some relays do. The browser CORS proxy in production
 * drops `Range` today, so a ranged read through it comes back as the entire
 * entity starting at offset 0. A caller that checks only `response.ok` and
 * takes the first N bytes then returns the wrong bytes with no error — for a
 * ZIP tail read, silently corrupt metadata. This helper classifies the answer
 * once, so every caller has to handle the three real outcomes explicitly:
 *
 * - `partial`: a `206` whose `Content-Range` is exactly the range requested.
 * - `whole-entity`: a `200`. The server or a relay did not apply the range;
 *   the body is the complete representation from offset 0.
 * - `failed`: anything else, including a `206` for a different range.
 *
 * Transport failures (network errors, aborts) still reject, like `fetch()`.
 * The helper does not parse caller-supplied range syntax: callers describe
 * the range structurally and the helper writes the one header it validates.
 */

export type ByteRange =
  /** Bytes `start` through `end` inclusive, or through the end when omitted. */
  | { readonly start: number; readonly end?: number }
  /** The final `suffixLength` bytes of the representation. */
  | { readonly suffixLength: number };

export interface PartialByteRange {
  readonly kind: "partial";
  readonly response: Response;
  /** First byte position the server returned (always the requested start). */
  readonly start: number;
  /** Last byte position the server returned, inclusive. */
  readonly end: number;
  /** Complete representation length, when the server declared it. */
  readonly completeLength: number | undefined;
  /**
   * Read the body, rejecting unless it holds exactly `end - start + 1` bytes.
   */
  bytes(): Promise<Uint8Array>;
}

export interface WholeEntityInsteadOfRange {
  readonly kind: "whole-entity";
  /**
   * A `200` whose body is the entire representation from offset 0. It is
   * never the requested slice; index into it by absolute offset.
   */
  readonly response: Response;
}

export interface FailedByteRange {
  readonly kind: "failed";
  readonly status: number;
  readonly reason: string;
}

export type ByteRangeFetchResult =
  | PartialByteRange
  | WholeEntityInsteadOfRange
  | FailedByteRange;

export type ByteRangeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface ByteRangeFetchOptions {
  /** Defaults to the global `fetch`. Pass a proxy-aware fetch to relay. */
  readonly fetch?: ByteRangeFetch;
  /** Extra request fields. Must not carry `Range` or `If-Range`. */
  readonly headers?: HeadersInit;
  /** Entity tag or HTTP-date sent as `If-Range`. */
  readonly ifRange?: string;
  readonly signal?: AbortSignal;
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/** Format a structured range as a single-range `Range` header value. */
export function byteRangeHeaderValue(range: ByteRange): string {
  if ("suffixLength" in range) {
    assertPosition(range.suffixLength, "suffixLength");
    if (range.suffixLength === 0) {
      throw new RangeError("byte range suffixLength must be positive");
    }
    return `bytes=-${range.suffixLength}`;
  }
  assertPosition(range.start, "start");
  if (range.end === undefined) return `bytes=${range.start}-`;
  assertPosition(range.end, "end");
  if (range.end < range.start) {
    throw new RangeError("byte range end must not precede start");
  }
  return `bytes=${range.start}-${range.end}`;
}

export async function fetchByteRange(
  url: string,
  range: ByteRange,
  options: ByteRangeFetchOptions = {},
): Promise<ByteRangeFetchResult> {
  const headers = new Headers(options.headers);
  if (headers.has("range") || headers.has("if-range")) {
    throw new TypeError(
      "fetchByteRange owns Range and If-Range; pass the range structurally",
    );
  }
  headers.set("Range", byteRangeHeaderValue(range));
  if (options.ifRange !== undefined) headers.set("If-Range", options.ifRange);

  const fetchImpl = options.fetch ??
    ((input: string, init: RequestInit) => globalThis.fetch(input, init));
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: options.signal,
  });

  if (response.status === 200) {
    return { kind: "whole-entity", response };
  }
  if (response.status !== 206) {
    await discardBody(response);
    return {
      kind: "failed",
      status: response.status,
      reason: `ranged read answered ${response.status} ${response.statusText}`
        .trim(),
    };
  }

  const contentRange = response.headers.get("content-range");
  const match = contentRange === null
    ? null
    : CONTENT_RANGE.exec(contentRange.trim());
  if (match === null) {
    await discardBody(response);
    return {
      kind: "failed",
      status: 206,
      reason: contentRange === null
        ? "206 response has no single-part Content-Range"
        : `206 response has unusable Content-Range ${contentRange}`,
    };
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const completeLength = match[3] === "*" ? undefined : Number(match[3]);
  const mismatch = rangeMismatch(range, start, end, completeLength);
  if (mismatch !== undefined) {
    await discardBody(response);
    return {
      kind: "failed",
      status: 206,
      reason: `206 response Content-Range ${contentRange} ${mismatch}`,
    };
  }

  const expectedLength = end - start + 1;
  return {
    kind: "partial",
    response,
    start,
    end,
    completeLength,
    async bytes() {
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength !== expectedLength) {
        throw new Error(
          `206 response body holds ${body.byteLength} bytes but Content-Range ${contentRange} declares ${expectedLength}`,
        );
      }
      return body;
    },
  };
}

/**
 * Return why a well-formed Content-Range does not answer `range`.
 *
 * A bounded request must come back exactly (clamped to the representation
 * end). An open-ended request may come back shorter, because servers chunk
 * those, but must start where it asked. A suffix request must end at the
 * declared representation end.
 */
function rangeMismatch(
  range: ByteRange,
  start: number,
  end: number,
  completeLength: number | undefined,
): string | undefined {
  if (end < start) return "is inverted";
  if (completeLength !== undefined && end >= completeLength) {
    return "extends past the representation";
  }
  if ("suffixLength" in range) {
    if (completeLength === undefined) {
      return "does not declare the length a suffix range needs";
    }
    const expectedStart = Math.max(0, completeLength - range.suffixLength);
    return start === expectedStart && end === completeLength - 1
      ? undefined
      : `is not the final ${range.suffixLength} bytes`;
  }
  if (start !== range.start) return `does not start at ${range.start}`;
  if (range.end === undefined) return undefined;
  const expectedEnd = completeLength === undefined
    ? range.end
    : Math.min(range.end, completeLength - 1);
  return end === expectedEnd ? undefined : `does not end at ${expectedEnd}`;
}

function assertPosition(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`byte range ${name} must be a non-negative integer`);
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The classification is already decided; a failed cancel changes nothing.
  }
}
