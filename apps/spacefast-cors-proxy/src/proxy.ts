import { validateTarget } from "./network-policy.ts";
import { createPinnedFetch } from "./pinned-fetch.ts";
import type { ProxyDatabase } from "./rate-limit.ts";

/**
 * Playground-compatible HTTP relay for Spacefast Functions.
 * See ../README.md for the upstream revision and the DNS/Fetch boundaries.
 */
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
const METHODS = "GET, HEAD, POST, OPTIONS";
const REQUEST_HEADERS = "Accept, Authorization, Content-Type, git-protocol, Range, wp_blog, wp_install, X-Cors-Proxy-Allowed-Request-Headers, X-Cors-Proxy-Content-Type, X-Cors-Proxy-Range";
const EXPOSE_HEADERS = "X-Playground-Cors-Proxy, Content-Range, Accept-Ranges, ETag, Content-Length, Last-Modified, Date";

export type OriginRule =
  | { type: "match-exact"; origin: string }
  | { type: "match-subdomain"; scheme: "http" | "https"; host: string; port: number | null };

export interface ProxyEnvironment {
  DB?: ProxyDatabase;
  CUSTOM_SUPPORTED_ORIGINS_SPACE_SEPARATED?: string;
  CORS_PROXY_DISABLE_RATE_LIMIT?: string;
}

export interface ProxyOptions {
  env?: ProxyEnvironment;
  fetch?: (url: string, init: RequestInit & { duplex: "half" }) => Promise<Response>;
  originRules?: readonly OriginRule[];
  // Native Node/browser fetch decodes bodies; our pinned socket transport
  // preserves the wire representation, including opaque compression.
  upstreamBodyEncoding?: "raw" | "decoded";
  // Return a response to deny admission, or void to admit. A thrown error
  // fails closed. Supply a durable deployment-owned limiter, not isolate state.
  rateLimit?: (request: Request) => Promise<Response | void>;
  disableRateLimit?: boolean;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** Server-side diagnostics; never include transport failures in responses. */
  onUpstreamError?: (error: unknown) => void;
}

const DEFAULT_ORIGINS = [
  "https://playground-preview.test", "https://playground.wordpress.net",
  "http://localhost", "http://127.0.0.1",
  ...[5400, 5401, 4400].flatMap(port => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]),
].map(origin => ({ type: "match-exact", origin }) as const);

function parseOrigin(origin: string): URL | undefined {
  try {
    const url = new URL(origin);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || origin.endsWith("/") || origin.includes("*")) return;
    return url;
  } catch {
    return;
  }
}

export function matchesOrigin(origin: string, rules: readonly OriginRule[]): boolean {
  const url = parseOrigin(origin);
  if (!url) return false;
  return rules.some(rule => {
    if (rule.type === "match-exact") return origin === rule.origin;
    const suffix = `.${rule.host}`.toLowerCase();
    const label = url.hostname.slice(0, -suffix.length);
    const port = rule.port === null ? "" : `:${rule.port}`;
    return label.length > 0 && !label.includes(".") &&
      origin.toLowerCase() === `${rule.scheme}://${label}${suffix}${port}`.toLowerCase();
  });
}

function configuredOrigins(value: string): OriginRule[] {
  return value.trim().split(/\s+/).filter(Boolean).map(origin => {
    if (origin.includes("*")) {
      const concrete = origin.replace("://*.", "://preview.");
      const url = parseOrigin(concrete);
      if (!url || !origin.includes("://*.") || origin.split("*").length !== 2) throw new Error("Invalid origin configuration");
      return { type: "match-subdomain", scheme: url.protocol.slice(0, -1) as "http" | "https",
        host: url.hostname.slice("preview.".length), port: url.port ? Number(url.port) : null };
    }
    if (!parseOrigin(origin)) throw new Error("Invalid origin configuration");
    return { type: "match-exact", origin };
  });
}

const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"];
const REQUEST_DENY = new Set([...HOP_HEADERS, "host", "cookie", "cookie2", "content-length",
  "x-cors-proxy-allowed-request-headers", "x-cors-proxy-content-type", "x-cors-proxy-range"]);
const RESPONSE_DENY = new Set([...HOP_HEADERS, "set-cookie", "set-cookie2", "authorization",
  "www-authenticate", "cache-control", "strict-transport-security", "upgrade-insecure-requests",
  "clear-site-data", "content-security-policy", "content-security-policy-report-only",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "x-sendfile", "x-sendfile-temporary", "x-sendfile2", "x-lighttpd-send-file",
  "surrogate-control", "edge-control", "status"]);

