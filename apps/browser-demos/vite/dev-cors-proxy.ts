import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";

export const DEV_CORS_PROXY_MAX_REQUEST_BYTES = 1024 * 1024;
export const DEV_CORS_PROXY_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const GITHUB_ORIGIN = "https://github.com";
const GIT_UPLOAD_PACK_CONTENT_TYPE =
  "application/x-git-upload-pack-request";

export type DevCorsProxyFetch = (
  target: URL,
  init: RequestInit,
) => Promise<Response>;

// WHY: this local relay proves anonymous public Git and bottle transport.
// Forwarding credentials needs a separately reviewed host/proxy protocol;
// ambient browser Authorization must not become guest authority by accident.
const DISALLOWED_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "accept-language",
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "forwarded",
  "host",
  "keep-alive",
  "origin",
  "priority",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
  "x-cors-proxy-allowed-request-headers",
]);

const DISALLOWED_RESPONSE_HEADERS = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "authorization",
  "connection",
  "content-encoding",
  "content-length",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "keep-alive",
  "set-cookie",
  "set-cookie2",
  "strict-transport-security",
  "transfer-encoding",
  "upgrade-insecure-requests",
  "www-authenticate",
]);

class EntityTooLargeError extends Error {}

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Preserve ordinary guest protocol headers while removing browser-session,
 * reverse-proxy, and transport-owned state before contacting the target.
 */
export function devCorsProxyRequestHeaders(
  incoming: IncomingHttpHeaders,
): Headers {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(incoming) as Array<
    [string, string | string[] | undefined]
  >) {
    const lower = name.toLowerCase();
    if (
      DISALLOWED_REQUEST_HEADERS.has(lower) ||
      lower.startsWith("sec-") ||
      lower.startsWith("x-forwarded-")
    ) {
      continue;
    }
    const value = headerValue(rawValue);
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function copySafeResponseHeaders(
  upstream: Headers,
  response: ServerResponse,
): void {
  upstream.forEach((value, name) => {
    if (!DISALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) {
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

async function readResponseBody(response: Response): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > DEV_CORS_PROXY_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new EntityTooLargeError();
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks, total);
}

function fail(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(message);
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower === "localhost" || lower === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(lower);
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
    return isLoopbackHostname(targetUrl.hostname) &&
      isLoopbackHostname(incomingUrl.hostname) &&
      effectivePort(targetUrl) === effectivePort(incomingUrl);
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
  return targetUrl.origin === GITHUB_ORIGIN &&
    targetUrl.pathname.endsWith("/git-upload-pack") &&
    contentType === GIT_UPLOAD_PACK_CONTENT_TYPE;
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
 * protocol request with POST. A GET-only relay lets `brew tap` start but
 * always fails before Git can fetch any objects.
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

  try {
    const upstream = await fetchImpl(targetUrl, {
      method,
      headers: devCorsProxyRequestHeaders(request.headers),
      body: method === "POST" && requestBody.byteLength > 0
        ? Uint8Array.from(requestBody).buffer
        : undefined,
      credentials: "omit",
      // WHY: a public Git endpoint must not redirect this newly enabled POST
      // into a private-network target. Return the redirect to Git so its next
      // request crosses the same admission boundary again.
      redirect: method === "POST" ? "manual" : "follow",
    });
    const redirectLocation = upstream.headers.get("location");
    if (
      method === "POST" &&
      upstream.status >= 300 && upstream.status < 400 &&
      redirectLocation !== null
    ) {
      let redirectedUrl: URL;
      try {
        redirectedUrl = new URL(redirectLocation, targetUrl);
      } catch {
        await upstream.body?.cancel().catch(() => {});
        fail(response, 502, "Git endpoint returned an invalid redirect");
        return;
      }
      if (redirectedUrl.origin !== GITHUB_ORIGIN) {
        await upstream.body?.cancel().catch(() => {});
        fail(response, 502, "Git endpoint redirected outside GitHub");
        return;
      }
    }
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

    const bytes = await readResponseBody(upstream);
    response.statusCode = upstream.status;
    response.statusMessage = upstream.statusText;
    copySafeResponseHeaders(upstream.headers, response);
    response.setHeader("Content-Length", String(bytes.byteLength));
    response.end(Buffer.from(bytes));
  } catch (error) {
    if (error instanceof EntityTooLargeError) {
      fail(response, 413, "Response Entity Too Large");
      return;
    }
    fail(response, 502, "Bad Gateway");
  }
}
