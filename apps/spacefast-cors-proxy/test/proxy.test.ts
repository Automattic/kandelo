import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import handler from "../handler.ts";
import { createCorsProxy, matchesOrigin, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
  type ProxyOptions, type OriginRule } from "../src/proxy.ts";

const PROXY = "https://proxy.example";
const TARGET = "https://public.example/path?one=1&two=a%2Bb";
function request(target = TARGET, init: RequestInit = {}): Request {
  return new Request(`${PROXY}/?url=${encodeURIComponent(target)}`, init);
}
function relay(options: ProxyOptions = {}) {
  return createCorsProxy({ disableRateLimit: true, upstreamBodyEncoding: "decoded",
    fetch: async () => new Response("ok"), ...options });
}
async function outcome(request: Request, options: ProxyOptions = {}) {
  const response = await relay(options)(request);
  const body = await response.text();
  return { response, body };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("default limits equal Playground's constants", () => {
  assert.equal(MAX_REQUEST_BYTES, 1_048_576);
  assert.equal(MAX_RESPONSE_BYTES, 104_857_600);
});

test("standalone Spacefast handler uses env and the runtime fetch", async t => {
  const calls: unknown[] = [];
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  t.mock.method(globalThis, "fetch", async (...args: unknown[]) => {
    calls.push(args); return Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] });
  });
  const disabled = await handler.fetch(request(), {});
  assert.equal(disabled.status, 503);
  for (const value of ["1", "true"]) {
    const result = await handler.fetch(request(), { CORS_PROXY_DISABLE_RATE_LIMIT: value });
    assert.equal(result.status, 502);
    assert.equal(await result.text(), "Bad Gateway");
  }
  assert.equal(calls.length, 4);
  assert.equal(errors.length, 2);
  const defaultOptions = await createCorsProxy()(request());
  assert.equal(defaultOptions.status, 503);
});

test("upstream failures can be diagnosed without exposing their details to clients", async () => {
  const failure = new Error("fixture transport failure");
  const errors: unknown[] = [];
  const { response, body } = await outcome(request(), {
    fetch: async () => { throw failure; }, onUpstreamError: error => errors.push(error),
  });
  assert.equal(response.status, 502);
  assert.equal(body, "Bad Gateway");
  assert.deepEqual(errors, [failure]);
  const brokenLog = await outcome(request(), {
    fetch: async () => { throw failure; }, onUpstreamError: () => { throw new Error("logging failed"); },
  });
  assert.equal(brokenLog.response.status, 502);
  assert.equal(brokenLog.body, "Bad Gateway");
});

test("unconfigured and failing rate limiters fail closed", async () => {
  for (const options of [{ disableRateLimit: false },
    { disableRateLimit: false, rateLimit: async () => { throw new Error("down"); } },
    { disableRateLimit: false, env: { CORS_PROXY_DISABLE_RATE_LIMIT: "false" } }]) {
    const { response, body } = await outcome(request(TARGET, { headers: { Origin: "https://playground.wordpress.net" } }), options);
    assert.equal(response.status, 503);
    assert.match(body, /rate.limit/i);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://playground.wordpress.net");
  }
});

