import { once } from "node:events";
import { lookup } from "node:dns/promises";
import {
  createReadStream,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  createServer,
  request as makeHttpRequest,
} from "node:http";
import { request as makeHttpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { extname, resolve, sep } from "node:path";

const PROXY_PATH = "/__kandelo_cors_proxy";
const MAX_PROXY_REDIRECTS = 5;
const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 512 * 1024 * 1024;
const MAX_PROXY_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_FORWARDED_HEADER_BYTES = 8 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "authorization",
  "cache-control",
  "content-encoding",
  "content-type",
  "git-protocol",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "pragma",
  "range",
  "user-agent",
];
const CROSS_ORIGIN_REDIRECT_HEADERS = new Set([
  "accept",
  "cache-control",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "pragma",
  "range",
  "user-agent",
]);
const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-encoding",
  "content-disposition",
  "content-language",
  "content-range",
  "content-type",
  "docker-content-digest",
  "etag",
  "expires",
  "last-modified",
  "pragma",
  "www-authenticate",
];
const BLOCKED_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  BLOCKED_IPV4.addSubnet(network, prefix, "ipv4");
}
const BLOCKED_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
]) {
  BLOCKED_IPV6.addSubnet(network, prefix, "ipv6");
}

const options = parseArguments(process.argv.slice(2));
const rootStat = lstatSync(options.root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error("--root must be a regular non-symlink directory");
}
const root = realpathSync(options.root);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
  [".zst", "application/zstd"],
]);

const server = createServer(async (request, response) => {
  try {
    const requestTarget = request.url ?? "/";
    let rawPathname;
    try {
      rawPathname = decodeURIComponent(requestTarget.split("?", 1)[0]);
    } catch {
      respondText(response, 400, "invalid URL encoding\n");
      return;
    }
    if (
      rawPathname.includes("\0") ||
      rawPathname.includes("\\") ||
      rawPathname.split("/").some((part) => part === "..")
    ) {
      respondText(response, 400, "invalid path\n");
      return;
    }

    const url = new URL(requestTarget, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === PROXY_PATH) {
      // WHY: today's built browser asks this same-origin route to fetch public
      // bottle and Git bytes. Keep that compatibility seam in the sealed
      // proof server until the service worker owns cross-origin transport.
      await serveAnonymousProxy(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      respondText(response, 405, "method not allowed\n", {
        Allow: "GET, HEAD",
      });
      return;
    }
    serveStaticFile(request, response, pathname);
  } catch {
    respondText(response, 500, "sealed-dist server failed\n");
  }
});

server.listen(options.port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

function serveStaticFile(request, response, pathname) {
  let relative = pathname.replace(/^\/+/, "");
  if (relative === "" || relative.endsWith("/")) {
    relative += "index.html";
  }
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    respondText(response, 400, "invalid path\n");
    return;
  }

  let details;
  try {
    const canonicalCandidate = realpathSync(candidate);
    if (
      canonicalCandidate !== candidate ||
      (
        canonicalCandidate !== root &&
        !canonicalCandidate.startsWith(`${root}${sep}`)
      )
    ) {
      respondText(response, 404, "not found\n");
      return;
    }
    details = lstatSync(candidate);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      respondText(response, 404, "not found\n");
      return;
    }
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    respondText(response, 404, "not found\n");
    return;
  }

  response.writeHead(200, {
    ...isolationHeaders(),
    "Cache-Control": "no-store",
    "Content-Length": details.size,
    "Content-Type":
      contentTypes.get(extname(candidate).toLowerCase()) ??
      "application/octet-stream",
    "Service-Worker-Allowed": "/",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(candidate).pipe(response);
}

async function serveAnonymousProxy(request, response, requestUrl) {
  const method = request.method ?? "";
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    respondText(response, 405, "method not allowed\n", {
      Allow: "GET, HEAD, POST",
    });
    return;
  }
  const parameters = [...requestUrl.searchParams.entries()];
  if (
    parameters.length !== 1 ||
    parameters[0][0] !== "url" ||
    parameters[0][1] === ""
  ) {
    respondText(response, 400, "exactly one url is required\n");
    return;
  }

  let target;
  try {
    target = canonicalProxyTarget(parameters[0][1]);
  } catch {
    respondText(response, 400, "invalid proxy target\n");
    return;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("proxy timeout"));
  }, options.proxyTimeoutMs);
  timeout.unref();
  const abortForClient = () => {
    if (!response.writableEnded) {
      controller.abort(new Error("proxy client disconnected"));
    }
  };
  request.once("aborted", abortForClient);
  response.once("close", abortForClient);

  try {
    const headers = projectAnonymousRequestHeaders(request);
    const body = method === "POST"
      ? await readBoundedRequestBody(
        request,
        options.proxyMaxRequestBytes,
        controller.signal,
      )
      : rejectUnexpectedRequestBody(request);
    // WHY: stock Homebrew supplies the public GHCR credential `Bearer QQ==`.
    // Relay that guest-created header to the first target, but never copy
    // cookies, proxy credentials, referrers, or ambient host credentials.
    // Redirect handling below then removes Authorization after the first hop.
    const upstreamResult = await requestFollowingRedirects(
      target,
      { method, headers, body },
      controller.signal,
    );
    const upstream = upstreamResult.response;
    const status = upstream.statusCode ?? 502;
    const statusText = upstream.statusMessage ?? "";
    const hasNoResponseBody =
      upstreamResult.method === "HEAD" ||
      status === 204 ||
      status === 304;
    const declaredLength = parseUpstreamLength(
      upstreamHeader(upstream, "content-length"),
    );
    if (
      !hasNoResponseBody &&
      declaredLength !== undefined &&
      declaredLength > options.proxyMaxResponseBytes
    ) {
      upstream.destroy();
      respondText(response, 413, "proxy response is too large\n");
      return;
    }

    const responseHeaders = isolationHeaders();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstreamHeader(upstream, name);
      if (value !== undefined) responseHeaders[name] = value;
    }
    if (declaredLength !== undefined) {
      responseHeaders["content-length"] = String(declaredLength);
    }
    if (hasNoResponseBody) {
      upstream.destroy();
      response.writeHead(status, statusText, responseHeaders);
      response.end();
      return;
    }

    const iterator = upstream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (
      !first.done &&
      first.value.byteLength > options.proxyMaxResponseBytes
    ) {
      upstream.destroy();
      respondText(response, 413, "proxy response is too large\n");
      return;
    }

    response.writeHead(status, statusText, responseHeaders);
    let received = 0;
    if (!first.done) {
      received = first.value.byteLength;
      await writeWithBackpressure(response, first.value);
    }
    while (!first.done) {
      const next = await iterator.next();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > options.proxyMaxResponseBytes) {
        upstream.destroy();
        response.destroy(new Error("proxy response exceeded its byte bound"));
        return;
      }
      await writeWithBackpressure(response, next.value);
    }
    if (declaredLength !== undefined && received !== declaredLength) {
      response.destroy(new Error("upstream response length changed"));
      return;
    }
    response.end();
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = timedOut
      ? 504
      : error instanceof ProxyFailure
        ? error.status
        : 502;
    if (status === 413 || status === 504) request.resume();
    respondText(
      response,
      status,
      status === 504
        ? "proxy request timed out\n"
        : status === 413
          ? "proxy request or response is too large\n"
        : "upstream request failed\n",
    );
  } finally {
    clearTimeout(timeout);
    request.off("aborted", abortForClient);
    response.off("close", abortForClient);
  }
}

