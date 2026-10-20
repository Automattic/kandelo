/** Exact serialized HTTP(S) origins; an explicit empty list denies everyone. */
export function parseApprovedRefererOrigins(value: string): string[] {
  if (value.length > 8192) throw new Error("Referer origin configuration exceeds 8 KiB");
  return [...new Set(value.trim().split(/\s+/).filter(Boolean).map(origin => {
    const url = new URL(origin);
    if (origin.includes("*") || !/^https?:$/.test(url.protocol) || origin !== url.origin) {
      throw new Error("Expected an exact HTTP(S) Referer origin without a path or wildcard");
    }
    return origin;
  }))];
}

/** Browser-use restriction, not authentication: non-browser clients can forge headers. */
export function hasApprovedReferer(request: Request, approved: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  let refererOrigin: string | null = null;
  if (referer !== null) {
    try {
      const url = new URL(referer);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) return false;
      refererOrigin = url.origin;
    } catch { return false; }
  }
  if (origin !== null && !approved.includes(origin)) return false;
  // Browsers may omit Referer on preflight. Authorize that bodyless request
  // using Origin; the subsequent upstream request must still pass Referer.
  if (request.method === "OPTIONS") {
    return origin !== null && (referer === null || refererOrigin === origin);
  }
  return refererOrigin !== null && approved.includes(refererOrigin)
    && (origin === null || origin === refererOrigin);
}