test("rate limiter denies with its status and Retry-After, or admits", async () => {
  const denied = await outcome(request(), {
    rateLimit: async () => new Response("slow down", { status: 429, headers: { "Retry-After": "60" } }),
    fetch: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(denied.response.status, 429);
  assert.equal(denied.response.headers.get("retry-after"), "60");
  assert.equal(denied.response.headers.get("cache-control"), "no-store");
  assert.equal(denied.body, "slow down");
  assert.equal((await outcome(request(), { rateLimit: async () => {} })).body, "ok");
});

test("OPTIONS does not require target or rate limiter; unsupported methods are 405", async () => {
  const proxy = createCorsProxy();
  const result = await proxy(new Request(PROXY, { method: "OPTIONS", headers: { Origin: "https://playground.wordpress.net" } }));
  assert.equal(result.status, 204);
  assert.equal(await result.text(), "");
  assert.equal(result.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
  for (const name of ["Authorization", "git-protocol", "Range", "X-Cors-Proxy-Content-Type", "X-Cors-Proxy-Range", "X-Cors-Proxy-Allowed-Request-Headers"]) {
    assert.ok(result.headers.get("access-control-allow-headers")!.includes(name));
  }
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const response = await proxy(request(TARGET, { method }));
    assert.equal(response.status, 405);
    assert.equal(await response.text(), "Method Not Allowed");
  }
});

test("CORS is limited to built-in origins and the proxy's own origin", async () => {
  for (const origin of ["https://playground-preview.test", "https://playground.wordpress.net",
    "http://localhost", "http://127.0.0.1", ...[5400, 5401, 4400].flatMap(port =>
      [`http://localhost:${port}`, `http://127.0.0.1:${port}`]), PROXY]) {
    const { response } = await outcome(request(TARGET, { headers: { Origin: origin } }));
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    for (const name of ["Content-Range", "Accept-Ranges", "ETag", "Date", "Last-Modified", "X-Playground-Cors-Proxy"]) {
      assert.ok(response.headers.get("access-control-expose-headers")!.includes(name));
    }
  }
  for (const origin of [undefined, "null", "https://evil.example", "https://playground.wordpress.net.evil.example"]) {
    const { response } = await outcome(request(TARGET, { headers: origin ? { Origin: origin } : {} }));
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("x-playground-cors-proxy"), "true");
    assert.equal(response.headers.get("vary"), "Origin");
  }
});

test("exact and single-label subdomain origin rules validate concrete origins", () => {
  const rules: OriginRule[] = [
    { type: "match-exact", origin: "https://exact.example" },
    { type: "match-subdomain", scheme: "https", host: "preview.example", port: null },
    { type: "match-subdomain", scheme: "http", host: "preview.example", port: 8080 },
  ];
  for (const origin of ["https://exact.example", "https://one.preview.example", "https://ONE.PREVIEW.EXAMPLE", "http://one.preview.example:8080"]) {
    assert.equal(matchesOrigin(origin, rules), true, origin);
  }
  for (const origin of ["", "not a URL", "null", "ftp://a.preview.example", "https://u:p@a.preview.example",
    "https://u@a.preview.example", "https://a.preview.example/", "https://a.preview.example/path",
    "https://a.preview.example?x", "https://a.preview.example#x", "https://*.preview.example",
    "https://preview.example", "https://a.b.preview.example", "https://a.preview.example.evil",
    "http://a.preview.example", "https://a.preview.example:8080", "https://a.preview.example:0"]) {
    assert.equal(matchesOrigin(origin, rules), false, origin);
  }
  assert.equal(matchesOrigin("https://exact.example", []), false);
});

test("environment origin rules replace defaults, including an empty list", async () => {
  for (const [value, origin, allowed] of [
    ["https://custom.example https://*.preview.example http://*.local.example:8080", "https://custom.example", true],
    ["https://custom.example https://*.preview.example http://*.local.example:8080", "https://a.preview.example", true],
    ["http://*.local.example:8080", "http://a.local.example:8080", true],
    ["https://custom.example", "https://playground.wordpress.net", false],
    [" ", "https://playground.wordpress.net", false],
  ] as const) {
    const { response } = await outcome(request(TARGET, { headers: { Origin: origin } }),
      { env: { CUSTOM_SUPPORTED_ORIGINS_SPACE_SEPARATED: value } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), allowed ? origin : null);
  }
  for (const value of ["null", "https://example.com/path", "https://*.*.example", "ftp://*.example.com", "https://example.*"]) {
    const { response } = await outcome(request(), { env: { CUSTOM_SUPPORTED_ORIGINS_SPACE_SEPARATED: value } });
    assert.equal(response.status, 503);
  }
  const { response } = await outcome(request(TARGET, { headers: { Origin: "https://only.example" } }),
    { originRules: [{ type: "match-exact", origin: "https://only.example" }] });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://only.example");
});

test("raw-query, encoded url parameter and path targets preserve target queries", async () => {
  const seen: string[] = [];
  const proxy = relay({ fetch: async url => { seen.push(url); return new Response("ok"); } });
  for (const url of [`${PROXY}/?${TARGET}`, `${PROXY}/?url=${encodeURIComponent(TARGET)}`,
    `${PROXY}/${TARGET}`, `${PROXY}/proxy.php/${TARGET}`]) {
    assert.equal(await (await proxy(new Request(url))).text(), "ok");
  }
  assert.deepEqual(seen, [TARGET, TARGET, TARGET, TARGET]);
  for (const url of [PROXY, `${PROXY}/?url=`, `${PROXY}/?url=${encodeURIComponent(TARGET)}&extra=1`, `${PROXY}/?url=a&url=b`]) {
    const response = await proxy(new Request(url));
    assert.equal(response.status, 400);
    await response.text();
  }
  assert.equal(seen.length, 4);
});

test("invalid schemes, credentials, parser repairs and self targets are rejected", async () => {
  for (const target of ["ftp://public.example", "file:///etc/passwd", "https:public.example", "https://",
    "https://u:p@public.example", "https://u@public.example", "https://public.example:70000",
    "https://public.example/with space", "https://public.example/\npath", "https://public.example\\evil",
    `${PROXY}/again`, "https://proxy.example.:8443/again"]) {
    const { response } = await outcome(request(target), { fetch: async () => { throw new Error("must not fetch"); } });
    assert.equal(response.status, 400, target);
  }
  for (const target of ["HTTP://PUBLIC.EXAMPLE:8080/path", "https://public.example:8443/path"]) {
    assert.equal((await outcome(request(target))).response.status, 200);
  }
});

test("private/special-use literals, mapped IPv6 and local names are rejected", async () => {
  for (const host of ["0.0.0.1", "10.0.0.1", "127.1", "2130706433", "0x7f000001",
    "100.64.0.0", "100.127.255.255", "169.254.169.254", "172.16.0.0", "172.31.255.255",
    "192.168.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.0.1",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "localhost", "localhost.",
    "a.localhost", "a.local", "a.internal", "[::]", "[::1]", "[fc00::1]", "[fe80::1]",
    "[::ffff:127.0.0.1]", "[::ffff:8.8.8.8]", "[64:ff9b::808:808]", "[64:ff9b:1::1]",
    "[100::1]", "[2001::1]", "[2001:20::1]", "[2001:db8::1]", "[2002::1]", "[5f00::1]", "[ff00::1]"]) {
    const { response } = await outcome(request(`https://${host}/`), { fetch: async () => { throw new Error("must not fetch"); } });
    assert.equal(response.status, 400, host);
  }
  for (const host of ["8.8.8.8", "54.239.28.85", "204.79.197.200", "100.63.255.255", "100.128.0.1",
    "169.253.0.1", "172.15.0.1", "172.32.0.1", "192.0.1.1", "192.88.98.1", "192.169.0.1",
    "198.17.0.1", "198.20.0.1", "198.51.99.1", "203.0.112.1", "[2001:4860:4860::8888]",
    "[2606:4700:4700:0:0:0:0:1111]", "public.example", "public.example."]) {
    assert.equal((await outcome(request(`https://${host}/`))).response.status, 200, host);
  }
});

test("header forwarding includes git/custom headers and strips ambient credentials and hop headers", async () => {
  let sent!: Headers;
  const { body } = await outcome(request(TARGET, { headers: {
    Accept: "application/x-git-upload-pack-advertisement", "git-protocol": "version=2",
    "wp_blog": "blog", "wp_install": "1", "X-Custom": "opaque",
    Host: "wrong.example", Cookie: "ambient", Cookie2: "old", Authorization: "Basic ambient",
    "Proxy-Authorization": "secret", Connection: "X-Hop", "X-Hop": "strip",
    "Keep-Alive": "1", TE: "trailers", Trailer: "X-Trailer", Upgrade: "websocket",
    "Accept-Encoding": "gzip",
  } }), { fetch: async (_url, init) => { sent = new Headers(init.headers); return new Response("ok"); } });
  assert.equal(body, "ok");
  for (const name of ["host", "cookie", "cookie2", "authorization", "proxy-authorization", "connection", "x-hop", "keep-alive", "te", "trailer", "upgrade"]) assert.equal(sent.get(name), null, name);
  assert.equal(sent.get("git-protocol"), "version=2");
  assert.equal(sent.get("x-custom"), "opaque");
  assert.equal(sent.get("wp_blog"), "blog");
  assert.equal(sent.get("wp_install"), "1");
  assert.equal(sent.get("accept-encoding"), "identity");
});

test("Authorization requires explicit case-insensitive opt-in; internal headers never reach upstream", async () => {
  let sent!: Headers;
  const { response } = await outcome(request(TARGET, { headers: {
    Authorization: "Bearer explicit", "X-Cors-Proxy-Allowed-Request-Headers": " x-custom, AUTHORIZATION , Cookie",
    Cookie: "secret", "X-Cors-Proxy-Content-Type": "multipart/form-data; boundary=test",
    "Content-Type": "application/octet-stream", "X-Cors-Proxy-Range": "bytes=0-15",
  } }), { fetch: async (_url, init) => { sent = new Headers(init.headers); return new Response("ok"); } });
  assert.equal(response.status, 200);
  assert.equal(sent.get("authorization"), "Bearer explicit");
  assert.equal(sent.get("content-type"), "multipart/form-data; boundary=test");
  assert.equal(sent.get("range"), "bytes=0-15");
  for (const name of ["cookie", "x-cors-proxy-allowed-request-headers", "x-cors-proxy-content-type", "x-cors-proxy-range"]) assert.equal(sent.get(name), null);
});

test("Range alias alone, matching Range, empty alias and conflicts", async () => {
  for (const headers of [{ "X-Cors-Proxy-Range": "bytes=-64" },
    { Range: "bytes=-64", "X-Cors-Proxy-Range": "bytes=-64" },
    { Range: "bytes=-64", "X-Cors-Proxy-Range": "" },
    { Range: "", "X-Cors-Proxy-Range": "bytes=-64" }]) {
    let sent!: Headers;
    const { response } = await outcome(request(TARGET, { headers: headers as Record<string, string> }), { fetch: async (_url, init) => {
      sent = new Headers(init.headers); return new Response("part", { status: 206, headers: { "Content-Range": "bytes 0-3/4" } });
    } });
    assert.equal(response.status, 206);
    assert.equal(sent.get("range"), "bytes=-64");
    assert.equal(sent.has("x-cors-proxy-range"), false);
    assert.equal(response.headers.get("content-range"), "bytes 0-3/4");
  }
  const conflict = await outcome(request(TARGET, { headers: { Range: "bytes=0-1", "X-Cors-Proxy-Range": "bytes=2-3" } }));
  assert.equal(conflict.response.status, 400);
  assert.match(conflict.body, /disagree/);
});

test("POST preserves binary and multipart bytes without parsing", async () => {
  for (const contentType of ["application/x-git-upload-pack-request", "multipart/form-data; boundary=test"]) {
    const bytes = new Uint8Array([0, 1, 2, 13, 10, 255]);
    const { body } = await outcome(request(TARGET, { method: "POST", body: bytes, headers: { "Content-Type": contentType } }), {
      fetch: async (_url, init) => {
        assert.equal(init.method, "POST");
        assert.equal(new Headers(init.headers).get("content-type"), contentType);
        assert.deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()), bytes);
        return new Response("posted");
      },
    });
    assert.equal(body, "posted");
  }
  assert.equal((await outcome(request(TARGET, { method: "POST" }))).response.status, 200);
});