function connectionHeaders(headers: Headers): Set<string> {
  return new Set((headers.get("connection") ?? "").toLowerCase().split(",").map(name => name.trim()));
}

function requestHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  const nominated = connectionHeaders(incoming);
  const optIn = (incoming.get("x-cors-proxy-allowed-request-headers") ?? "").toLowerCase().split(",").map(name => name.trim());
  incoming.forEach((value, name) => {
    if (!REQUEST_DENY.has(name) && !nominated.has(name) &&
        (name !== "authorization" || optIn.includes(name))) headers.set(name, value);
  });
  const contentType = incoming.get("x-cors-proxy-content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  const alias = incoming.get("x-cors-proxy-range")?.trim();
  const range = headers.get("range")?.trim();
  if (alias) {
    if (range && range !== alias) throw new Error("Range and X-Cors-Proxy-Range disagree");
    headers.set("range", alias);
  }
  return headers;
}

function targetAndPrefix(proxy: URL): { target: string; prefix: string } {
  const pathOffset = proxy.pathname.indexOf("/http");
  if (pathOffset >= 0) {
    return { target: proxy.pathname.slice(pathOffset + 1) + proxy.search,
      prefix: proxy.origin + proxy.pathname.slice(0, pathOffset + 1) };
  }
  if (proxy.search.startsWith("?url=")) {
    if ([...proxy.searchParams.keys()].length !== 1) throw new Error("Expected exactly one url parameter");
    return { target: proxy.searchParams.get("url")!, prefix: `${proxy.origin}${proxy.pathname}?url=` };
  }
  return { target: proxy.search.slice(1), prefix: `${proxy.origin}${proxy.pathname}?` };
}

class SizeLimitError extends Error {}

