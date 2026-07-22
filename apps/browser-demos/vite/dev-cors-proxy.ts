import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import {
  CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER,
  isLoopbackHostname,
} from "../../../host/src/networking/cors-proxy";

const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
const AUTHORIZATION_OPT_IN_HEADER =
  CORS_PROXY_AUTHORIZATION_OPT_IN_HEADER.toLowerCase();
const ALLOWED_METHODS = new Set(["GET", "POST"]);

const DISALLOWED_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "accept-language",
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
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
  AUTHORIZATION_OPT_IN_HEADER,
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

class RequestTooLargeError extends Error {}

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

function authorizationWasOptedIn(headers: IncomingHttpHeaders): boolean {
  const value = headerValue(headers[AUTHORIZATION_OPT_IN_HEADER]);
  return value?.split(",").some((name) =>
    name.trim().toLowerCase() === "authorization"
  ) ?? false;
}

/**
 * Forward headers supplied by the guest while dropping browser/session and
 * reverse-proxy context. Authorization is accepted only through the explicit
 * opt-in derived by the shared browser HTTP backend policy.
 */
export function devCorsProxyRequestHeaders(
  incoming: IncomingHttpHeaders,
): Headers {
  const headers = new Headers();
  const allowAuthorization = authorizationWasOptedIn(incoming);

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
    if (lower === "authorization" && !allowAuthorization) continue;

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
    const lower = name.toLowerCase();
    if (DISALLOWED_RESPONSE_HEADERS.has(lower)) return;
    response.setHeader(name, value);
  });
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return Promise.reject(new RequestTooLargeError());
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;

    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        settled = true;
        reject(new RequestTooLargeError());
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

function fail(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(message);
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

/**
 * Relay one request through Vite's same-origin development proxy. This is the
 * local counterpart of the production WordPress Playground CORS proxy.
 */
export async function relayDevCorsProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
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

  let requestBody: Uint8Array;
  try {
    requestBody = await readRequestBody(request);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      fail(response, 413, "Request Entity Too Large");
      return;
    }
    fail(response, 400, "Unable to read request body");
    return;
  }

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: devCorsProxyRequestHeaders(request.headers),
      body: method === "GET" || requestBody.byteLength === 0
        ? undefined
        : Uint8Array.from(requestBody).buffer,
      credentials: "omit",
      redirect: "follow",
    });
    const declaredResponseLength = Number(
      upstream.headers.get("content-length") ?? 0,
    );
    if (
      Number.isFinite(declaredResponseLength) &&
      declaredResponseLength > MAX_RESPONSE_BYTES
    ) {
      fail(response, 413, "Response Entity Too Large");
      return;
    }

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      fail(response, 413, "Response Entity Too Large");
      return;
    }

    response.statusCode = upstream.status;
    response.statusMessage = upstream.statusText;
    copySafeResponseHeaders(upstream.headers, response);
    response.setHeader("Content-Length", String(bytes.byteLength));
    response.end(Buffer.from(bytes));
  } catch {
    fail(response, 502, "Bad Gateway");
  }
}