test("POST request cap checks declared sizes and unannounced streamed bytes", async () => {
  for (const length of [8, 9]) {
    const result = await outcome(request(TARGET, { method: "POST", body: "x", headers: { "Content-Length": String(length) } }),
      { maxRequestBytes: 8, fetch: async () => { throw new Error("must not fetch"); } });
    assert.equal(result.response.status, 413);
  }
  for (const size of [7, 8, 9]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(size)); }, cancel() { cancelled = true; } });
    const req = request(TARGET, { method: "POST", body, duplex: "half" } as RequestInit);
    const result = await outcome(req, { maxRequestBytes: 8, fetch: async (_url, init) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      try { await reader.read(); } finally { reader.releaseLock(); }
      return new Response("ok");
    } });
    assert.equal(result.response.status, size < 8 ? 200 : 413);
    assert.equal(cancelled, size >= 8);
    // The bounded request stream owns the reader until upload completes.
  }
});

test("early request bytes are forwarded while the client is still uploading", async () => {
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(new TextEncoder().encode("first")); finish = () => { c.enqueue(new TextEncoder().encode("last")); c.close(); };
  } });
  const firstRead = deferred<string>();
  const pending = outcome(request(TARGET, { method: "POST", body, duplex: "half" } as RequestInit), {
    fetch: async (_url, init) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read(); firstRead.resolve(new TextDecoder().decode(first.value));
      const last = await reader.read(); assert.equal(new TextDecoder().decode(last.value), "last");
      assert.equal((await reader.read()).done, true);
      return new Response("ok");
    },
  });
  assert.equal(await firstRead.promise, "first");
  finish(); assert.equal((await pending).body, "ok");
});