async function requestFollowingRedirects(target, requestPlan, signal) {
  let current = target;
  let currentPlan = requestPlan;
  for (let redirects = 0; ; redirects += 1) {
    const address = await resolveProxyAddress(current, signal);
    const upstream = await requestUpstream(
      current,
      address,
      currentPlan,
      signal,
    );
    const status = upstream.statusCode ?? 502;
    const location = upstreamHeader(upstream, "location");
    if (!REDIRECT_STATUSES.has(status) || location === undefined) {
      return { response: upstream, method: currentPlan.method };
    }
    upstream.destroy();
    if (redirects >= MAX_PROXY_REDIRECTS) {
      throw new ProxyFailure(502, "too many upstream redirects");
    }
    let next;
    try {
      next = canonicalProxyTarget(new URL(location, current).href);
    } catch {
      throw new ProxyFailure(502, "invalid upstream redirect");
    }
    const crossOrigin = next.origin !== current.origin;
    currentPlan = redirectRequestPlan(currentPlan, status, crossOrigin);
    current = next;
  }
}

function redirectRequestPlan(plan, status, crossOrigin) {
  let method = plan.method;
  let body = plan.body;
  let headers = { ...plan.headers };
  // Match curl/Homebrew: Authorization is never replayed after a redirect.
  delete headers.authorization;
  if (crossOrigin) {
    // WHY: a release redirect may change from github.com to GitHub's CDN.
    // Preserve selectors needed to resume and validate immutable downloads,
    // but do not leak origin-specific Git protocol state to the new host.
    headers = Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) => CROSS_ORIGIN_REDIRECT_HEADERS.has(name),
      ),
    );
    if (headers.accept === undefined) headers.accept = "*/*";
    if (body !== undefined) {
      for (const name of ["content-encoding", "content-type"]) {
        if (plan.headers[name] !== undefined) {
          headers[name] = plan.headers[name];
        }
      }
    }
  }
  if (
    status === 303 ||
    ((status === 301 || status === 302) && method === "POST")
  ) {
    method = "GET";
    body = undefined;
    delete headers["content-encoding"];
    delete headers["content-type"];
  }
  return { method, headers, body };
}

