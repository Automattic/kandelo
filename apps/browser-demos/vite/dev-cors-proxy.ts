import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { DEFAULT_BROWSER_CORS_PROXY_CONFIG } from "../lib/browser-cors-proxy";

export const DEV_CORS_PROXY_MAX_REQUEST_BYTES = 1024 * 1024;
// Bounds the bytes one relayed response actually carries. A ranged response
// carries only its slice, so a small read of a huge entity stays in bounds.
export const DEV_CORS_PROXY_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const GITHUB_ORIGIN = "https://github.com";
const GIT_UPLOAD_PACK_CONTENT_TYPE = "application/x-git-upload-pack-request";

export type DevCorsProxyFetch = (
  target: URL,
  init: RequestInit,
) => Promise<Response>;

// WHY: this local relay proves anonymous public Git and package transport.
// Forwarding credentials needs a separately reviewed host/proxy protocol;
// ambient browser Authorization must not become guest authority by accident.
const ALLOWED_REQUEST_HEADERS = new Set(
  DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowedRequestHeaderNames,
);

// WHY: the browser receives this relay response from Kandelo's own origin.
// Copying an arbitrary upstream header would therefore give an external host
// same-origin authority such as clearing storage, setting client hints, or
// changing connection policy. Keep this to inert payload/cache metadata.
// `content-range` qualifies: it only locates a 206 body within its entity.
const ALLOWED_RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "cache-control",
  "content-range",
  "content-type",
  "etag",
  "expires",
  "last-modified",
]);

class EntityTooLargeError extends Error {}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Preserve only inert cache/data, byte-range, and Git protocol headers.
 *
 * WHY: a denylist lets newly standardized browser or proxy authority cross
 * this boundary by default. New forwarded headers need an explicit review.
 */
export function devCorsProxyRequestHeaders(
  incoming: IncomingHttpHeaders,
): Headers {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(incoming) as Array<
    [string, string | string[] | undefined]
  >) {
    const lower = name.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(lower)) continue;
    const value = headerValue(rawValue);
    if (value !== undefined) headers.set(name, value);
  }
  if (headers.has("range")) {
    // WHY: byte offsets address one representation. A fetch that negotiated
    // a compressed one and decoded it would relay a 206 body that is not the
    // bytes its Content-Range names. Standard Fetch (browsers, Node's undici)
    // also appends this for a ranged request, so upstream may see the value
    // listed twice; that is the same field value. The relay states it itself
    // rather than depend on the injected fetch implementation.
    headers.set("accept-encoding", "identity");
  }
  return headers;
}

function copySafeResponseHeaders(
  upstream: Headers,
  response: ServerResponse,
): void {
  upstream.forEach((value, name) => {
    if (ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      response.setHeader(name, value);
    }
  });
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > DEV_CORS_PROXY_MAX_REQUEST_BYTES
  ) {
    return Promise.reject(new EntityTooLargeError());
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > DEV_CORS_PROXY_MAX_REQUEST_BYTES) {
        settled = true;
        chunks.length = 0;
        reject(new EntityTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    request.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function* boundedResponseBytes(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > DEV_CORS_PROXY_MAX_RESPONSE_BYTES) {
      throw new EntityTooLargeError();
    }
    yield chunk;
  }
}

/**
 * Stream the upstream body to the client without buffering it.
 *
 * WHY: the relay only moves bytes; holding a whole response in memory made
 * its size cap a memory cap. Streaming also lets a client disconnect reach
 * upstream: pipeline() cancels the source when the client response closes.
 */
async function streamResponseBody(
  upstream: Response,
  response: ServerResponse,
): Promise<void> {
  if (upstream.body === null) {
    response.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>),
    boundedResponseBytes,
    response,
  );
}

/**
 * Forward Content-Length only when it describes the bytes the client gets.
 *
 * Node's fetch decodes a Content-Encoding it negotiated, which leaves the
 * upstream length describing encoded bytes the relay never sends.
 */
function relayedContentLength(upstream: Response): string | undefined {
  const raw = upstream.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const encoding = upstream.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    return undefined;
  }
  return raw;
}

function fail(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(message);
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return (
    lower === "localhost" ||
    lower === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(lower)
  );
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

export function devCorsProxyTargetIsRecursive(
  targetUrl: URL,
  incomingHost: string | undefined,
): boolean {
  if (!incomingHost) return false;
  if (targetUrl.host.toLowerCase() === incomingHost.toLowerCase()) return true;

  try {
    const incomingUrl = new URL(`http://${incomingHost}`);
    return (
      isLoopbackHostname(targetUrl.hostname) &&
      isLoopbackHostname(incomingUrl.hostname) &&
      effectivePort(targetUrl) === effectivePort(incomingUrl)
    );
  } catch {
    return false;
  }
}

function isAllowedGitPost(
  targetUrl: URL,
  headers: IncomingHttpHeaders,
): boolean {
  const contentType = headerValue(headers["content-type"])
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return (
    targetUrl.origin === GITHUB_ORIGIN &&
    targetUrl.pathname.endsWith("/git-upload-pack") &&
    contentType === GIT_UPLOAD_PACK_CONTENT_TYPE
  );
}

/** Route one request when it targets Vite's private development relay. */
export async function handleDevCorsProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  proxyPath: string,
  fetchImpl: DevCorsProxyFetch = (target, init) => fetch(target, init),
): Promise<boolean> {
  if (request.url === undefined) return false;
  const requestUrl = new URL(request.url, "http://localhost");
  if (requestUrl.pathname !== proxyPath) return false;
  const target = requestUrl.searchParams.get("url");
  if (target === null || target === "") {
    fail(response, 400, "Missing url");
    return true;
  }
  await relayDevCorsProxyRequest(request, response, target, fetchImpl);
  return true;
}