test("an upstream that swallows an oversized upload cannot turn it into success", async () => {
  const result = await outcome(request(TARGET, { method: "POST", body: "too large" }), {
    maxRequestBytes: 3,
    fetch: async (_url, init) => {
      await new Response(init.body).text().catch(() => {});
      return new Response("optimistic success");
    },
  });
  assert.equal(result.response.status, 413);
  assert.equal(result.body, "Request Entity Too Large");
});

test("upstream statuses and inert headers survive; authority and transport headers do not", async () => {
  const blocked = ["Set-Cookie", "Set-Cookie2", "Authorization", "WWW-Authenticate", "Proxy-Authenticate",
    "Cache-Control", "Strict-Transport-Security", "Upgrade-Insecure-Requests", "Clear-Site-Data",
    "Content-Security-Policy", "Content-Security-Policy-Report-Only", "Cross-Origin-Opener-Policy",
    "Cross-Origin-Embedder-Policy", "Cross-Origin-Resource-Policy", "X-Sendfile", "X-Sendfile-Temporary",
    "X-Sendfile2", "X-Lighttpd-Send-File", "Surrogate-Control", "Edge-Control", "Status", "X-Accel-Redirect",
    "X-LiteSpeed-Cache-Control", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control", "X-Spacefast-Foo", "X-Stattic-Foo",
    "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Expose-Headers",
    "Connection", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade", "X-Playground-Cors-Proxy", "Vary", "X-Hop"];
  const upstreamHeaders = new Headers(Object.fromEntries(blocked.map(name => [name, "evil"])));
  upstreamHeaders.set("connection", "X-Hop");
  upstreamHeaders.set("content-type", "application/octet-stream");
  upstreamHeaders.set("content-range", "bytes */123");
  upstreamHeaders.set("accept-ranges", "bytes");
  upstreamHeaders.set("etag", '"version"');
  upstreamHeaders.set("last-modified", "Wed, 01 Jan 2025 00:00:00 GMT");
  upstreamHeaders.set("x-custom", "data");
  const { response, body } = await outcome(request(), { fetch: async () => new Response("range error", { status: 416, headers: upstreamHeaders }) });
  assert.equal(response.status, 416);
  assert.equal(body, "range error");
  for (const name of blocked) {
    if (["Cache-Control", "Cross-Origin-Resource-Policy", "X-Playground-Cors-Proxy", "Vary"].includes(name)) continue;
    assert.equal(response.headers.get(name), null, name);
  }
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-playground-cors-proxy"), "true");
  assert.equal(response.headers.get("content-range"), "bytes */123");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("etag"), '"version"');
  assert.equal(response.headers.get("x-custom"), "data");
});

