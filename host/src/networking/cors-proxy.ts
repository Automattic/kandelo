/**
 * Shared browser CORS-proxy request policy.
 *
 * The proxy URL is deployment configuration, while the target URL and
 * request headers come from a guest process. Keep those trust boundaries
 * explicit: validate the configured transport, and derive proxy control
 * headers from the guest request rather than accepting guest-supplied proxy
 * instructions.
 */

export const CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER =
  "X-Cors-Proxy-Allowed-Request-Headers";

export function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower === "localhost" || lower === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(lower);
}

/**
 * Validate a CORS-proxy prefix at the BrowserKernel boundary.
 *
 * Empty values disable proxying. Enabled values must be absolute HTTPS URLs,
 * except for an HTTP loopback relay used during local development. User
 * information could leak deployment credentials to every target, and
 * fragments would hide the appended target from the proxy server, so both
 * are rejected.
 */
export function normalizeCorsProxyUrl(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError("corsProxyUrl must be an absolute HTTP(S) URL");
  }

  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TypeError("corsProxyUrl must be an absolute HTTP(S) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("corsProxyUrl must use the http: or https: scheme");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError(
      "corsProxyUrl must use https: unless the proxy is on loopback",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("corsProxyUrl must not contain a username or password");
  }
  if (parsed.hash !== "") {
    throw new TypeError("corsProxyUrl must not contain a URL fragment");
  }

  // Preserve the reviewed prefix exactly. In particular, a trailing bare `?`
  // means "append the raw target URL" to the WordPress Playground proxy.
  return trimmed;
}

export function corsProxyFetchUrl(
  corsProxyUrl: string,
  targetUrl: string,
): string {
  if (targetUrl.startsWith(corsProxyUrl)) return targetUrl;
  const proxiedTarget = corsProxyUrl.endsWith("?")
    ? targetUrl
    : encodeURIComponent(targetUrl);
  return `${corsProxyUrl}${proxiedTarget}`;
}

/**
 * Reserve the proxy opt-in header for host policy. A guest cannot ask the
 * proxy to forward arbitrary sensitive headers: Authorization is opted in
 * exactly when the guest itself supplied Authorization.
 */
export function applyCorsProxyRequestPolicy(
  headers: Headers,
  proxyEnabled: boolean,
): void {
  headers.delete(CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER);
  if (proxyEnabled && headers.has("authorization")) {
    headers.set(CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER, "authorization");
  }
}

const FETCH_MANAGED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Build the browser fetch for one decoded guest HTTP request.
 *
 * This is shared by the simple fetch backend and the TLS-terminating backend
 * so proxy routing, header policy, request bodies, and browser credentials
 * cannot drift between the two browser transports.
 */
export function prepareBrowserHttpFetch(options: {
  targetUrl: string;
  method: string;
  headers: Iterable<readonly [string, string]>;
  body: Uint8Array | null;
  corsProxyUrl?: string;
}): { url: string; init: RequestInit } {
  const corsProxyUrl = normalizeCorsProxyUrl(options.corsProxyUrl);
  const proxyEnabled = corsProxyUrl !== undefined;
  const url = corsProxyUrl
    ? corsProxyFetchUrl(corsProxyUrl, options.targetUrl)
    : options.targetUrl;

  const fetchHeaders = new Headers();
  for (const [key, value] of options.headers) {
    if (!FETCH_MANAGED_REQUEST_HEADERS.has(key.toLowerCase())) {
      fetchHeaders.set(key, value);
    }
  }
  applyCorsProxyRequestPolicy(fetchHeaders, proxyEnabled);

  const fetchBody: Uint8Array<ArrayBuffer> | undefined =
    options.body && options.body.length > 0
      ? new Uint8Array(options.body) as Uint8Array<ArrayBuffer>
      : undefined;

  return {
    url,
    init: {
      method: options.method,
      headers: fetchHeaders,
      body: options.method !== "GET" && options.method !== "HEAD"
        ? fetchBody
        : undefined,
      // Guest authentication is carried only by guest-supplied headers.
      // Browser cookies, HTTP authentication caches, and client TLS state
      // belong to the embedding page and must never enter the guest network.
      credentials: "omit",
      referrerPolicy: "no-referrer",
    },
  };
}