function projectAnonymousRequestHeaders(request) {
  const projected = {};
  let bytes = 0;
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      throw new ProxyFailure(431, "repeated request header");
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > MAX_FORWARDED_HEADER_BYTES) {
      throw new ProxyFailure(431, "request headers are too large");
    }
    projected[name] = value;
  }
  if (projected.accept === undefined) projected.accept = "*/*";
  return projected;
}

function rejectUnexpectedRequestBody(request) {
  const declared = parseRequestLength(request.headers["content-length"]);
  if (
    (declared !== undefined && declared !== 0) ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw new ProxyFailure(400, "GET or HEAD request has a body");
  }
  return undefined;
}

function readBoundedRequestBody(request, maximumBytes, signal) {
  const declared = parseRequestLength(request.headers["content-length"]);
  if (declared !== undefined && declared > maximumBytes) {
    throw new ProxyFailure(413, "request body is too large");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let received = 0;
    let finished = false;
    const settle = (action, value) => {
      if (finished) return;
      finished = true;
      request.off("aborted", rejectForAbortedRequest);
      request.off("data", receiveChunk);
      request.off("end", finishRequest);
      request.off("error", rejectForRequestError);
      signal.removeEventListener("abort", rejectForSignal);
      action(value);
    };
    const rejectForAbortedRequest = () => settle(
      rejectPromise,
      new ProxyFailure(400, "request body was aborted"),
    );
    const receiveChunk = (chunk) => {
      received += chunk.byteLength;
      if (received > maximumBytes) {
        request.pause();
        settle(
          rejectPromise,
          new ProxyFailure(413, "request body is too large"),
        );
        return;
      }
      chunks.push(chunk);
    };
    const finishRequest = () => {
      if (declared !== undefined && declared !== received) {
        settle(
          rejectPromise,
          new ProxyFailure(400, "request body length changed"),
        );
        return;
      }
      settle(resolvePromise, Buffer.concat(chunks, received));
    };
    const rejectForRequestError = (error) => {
      settle(rejectPromise, error);
    };
    const rejectForSignal = () => {
      request.pause();
      settle(rejectPromise, signal.reason);
    };
    request.once("aborted", rejectForAbortedRequest);
    request.on("data", receiveChunk);
    request.once("end", finishRequest);
    request.once("error", rejectForRequestError);
    signal.addEventListener("abort", rejectForSignal, { once: true });
    if (signal.aborted) rejectForSignal();
  });
}

function parseRequestLength(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ProxyFailure(400, "invalid request content length");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new ProxyFailure(400, "invalid request content length");
  }
  return length;
}

async function resolveProxyAddress(target, signal) {
  const hostname = target.hostname.startsWith("[")
    ? target.hostname.slice(1, -1)
    : target.hostname;
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    assertPermittedProxyAddress(hostname, literalFamily);
    return { address: hostname, family: literalFamily };
  }
  let addresses;
  try {
    addresses = await abortable(
      lookup(hostname, { all: true, verbatim: true }),
      signal,
    );
  } catch {
    throw new ProxyFailure(502, "proxy target DNS failed");
  }
  if (addresses.length === 0) {
    throw new ProxyFailure(502, "proxy target DNS returned no addresses");
  }
  for (const result of addresses) {
    assertPermittedProxyAddress(result.address, result.family);
  }
  return addresses[0];
}

function assertPermittedProxyAddress(address, family) {
  if (options.allowTestLoopbackProxy && isLoopbackAddress(address, family)) {
    return;
  }
  if (family === 4 && !BLOCKED_IPV4.check(address, "ipv4")) return;
  if (family === 6) {
    const firstHextet = Number.parseInt(address.split(":", 1)[0], 16);
    if (
      firstHextet >= 0x2000 &&
      firstHextet <= 0x3fff &&
      !BLOCKED_IPV6.check(address, "ipv6")
    ) {
      return;
    }
  }
  throw new ProxyFailure(403, "proxy target address is not public");
}

function isLoopbackAddress(address, family) {
  if (family === 4) {
    return address.startsWith("127.");
  }
  return family === 6 && address === "::1";
}