test("response caps reject declared lengths and exclude upstream headers from errors", async () => {
  let cancelled = false;
  const { response, body } = await outcome(request(TARGET, { headers: { Origin: "https://playground.wordpress.net" } }), {
    maxResponseBytes: 8,
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 302, headers: { "Content-Length": "8", Location: "https://public.example/elsewhere", Expires: "tomorrow", "X-Custom": "data" },
    }),
  });
  assert.equal(response.status, 413); assert.equal(body, "Response Too Large");
  assert.equal(cancelled, true);
  for (const name of ["location", "expires", "x-custom", "content-length"]) assert.equal(response.headers.get(name), null);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://playground.wordpress.net");
});

test("upstream cancellation failures cannot replace proxy errors", async () => {
  for (const [headers, expectedStatus] of [
    [{ "Content-Length": "8" }, 413],
    [{ Location: "file:///etc/passwd" }, 502],
  ] as const) {
    const { response } = await outcome(request(), {
      maxResponseBytes: 8,
      fetch: async () => new Response(new ReadableStream({ cancel() { throw new Error("cancel failed"); } }),
        { status: 302, headers: headers as Record<string, string> }),
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("location"), null);
  }
});

test("HEAD keeps lengths larger than the response cap and never sends a body", async () => {
  let cancelled = false;
  const { response, body } = await outcome(request(TARGET, { method: "HEAD" }), {
    maxResponseBytes: 8, fetch: async (_url, init) => {
      assert.equal(new Headers(init.headers).get("accept-encoding"), "identity");
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Length": "4294967296", "Content-Encoding": "identity" } });
    },
  });
  assert.equal(response.status, 200); assert.equal(body, "");
  assert.equal(response.headers.get("content-length"), "4294967296");
  assert.equal(cancelled, true);
  const invalid = await outcome(request("ftp://public.example", { method: "HEAD" }));
  assert.equal(invalid.response.status, 400); assert.equal(invalid.body, "");
});

test("bodyless statuses stay bodyless and invalid/stale lengths are removed", async () => {
  for (const status of [204, 205, 304]) {
    const { response, body } = await outcome(request(), { fetch: async () => new Response(null, { status }) });
    assert.equal(response.status, status); assert.equal(body, "");
  }
  for (const headers of ([{ "Content-Length": "not a number" }, { "Content-Length": "4", "Transfer-Encoding": "chunked" },
    { "Content-Length": "20", "Content-Encoding": "gzip" }] as Record<string, string>[])) {
    const { response, body } = await outcome(request(), { fetch: async () => new Response("body", { headers: headers as Record<string, string> }) });
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(body, "body");
  }
  const { response } = await outcome(request(), { fetch: async () => new Response("body", { headers: { "Content-Length": "4" } }) });
  assert.equal(response.headers.get("content-length"), "4");
});

test("unexpected compression fails ranged and HEAD responses without stale metadata", async () => {
  for (const [method, status] of [["GET", 206], ["HEAD", 200]] as const) {
    const { response } = await outcome(request(TARGET, { method }), { fetch: async () => new Response("encoded", {
      status, headers: { "Content-Encoding": "gzip", "Content-Range": "bytes 0-6/100", "Content-Length": "7" },
    }) });
    assert.equal(response.status, 502);
    for (const name of ["content-range", "content-length", "content-encoding"]) assert.equal(response.headers.get(name), null);
  }
});

test("redirects stay on the proxy in every URL form and retain methods/query/ports", async () => {
  for (const [suffix, mode] of [[`/?${TARGET}`, "raw"], [`/?url=${encodeURIComponent(TARGET)}`, "encoded"], [`/proxy.php/${TARGET}`, "path"]] as const) {
    for (const location of ["/next?x=1", "next", "../next", "?x=2", "#fragment", "//other.example:9090/two", "https://other.example:8443/two"]) {
      let redirected = "";
      const response = await relay({ fetch: async (_url, init) => {
        assert.equal(init.redirect, "manual");
        return new Response(null, { status: 307, headers: { Location: location } });
      } })(new Request(PROXY + suffix));
      assert.equal(response.status, 307);
      redirected = response.headers.get("location")!;
      const expected = new URL(location, TARGET).href;
      assert.equal(redirected, mode === "encoded" ? `${PROXY}/?url=${encodeURIComponent(expected)}`
        : mode === "path" ? `${PROXY}/proxy.php/${expected}` : `${PROXY}/?${expected}`);
      let seen = "";
      await (await relay({ fetch: async url => { seen = url; return new Response(null); } })(new Request(redirected))).text();
      // Fragments do not travel on HTTP requests; all other components do.
      const withoutFragment = new URL(expected); withoutFragment.hash = "";
      assert.equal(seen, mode === "encoded" ? expected : withoutFragment.href);
    }
  }
});

test("redirects to private hosts, self or non-HTTP schemes fail without target headers", async () => {
  for (const location of ["http://127.0.0.1/private", `${PROXY}/again`, "file:///etc/passwd", "https://u:p@public.example"]) {
    const { response, body } = await outcome(request(), { fetch: async () => new Response("redirect body", {
      status: 302, headers: { "X-Custom": "data", "Content-Type": "text/html", Location: location },
    }) });
    assert.equal(response.status, 502); assert.equal(body, "Bad Gateway");
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("x-custom"), null);
  }
});