/** Pull one upstream chunk at a time; cancellation reaches the owning fetch. */
function boundedBody(body: ReadableStream<Uint8Array>, limit: number,
  abort: AbortController, cleanup?: () => void, exceeded?: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { cleanup?.(); controller.close(); return; }
        bytes += next.value.byteLength;
        if (bytes >= limit) { exceeded?.(); throw new SizeLimitError("Body too large"); }
        controller.enqueue(next.value);
      } catch (error) {
        cleanup?.(); abort.abort(error);
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      cleanup?.(); abort.abort(reason);
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

export function createCorsProxy(options: ProxyOptions = {}): (request: Request) => Promise<Response> {
  const env = options.env ?? {};
  const upstreamFetch = options.fetch ?? createPinnedFetch();
  const requestLimit = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
  const responseLimit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const disableRateLimit = options.disableRateLimit ?? ["1", "true"].includes(env.CORS_PROXY_DISABLE_RATE_LIMIT ?? "");

  return async request => {
    const proxy = new URL(request.url);
    const headers = new Headers({ "cache-control": "no-store", "x-playground-cors-proxy": "true",
      "cross-origin-resource-policy": "cross-origin", "vary": "Origin" });
    const error = (status: number, message: string) => new Response(request.method === "HEAD" ? null : message,
      { status, headers });
    let rules: readonly OriginRule[];
    try {
      rules = options.originRules ?? (env.CUSTOM_SUPPORTED_ORIGINS_SPACE_SEPARATED === undefined
        ? DEFAULT_ORIGINS : configuredOrigins(env.CUSTOM_SUPPORTED_ORIGINS_SPACE_SEPARATED));
    } catch { return error(503, "Invalid origin configuration"); }
    const origin = request.headers.get("origin");
    if (origin && (origin === proxy.origin || matchesOrigin(origin, rules))) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-credentials", "true");
      headers.set("access-control-allow-methods", METHODS);
      headers.set("access-control-allow-headers", REQUEST_HEADERS);
      headers.set("access-control-expose-headers", EXPOSE_HEADERS);
    }
    if (request.method === "OPTIONS") {
      headers.set("allow", METHODS);
      return new Response(null, { status: 204, headers });
    }
    if (!["GET", "HEAD", "POST"].includes(request.method)) {
      headers.set("allow", METHODS);
      return error(405, "Method Not Allowed");
    }
    if (options.rateLimit) {
      try {
        const denied = await options.rateLimit(request);
        if (denied) {
          headers.forEach((value, name) => denied.headers.set(name, value));
          return denied;
        }
      } catch { return error(503, "Rate limiter unavailable"); }
    } else if (!disableRateLimit) return error(503, "Server needs to configure rate-limiting");
    let target: URL;
    let prefix: string;
    let forwarded: Headers;
    try {
      const parsed = targetAndPrefix(proxy);
      prefix = parsed.prefix;
      if (!parsed.target) return error(400, "Bad Request\n\nNo URL provided");
      target = validateTarget(parsed.target, proxy);
      forwarded = requestHeaders(request.headers);
    } catch (cause) { return error(400, `Bad Request\n\n${(cause as Error).message}`); }
    // Ask for the unencoded representation so range offsets and HEAD sizes
    // agree. Full responses may still carry opaque compressed bytes.
    forwarded.set("accept-encoding", "identity");
    const declaredRequest = request.headers.get("content-length");
    if (request.method === "POST" && declaredRequest !== null && Number(declaredRequest) >= requestLimit) return error(413, "Request Entity Too Large");
    const abort = new AbortController();
    const onAbort = () => abort.abort(request.signal.reason);
    request.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => request.signal.removeEventListener("abort", onAbort);
    if (request.signal.aborted) { cleanup(); return error(499, "Client Closed Request"); }
    let requestExceeded = false;
    let upstream: Response | undefined;
    try {
      const body = request.method === "POST" && request.body
        ? boundedBody(request.body, requestLimit, abort, undefined, () => { requestExceeded = true; }) : undefined;
      upstream = await upstreamFetch(target.href, { method: request.method, headers: forwarded,
        body, redirect: "manual", signal: abort.signal, cache: "no-store", duplex: "half" });
      const rejectUpstream = async (status: number, message: string) => {
        cleanup(); abort.abort();
        await upstream!.body?.cancel().catch(() => {});
        return error(status, message);
      };
      if (requestExceeded) return rejectUpstream(413, "Request Entity Too Large");
      const encoding = upstream.headers.get("content-encoding");
      const encoded = encoding !== null && encoding.toLowerCase() !== "identity";
      if ((request.method === "HEAD" || upstream.status === 206) && encoded) return rejectUpstream(502, "Bad Gateway: encoded range or HEAD response");
      const decoded = encoded && options.upstreamBodyEncoding === "decoded";
      const length = upstream.headers.get("content-length");
      if (request.method !== "HEAD" && length !== null && Number(length) >= responseLimit) return rejectUpstream(413, "Response Too Large");
      const nominated = connectionHeaders(upstream.headers);
      upstream.headers.forEach((value, name) => {
        if (RESPONSE_DENY.has(name) || nominated.has(name) || name.startsWith("access-control-") ||
            name.startsWith("x-accel-") || name.startsWith("x-litespeed-") ||
            name.startsWith("x-spacefast-") || name.startsWith("x-stattic-") ||
            name === "cdn-cache-control" || name.endsWith("-cdn-cache-control") ||
            name === "x-playground-cors-proxy" || name === "vary" || (name === "content-encoding" && decoded)) return;
        // Fetch has decoded encoded payloads; transport framing and its old
        // Content-Length must not describe the bytes we actually return.
        if (name === "content-length" && (decoded || upstream!.headers.has("transfer-encoding") || !/^\d+$/.test(value))) return;
        if (name === "location") {
          const destination = validateTarget(new URL(value, target).href, proxy);
          headers.set(name, prefix + (prefix.endsWith("?url=") ? encodeURIComponent(destination.href) : destination.href));
        } else headers.set(name, value);
      });
      if (request.method === "HEAD" || upstream.body === null) {
        cleanup(); await upstream.body?.cancel();
        return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
      }
      return new Response(boundedBody(upstream.body, responseLimit, abort, cleanup),
        { status: upstream.status, statusText: upstream.statusText, headers, encodeBody: "manual" } as ResponseInit);
    } catch (cause) {
      cleanup(); abort.abort();
      await upstream?.body?.cancel().catch(() => {});
      // A logging sink must not replace the proxy's failure or its cleanup.
      try { options.onUpstreamError?.(cause); } catch { /* best-effort diagnostic */ }
      // An error gets only proxy-owned headers, including CORS, never a
      // partially copied target Location/cache/authority header.
      for (const name of [...headers.keys()]) {
        if (!["cache-control", "x-playground-cors-proxy", "cross-origin-resource-policy", "vary"].includes(name) && !name.startsWith("access-control-")) headers.delete(name);
      }
      return error(requestExceeded ? 413 : request.signal.aborted ? 499 : 502,
        requestExceeded ? "Request Entity Too Large" : "Bad Gateway");
    }
  };
}