function requestUpstream(target, address, plan, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const makeRequest =
      target.protocol === "https:" ? makeHttpsRequest : makeHttpRequest;
    const headers = { ...plan.headers };
    if (plan.body !== undefined) {
      headers["content-length"] = String(plan.body.byteLength);
    }
    const upstreamRequest = makeRequest(
      target,
      {
        agent: false,
        headers,
        lookup: (_hostname, lookupOptions, callback) => {
          if (
            typeof lookupOptions === "object" &&
            lookupOptions !== null &&
            lookupOptions.all
          ) {
            callback(null, [address]);
          } else {
            callback(null, address.address, address.family);
          }
        },
        method: plan.method,
        signal,
      },
      resolvePromise,
    );
    upstreamRequest.once("error", rejectPromise);
    upstreamRequest.end(plan.body);
  });
}

function upstreamHeader(response, name) {
  const value = response.headers[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return value;
  if (
    (name === "content-length" || name === "location") &&
    value.length !== 1
  ) {
    throw new ProxyFailure(502, `ambiguous upstream ${name}`);
  }
  return value.join(", ");
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, rejectPromise) => {
    const rejectForAbort = () => rejectPromise(signal.reason);
    signal.addEventListener("abort", rejectForAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", rejectForAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", rejectForAbort);
        rejectPromise(error);
      },
    );
  });
}

function canonicalProxyTarget(value) {
  if (value.trim() !== value) {
    throw new Error("proxy target is not canonical");
  }
  const target = new URL(value);
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== "" ||
    target.href !== value
  ) {
    throw new Error("proxy target is not canonical");
  }
  if (!isPermittedProxyTarget(target)) {
    throw new Error("proxy target is outside the public proof host set");
  }
  return target;
}

function isPermittedProxyTarget(target) {
  if (options.allowTestLoopbackProxy) {
    const hostname = target.hostname.startsWith("[")
      ? target.hostname.slice(1, -1)
      : target.hostname;
    if (
      (target.protocol === "http:" || target.protocol === "https:") &&
      isLoopbackAddress(hostname, isIP(hostname))
    ) {
      return true;
    }
  }
  if (target.protocol !== "https:") return false;
  const hostname = target.hostname.toLowerCase();
  return hostname === "github.com" ||
    hostname === "ghcr.io" ||
    hostname.endsWith(".githubusercontent.com");
}

function parseUpstreamLength(value) {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ProxyFailure(502, "invalid upstream content length");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new ProxyFailure(502, "invalid upstream content length");
  }
  return length;
}

async function writeWithBackpressure(response, bytes) {
  if (!response.write(bytes)) {
    await once(response, "drain");
  }
}

function isolationHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

function parseArguments(arguments_) {
  let root;
  let port;
  let allowTestLoopbackProxy = false;
  let proxyMaxRequestBytes = MAX_PROXY_REQUEST_BYTES;
  let proxyMaxResponseBytes = MAX_PROXY_RESPONSE_BYTES;
  let proxyTimeoutMs = MAX_PROXY_TIMEOUT_MS;
  while (arguments_.length > 0) {
    const flag = arguments_.shift();
    if (flag === "--allow-test-loopback-proxy") {
      allowTestLoopbackProxy = true;
      continue;
    }
    const value = arguments_.shift();
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--root") root = value;
    else if (flag === "--port") port = Number(value);
    else if (flag === "--proxy-max-request-bytes") {
      proxyMaxRequestBytes = Number(value);
    } else if (flag === "--proxy-max-response-bytes") {
      proxyMaxResponseBytes = Number(value);
    } else if (flag === "--proxy-timeout-ms") {
      proxyTimeoutMs = Number(value);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (root === undefined) throw new Error("--root is required");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be a valid TCP port");
  }
  if (
    !Number.isSafeInteger(proxyMaxRequestBytes) ||
    proxyMaxRequestBytes < 1 ||
    proxyMaxRequestBytes > MAX_PROXY_REQUEST_BYTES
  ) {
    throw new Error("--proxy-max-request-bytes is invalid");
  }
  if (
    !Number.isSafeInteger(proxyMaxResponseBytes) ||
    proxyMaxResponseBytes < 1 ||
    proxyMaxResponseBytes > MAX_PROXY_RESPONSE_BYTES
  ) {
    throw new Error("--proxy-max-response-bytes is invalid");
  }
  if (
    !Number.isSafeInteger(proxyTimeoutMs) ||
    proxyTimeoutMs < 1 ||
    proxyTimeoutMs > MAX_PROXY_TIMEOUT_MS
  ) {
    throw new Error("--proxy-timeout-ms is invalid");
  }
  return {
    root,
    port,
    allowTestLoopbackProxy,
    proxyMaxRequestBytes,
    proxyMaxResponseBytes,
    proxyTimeoutMs,
  };
}

function respondText(response, status, text, additionalHeaders = {}) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    ...isolationHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    ...additionalHeaders,
  });
  response.end(text);
}

class ProxyFailure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