test("response streaming delivers the first chunk before upstream completion", async () => {
  let finish!: () => void;
  const upstream = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(new TextEncoder().encode("first")); finish = () => { c.enqueue(new TextEncoder().encode("last")); c.close(); };
  } });
  const response = await relay({ fetch: async () => new Response(upstream) })(request());
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  finish(); assert.equal(new TextDecoder().decode((await reader.read()).value), "last");
  assert.equal((await reader.read()).done, true);
});

test("undeclared oversized bodies error the stream and cancel upstream without appending text", async () => {
  let cancelled: unknown;
  let signal!: AbortSignal;
  const upstream = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(new Uint8Array([1, 2, 3])); c.enqueue(new Uint8Array([4, 5, 6, 7, 8]));
  }, cancel(reason) { cancelled = reason; } });
  const response = await relay({ maxResponseBytes: 8, fetch: async (_url, init) => {
    signal = init.signal!; return new Response(upstream);
  } })(request());
  const reader = response.body!.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
  await assert.rejects(reader.read(), /Body too large/);
  assert.ok(cancelled instanceof Error);
  assert.equal(signal.aborted, true);
});

test("consumer cancellation reaches upstream including its reason", async () => {
  for (const rejectCancel of [false, true]) {
    let reason: unknown;
    let signal!: AbortSignal;
    const upstream = new ReadableStream<Uint8Array>({ cancel(value) {
      reason = value; if (rejectCancel) throw new Error("cancel failed");
    } });
    const response = await relay({ fetch: async (_url, init) => { signal = init.signal!; return new Response(upstream); } })(request());
    if (rejectCancel) await assert.rejects(response.body!.cancel("gone"), /cancel failed/);
    else await response.body!.cancel("gone");
    assert.equal(reason, "gone"); assert.equal(signal.aborted, true);
  }
});

