/**
 * Retry a size-rejected public read against an origin that grants CORS itself.
 * Self-contained so the classic service worker uses this exact implementation.
 */
export async function anonymousGetFallback(
  response: Response,
  targetUrl: string,
  init: RequestInit,
  options: { allowDirectGetFallback?: boolean; rangeRequestHeaderAlias?: string },
  send: (url: string, init: RequestInit) => Promise<Response>,
): Promise<Response> {
  if (!options.allowDirectGetFallback || response.status !== 413 ||
      init.method !== "GET" || init.body != null) return response;
  const headers = new Headers(init.headers);
  // WHY: a relay's quota/session credential and browser cookies belong to
  // the relay/application, never the artifact origin. Authenticated requests
  // must retain their explicit route rather than being replayed directly.
  for (const name of ["authorization", "cookie", "cookie2", "proxy-authorization", "x-kandelo-proxy-session"]) {
    if (headers.has(name)) return response;
  }
  if (options.rangeRequestHeaderAlias) headers.delete(options.rangeRequestHeaderAlias);
  try {
    const direct = await send(targetUrl, {
      ...init, headers, mode: "cors", credentials: "omit", referrerPolicy: "no-referrer",
    });
    if (direct.ok && direct.type !== "opaque" && direct.type !== "opaqueredirect") {
      await response.body?.cancel().catch(() => {});
      return direct;
    }
    await direct.body?.cancel().catch(() => {});
  } catch {
    // A CORS-less origin still needs the relay. Keep its original error,
    // while caller cancellation remains an abort rather than a size error.
    init.signal?.throwIfAborted();
  }
  return response;
}