/**
 * Relay one bounded request through Vite's same-origin development proxy.
 *
 * WHY: Git smart HTTP discovers a repository with GET, then transfers its
 * protocol request with POST. A GET-only relay lets guest Git start discovery
 * but always fails before it can fetch any objects.
 *
 * Byte-range reads pass through unchanged: `Range`/`If-Range` go upstream,
 * the upstream status (including `206`) and `Content-Range` come back, and
 * the body streams. The relay never interprets range syntax; a client must
 * still treat a `200` answer to a ranged request as the whole entity.
 */
export async function relayDevCorsProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
  fetchImpl: DevCorsProxyFetch = (fetchTarget, init) =>
    fetch(fetchTarget, init),
): Promise<void> {
  const method = request.method?.toUpperCase() ?? "";
  if (!ALLOWED_METHODS.has(method)) {
    fail(response, 405, "Method Not Allowed");
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    fail(response, 400, "Invalid target URL");
    return;
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    fail(response, 400, "Unsupported target URL scheme");
    return;
  }
  if (targetUrl.username !== "" || targetUrl.password !== "") {
    fail(response, 400, "Target URL must not contain credentials");
    return;
  }
  if (targetUrl.hash !== "") {
    fail(response, 400, "Target URL must not contain a fragment");
    return;
  }
  if (devCorsProxyTargetIsRecursive(targetUrl, request.headers.host)) {
    fail(response, 400, "Target URL must not point back to the proxy");
    return;
  }
  if (method === "POST" && !isAllowedGitPost(targetUrl, request.headers)) {
    // WHY: adding arbitrary POST would turn a localhost-only development
    // helper into state-changing authority over services reachable by Vite.
    // The current proof needs only anonymous GitHub upload-pack. New hosts or
    // protocols need an explicit reviewed transport boundary.
    fail(response, 403, "POST target is outside the Git upload-pack boundary");
    return;
  }

  let requestBody: Uint8Array;
  try {
    requestBody = await readRequestBody(request);
  } catch (error) {
    if (error instanceof EntityTooLargeError) {
      // Drain the rejected request so the local HTTP connection can close
      // promptly without retaining or forwarding any of the oversized body.
      request.resume();
      fail(response, 413, "Request Entity Too Large");
      return;
    }
    fail(response, 400, "Unable to read request body");
    return;
  }

  // WHY: a client that gives up (an aborted fetch, a closed tab) must not
  // leave the relay downloading on its behalf. Before the body streams this
  // signal cancels the upstream request; afterwards pipeline() does.
  const upstreamAbort = new AbortController();
  const abortUpstream = () => {
    if (!response.writableFinished) upstreamAbort.abort();
  };
  response.once("close", abortUpstream);

  try {
    const upstream = await fetchImpl(targetUrl, {
      method,
      headers: devCorsProxyRequestHeaders(request.headers),
      signal: upstreamAbort.signal,
      body:
        method === "POST" && requestBody.byteLength > 0
          ? Uint8Array.from(requestBody).buffer
          : undefined,
      credentials: "omit",
      // WHY: the browser's outer fetch follows Location by default and would
      // bypass this relay on its next hop. Observe redirects here so the relay
      // can reject them instead of granting unreviewed network authority.
      redirect: method === "POST" ? "manual" : "follow",
    });
    if (method === "POST" && upstream.status >= 300 && upstream.status < 400) {
      // Exact public repository URLs do not need a redirect. Refusing every POST
      // redirect is safer than exposing Location to the default-following
      // outer fetch, which would leave the same-origin relay entirely.
      await upstream.body?.cancel().catch(() => {});
      fail(response, 502, "Git upload-pack redirects are not supported");
      return;
    }
    // For a 206 this is the slice length, not the entity length, so a small
    // range of an entity larger than the cap is relayed.
    const rawDeclaredLength = upstream.headers.get("content-length");
    const declaredLength = Number(rawDeclaredLength ?? 0);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > DEV_CORS_PROXY_MAX_RESPONSE_BYTES
    ) {
      await upstream.body?.cancel().catch(() => {});
      fail(response, 413, "Response Entity Too Large");
      return;
    }

    if (method === "HEAD") {
      response.statusCode = upstream.status;
      response.statusMessage = upstream.statusText;
      copySafeResponseHeaders(upstream.headers, response);
      if (rawDeclaredLength !== null && /^\d+$/.test(rawDeclaredLength)) {
        response.setHeader("Content-Length", rawDeclaredLength);
      }
      response.end();
      return;
    }

    response.statusCode = upstream.status;
    response.statusMessage = upstream.statusText;
    copySafeResponseHeaders(upstream.headers, response);
    const contentLength = relayedContentLength(upstream);
    if (contentLength !== undefined) {
      response.setHeader("Content-Length", contentLength);
    }
    await streamResponseBody(upstream, response);
  } catch (error) {
    if (response.headersSent) {
      // The status line is already on the wire, so a late failure (an upstream
      // reset, or a body that outgrew an undeclared length past the cap) can
      // only be reported by cutting the response short. The client sees a
      // truncated transfer, never a complete-looking body.
      response.destroy();
      return;
    }
    if (upstreamAbort.signal.aborted) return;
    if (error instanceof EntityTooLargeError) {
      fail(response, 413, "Response Entity Too Large");
      return;
    }
    fail(response, 502, "Bad Gateway");
  } finally {
    response.off("close", abortUpstream);
  }
}