test("upstream read failures remain stream failures rather than successful error-text payloads", async () => {
  const failure = new Error("upstream disconnected");
  const upstream = new ReadableStream<Uint8Array>({ pull() { throw failure; } });
  const response = await relay({ fetch: async () => new Response(upstream) })(request());
  await assert.rejects(response.text(), /upstream disconnected/);
});

test("abort before dispatch and before headers, and fetch failures", async () => {
  const already = new AbortController(); already.abort();
  const result = await outcome(request(TARGET, { signal: already.signal }));
  assert.equal(result.response.status, 499);
  const abort = new AbortController();
  const seen = deferred<void>();
  const pending = outcome(request(TARGET, { signal: abort.signal }), {
    fetch: async (_url, init) => {
      seen.resolve();
      await new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return new Response("unreachable");
    },
  });
  await seen.promise; abort.abort();
  assert.equal((await pending).response.status, 499);
  const failed = await outcome(request(), { fetch: async () => { throw new Error("internal secret"); } });
  assert.equal(failed.response.status, 502); assert.equal(failed.body, "Bad Gateway");
});

test("actual HTTP transport: binary POST, multipart, ranges, HEAD, gzip and early hints", async t => {
  const entity = Buffer.from("0123456789abcdef");
  const received: { method?: string; path?: string; body: Buffer; headers: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ method: req.method, path: req.url, body: Buffer.concat(chunks), headers: req.headers });
    if (req.url === "/gzip") {
      const encoded = gzipSync(entity);
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Length": String(encoded.length) }); res.end(encoded);
    } else if (req.url === "/hints") {
      res.writeEarlyHints({ link: "</early>; rel=preload", "x-interim": "skip" });
      res.writeHead(200, { "X-Final": "yes" }); res.end(entity);
    } else if (req.headers.range) {
      res.writeHead(206, { "Content-Range": "bytes 4-7/16", "Content-Length": "4", "Accept-Ranges": "bytes", ETag: '"v1"' }); res.end(entity.subarray(4, 8));
    } else {
      res.writeHead(200, { "Content-Length": String(entity.length) }); res.end(entity);
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const local = `http://127.0.0.1:${address.port}`;
  // The public hostname stays subject to production validation. Only the
  // test transport maps it to the loopback fixture; no deployable bypass.
  const proxy = relay({ fetch: (url, init) => {
    const parsed = new URL(url); return fetch(local + parsed.pathname + parsed.search, init);
  } });
  for (const type of ["application/x-git-upload-pack-request", "multipart/form-data; boundary=test"]) {
    const response = await proxy(request("https://public.example/post?x=1", { method: "POST", body: new Uint8Array([0, 255, 13, 10]), headers: { "Content-Type": type } }));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), entity);
    const record = received.at(-1)!;
    assert.equal(record.method, "POST"); assert.equal(record.path, "/post?x=1");
    assert.deepEqual(record.body, Buffer.from([0, 255, 13, 10])); assert.equal(record.headers["content-type"], type);
  }
  const ranged = await proxy(request("https://public.example/range", { headers: { "X-Cors-Proxy-Range": "bytes=4-7" } }));
  assert.equal(ranged.status, 206); assert.equal(await ranged.text(), "4567");
  assert.equal(received.at(-1)!.headers.range, "bytes=4-7");
  assert.equal(ranged.headers.get("content-range"), "bytes 4-7/16");
  const head = await proxy(request("https://public.example/head", { method: "HEAD" }));
  assert.equal(head.headers.get("content-length"), "16"); assert.equal(await head.text(), "");
  const gzip = await proxy(request("https://public.example/gzip"));
  assert.deepEqual(Buffer.from(await gzip.arrayBuffer()), entity);
  assert.equal(gzip.headers.get("content-encoding"), null); assert.equal(gzip.headers.get("content-length"), null);
  const hints = await proxy(request("https://public.example/hints"));
  assert.deepEqual(Buffer.from(await hints.arrayBuffer()), entity);
  assert.equal(hints.headers.get("x-interim"), null); assert.equal(hints.headers.get("x-final"), "yes");
});
