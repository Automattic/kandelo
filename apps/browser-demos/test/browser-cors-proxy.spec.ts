import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { createHmac } from "node:crypto";
import { createCorsProxy } from "../../spacefast-cors-proxy/src/proxy.ts";
import { createDatabaseRateLimit } from "../../spacefast-cors-proxy/src/rate-limit.ts";
import { createProxySessionTransport } from "../../../host/src/networking/cors-proxy-session";

test("Spacefast quota sessions survive cookie-free requests, reload and service-worker reprojection", async ({ page }) => {
  const { build } = await import("esbuild");
  const client = await build({ stdin: { contents: `export { createBrowserLazyFetcher } from "./host/src/vfs/browser-lazy-fetcher.ts";
export { BrowserCorsProxy } from "./host/src/networking/browser-cors-proxy.ts";`,
    resolveDir: fileURLToPath(new URL("../../../", import.meta.url)) }, bundle: true,
    write: false, format: "esm", platform: "browser" });
  let appOrigin = "", proxyOrigin = "", issued = 0, spent = 0, remaining = 1000;
  const secret = "a1".repeat(32);
  const db = { prepare(sql: string) {
    const statement = { bind() { return statement; }, async all() {
      if (sql.startsWith("SELECT secret")) return { results: [{ secret }] };
      if (sql.startsWith("UPDATE")) return { meta: { changes: remaining-- > 0 ? 1 : 0 } };
      return { success: true };
    } }; return statement;
  } };
  const proxy = createServer(async (request, response) => {
    try {
      expect(request.headers.cookie).toBeUndefined();
      if (request.url === "/cors-proxy-session") {
        expect(request.headers.referer).toBe(appOrigin + "/"); issued++;
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        const unsigned = `v1.${"12".repeat(16)}.${expiresAt}`;
        const signature = createHmac("sha256", Buffer.from(secret, "hex"))
          .update(`kandelo-cors-proxy\n${proxyOrigin}\n${unsigned}`).digest("hex");
        response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": appOrigin, "Cache-Control": "no-store" });
        response.end(JSON.stringify({ token: unsigned + "." + signature, expiresAt })); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const handler = createCorsProxy({ env: { CORS_PROXY_ALLOWED_REFERER_ORIGINS: appOrigin },
        rateLimit: createDatabaseRateLimit(db), fetch: async (_url, init) => {
          expect(new Headers(init.headers).has("X-Kandelo-Proxy-Session")).toBe(false);
          expect(new Headers(init.headers).has("cookie")).toBe(false); spent++;
          const body = init.body ? await new Response(init.body).text() : "asset bytes";
          return new Response(body, { headers: { "X-Kandelo-Proxy-Session": "required" } });
        } });
      const result = await handler(new Request(proxyOrigin + request.url, { method: request.method,
        headers: request.headers as Record<string, string>, ...(chunks.length
          ? { body: Buffer.concat(chunks), duplex: "half" } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  const rawWorker = await readFile(serviceWorkerPath, "utf8");
  const config = () => ({ url: proxyOrigin + "/cors-proxy?url=", allowedRequestHeaderNames: ["accept", "content-type"], allowAnonymousGetHeaderOmission: true });
  const app = createServer((request, response) => {
    if (request.url === "/client.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(client.outputFiles[0].text); }
    else if (request.url === "/service-worker.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(rawWorker.replace('"__CORS_PROXY_CONFIG__"', JSON.stringify(config()))
        .replace('"__CORS_PROXY_SESSION_TRANSPORT__"', `(${createProxySessionTransport.toString()})`));
    } else { response.writeHead(200, { "Content-Type": "text/html" }); response.end('<!doctype html><title>Quota session fixture</title>'); }
  });
  try {
    proxyOrigin = await listen(proxy); appOrigin = await listen(app);
    await page.goto(appOrigin);
    const exercise = async () => page.evaluate(async ({ proxyUrl }) => {
      const { createBrowserLazyFetcher, BrowserCorsProxy } = await import("/client.js");
      const config = { url: proxyUrl, allowedRequestHeaderNames: ["accept", "content-type"], allowAnonymousGetHeaderOmission: true };
      const lazy = createBrowserLazyFetcher(config);
      const responses = await Promise.all(Array.from({ length: 4 }, () => lazy("https://public.example/asset")));
      const http = new BrowserCorsProxy(config);
      const posted = await http.fetch({ method: "POST", headers: [["Content-Type", "text/plain"]], body: "git upload bytes", targetUrl: "https://public.example/post" });
      return { bodies: await Promise.all(responses.map(r => r.text())), post: await posted.text() };
    }, { proxyUrl: config().url });
    expect(await exercise()).toEqual({ bodies: Array(4).fill("asset bytes"), post: "git upload bytes" });
    expect(issued).toBe(1); expect(spent).toBe(5);
    await page.reload();
    expect(await exercise()).toEqual({ bodies: Array(4).fill("asset bytes"), post: "git upload bytes" });
    expect(issued).toBe(1); expect(spent).toBe(10);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/service-worker.js", { scope: "/" }); await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    });
    expect(await exercise()).toEqual({ bodies: Array(4).fill("asset bytes"), post: "git upload bytes" });
    expect(issued).toBe(1); expect(spent).toBe(15);
    remaining = 0;
    expect(await page.evaluate(async url => { const r = await fetch(url); return { status: r.status, retry: r.headers.get("Retry-After") }; }, config().url + encodeURIComponent("https://public.example/exhausted")))
      .toEqual({ status: 429, retry: "1" });
    expect(spent).toBe(15);
  } finally { await Promise.all([close(app), close(proxy)]); }
});

test.describe("lazy artifact proxy authentication", () => {
  test.use({ serviceWorkers: "allow" });
  test("lazy assets authenticate only to a configured same-origin proxy", async ({ page }) => {
    const { build } = await import("esbuild");
    const modulePath = fileURLToPath(new URL("../../../host/src/vfs/browser-lazy-fetcher.ts", import.meta.url));
    const bundle = await build({ entryPoints: [modulePath], bundle: true, write: false,
      format: "esm", platform: "browser" });
    const rawServiceWorker = await readFile(serviceWorkerPath, "utf8");
    let origin = "";
    let externalOrigin = "";
    const browserErrors: string[] = [];
    page.on("console", message => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    const observed: Array<{ url: string; cookie?: string; referer?: string }> = [];
    const proxy = (privateProxy: boolean) => createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html",
          "Set-Cookie": "private-space-session=fixture-session; Path=/; HttpOnly; SameSite=Lax",
          "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
        response.end('<!doctype html><title>Private proxy fixture</title><link rel="icon" href="data:,">');
      } else if (request.url === "/fetcher.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end(bundle.outputFiles[0].text);
      } else if (request.url === "/service-worker.js") {
        response.writeHead(200, { "Content-Type": "text/javascript",
          "Cross-Origin-Embedder-Policy": "require-corp" });
        response.end(rawServiceWorker.replace('"__CORS_PROXY_CONFIG__"', JSON.stringify({
          url: `${origin}/proxy?url=`, allowedRequestHeaderNames: ["accept", "content-type"],
          allowAnonymousGetHeaderOmission: true,
        })));
      } else if (!request.url?.startsWith("/proxy?")) {
        response.writeHead(404); response.end();
      } else {
        const url = new URL(request.url!, privateProxy ? origin : externalOrigin);
        observed.push({ url: url.href, cookie: request.headers.cookie, referer: request.headers.referer });
        response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? origin);
        response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        response.setHeader("Cache-Control", "no-store");
        if (privateProxy && !request.headers.cookie?.includes("private-space-session=fixture-session")) {
          response.writeHead(403); response.end("private proxy requires a session");
        } else if (url.searchParams.get("url")?.endsWith("/redirect")) {
          response.writeHead(302, { Location: `${externalOrigin}/proxy?url=https://cdn.example.test/asset` });
          response.end();
        } else {
          response.end("verified fixture bytes");
        }
      }
    });
    const sameOriginProxy = proxy(true);
    const externalProxy = proxy(false);
    try {
      origin = await listen(sameOriginProxy);
      externalOrigin = await listen(externalProxy);
      await page.goto(origin);
      const results = await page.evaluate(async ({ origin, externalOrigin }) => {
        const { createBrowserLazyFetcher } = await import(`${origin}/fetcher.js`);
        const results = [];
        for (const [proxyOrigin, asset] of [[origin, "asset"], [externalOrigin, "asset"], [origin, "redirect"]]) {
          const fetcher = createBrowserLazyFetcher({ url: `${proxyOrigin}/proxy?url=`,
            allowedRequestHeaderNames: [], allowAnonymousGetHeaderOmission: true });
          const response = await fetcher(`https://cdn.example.test/${asset}`, { credentials: "omit" });
          results.push({ status: response.status, body: await response.text() });
        }
        return results;
      }, { origin, externalOrigin }).catch(error => {
        throw new Error(JSON.stringify({ error: String(error), browserErrors, observed }));
      });
      expect(results, JSON.stringify(observed)).toEqual(Array.from({ length: 3 }, () => ({ status: 200, body: "verified fixture bytes" })));
      expect(observed).toHaveLength(4);
      for (const request of observed) {
        expect(request.referer).toBe(origin + "/");
        if (new URL(request.url).origin === origin) {
          expect(request.cookie).toContain("private-space-session=fixture-session");
        } else {
          expect(request.cookie).toBeUndefined();
        }
      }
      // Production reprojects even already-proxied requests in the service
      // worker. Exercise that second authority with real cookies too.
      observed.length = 0;
      await page.evaluate(async () => {
        await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
        }
      });
      const controlledResults = await page.evaluate(async origin => {
        const { createBrowserLazyFetcher } = await import(`${origin}/fetcher.js`);
        const fetcher = createBrowserLazyFetcher({ url: `${origin}/proxy?url=`,
          allowedRequestHeaderNames: [], allowAnonymousGetHeaderOmission: true });
        const responses = [
          await fetcher("https://cdn.example.test/asset", { credentials: "omit" }),
          await fetch("https://cdn.example.test/direct", { credentials: "omit" }),
          await fetcher("https://cdn.example.test/redirect", { credentials: "omit" }),
        ];
        return Promise.all(responses.map(async response => ({ status: response.status, body: await response.text() })));
      }, origin);
      expect(controlledResults).toEqual(Array.from({ length: 3 }, () => ({ status: 200, body: "verified fixture bytes" })));
      expect(observed).toHaveLength(4);
      for (const request of observed) {
        expect(request.referer).toBe(origin + "/");
        expect(request.cookie).toBe(new URL(request.url).origin === origin
          ? "private-space-session=fixture-session" : undefined);
      }
    } finally {
      await Promise.all([close(sameOriginProxy), close(externalProxy)]);
    }
  });
});

const curlPath = resolveBinary("programs/curl.wasm");
const wgetPath = resolveBinary("programs/wget.wasm");
const serviceWorkerPath = fileURLToPath(
  new URL("../public/service-worker.js", import.meta.url),
);

// The production Playground proxy's preflight, measured 2026-09-28. It
// allows Range and its X-Cors-Proxy-Range workaround, not If-Range.
const ALLOWED_PREFLIGHT_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "git-protocol",
  "Range",
  "wp_blog",
  "wp_install",
  "x-cors-proxy-allowed-request-headers",
  "x-cors-proxy-content-type",
  "x-cors-proxy-range",
].join(", ");

// Byte N is N mod 251, so a slice from the wrong offset cannot match.
const RANGED_ENTITY = Buffer.from(
  Array.from({ length: 4096 }, (_, index) => index % 251),
);

const EFFECTIVE_PROXY_CONFIG = {
  allowedRequestHeaderNames: [
    "accept",
    "content-type",
    "git-protocol",
    "range",
    "wp_blog",
    "wp_install",
  ],
  allowAnonymousGetHeaderOmission: true,
  rangeRequestHeaderAlias: "x-cors-proxy-range",
} as const;

type TestResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  hostDiagnostics: Array<{ message: string }>;
};

type TestRunnerWindow = Window & {
  __testRunnerReady: boolean;
  __runTest(
    wasmBytes: ArrayBuffer,
    argv: string[],
    timeoutMs: number,
    options?: {
      dataFiles?: Array<{ path: string; data: number[] }>;
      env?: string[];
      corsProxy?: {
        url: string;
        allowedRequestHeaderNames: readonly string[];
        allowAnonymousGetHeaderOmission: boolean;
        rangeRequestHeaderAlias?: string;
      } | null;
      dnsAliases?: Record<string, string>;
    },
  ): Promise<TestResult>;
};

interface ProxyRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function constrainedProxyFixture(observed: ProxyRequest[]): Server {
  return createServer(async (request, response) => {
    observed.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: await requestBody(request),
    });
    const origin = request.headers.origin ?? "*";
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods":
          request.headers["access-control-request-method"] ?? "GET",
        "Access-Control-Allow-Headers": ALLOWED_PREFLIGHT_HEADERS,
        Vary: "Origin",
      });
      response.end();
      return;
    }
    const proxied = request.url?.startsWith("/?") === true;
    // Like production: the front end strips Range before the proxy sees it,
    // so only the X-Cors-Proxy-Range workaround yields a 206.
    const aliased = /^bytes=(\d*)-(\d*)$/.exec(
      String(request.headers["x-cors-proxy-range"] ?? ""),
    );
    const ranged = proxied && request.url!.includes("/archive");
    // Production's caching headers: no-cache permits storage (with
    // revalidation), and a strong ETag lets the HTTP cache revalidate and
    // splice partial entries. That is what lets the cache rewrite Range below
    // the service worker without rewriting the alias, so the fixture keeps it.
    if (ranged && aliased === null) {
      response.writeHead(200, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, ETag",
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache",
        "Cross-Origin-Resource-Policy": "cross-origin",
        ETag: '"v1"',
        Vary: "Origin",
      });
      response.end(RANGED_ENTITY);
      return;
    }
    if (ranged && aliased !== null) {
      const size = RANGED_ENTITY.byteLength;
      const start = aliased[1] === ""
        ? size - Number(aliased[2])
        : Number(aliased[1]);
      const end = aliased[1] === "" || aliased[2] === ""
        ? size - 1
        : Math.min(Number(aliased[2]), size - 1);
      response.writeHead(206, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, ETag",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache",
        "Cross-Origin-Resource-Policy": "cross-origin",
        ETag: '"v1"',
        Vary: "Origin",
      });
      response.end(RANGED_ENTITY.subarray(start, end + 1));
      return;
    }
    response.writeHead(200, {
      ...(proxied ? { "Access-Control-Allow-Origin": origin } : {}),
      "Content-Type": "text/plain",
      "Cross-Origin-Resource-Policy": "cross-origin",
      Vary: "Origin",
    });
    response.end("constrained proxy response\n");
  });
}

function corsOpenTargetFixture(observed: ProxyRequest[]): Server {
  return createServer(async (request, response) => {
    observed.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: await requestBody(request),
    });
    // A CORS-open server answers preflights too. Engines that forward a
    // guest's own User-Agent (Firefox, WebKit) preflight the guest's POST;
    // Chromium drops that header and sends a simple request.
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          request.headers["access-control-request-method"] ?? "GET",
        "Access-Control-Allow-Headers":
          request.headers["access-control-request-headers"] ?? "",
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/plain",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    response.end("cors-open target response\n");
  });
}

test("Vite serves a service worker with the complete proxy profile", async ({
  request,
}) => {
  const response = await request.get("/service-worker.js");
  expect(response.ok()).toBe(true);
  const source = await response.text();
  expect(source).not.toContain("__CORS_PROXY_CONFIG__");
  expect(source).not.toContain("__CORS_PROXY_URL__");
  expect(source).not.toContain("__CORS_PROXY_SESSION_TRANSPORT__");
  expect(source).toContain("kandelo-proxy-sessions-v1");
  expect(source).toContain(
    '"allowedRequestHeaderNames":["accept","content-type","git-protocol","openai-beta","originator","range","session_id","version","wp_blog","wp_install","x-client-request-id","x-codex-installation-id","x-codex-parent-thread-id","x-codex-turn-metadata","x-codex-turn-state","x-openai-subagent"]',
  );
  expect(source).toContain('"allowAnonymousGetHeaderOmission":true');
  expect(source).toContain('"rangeRequestHeaderAlias":"x-cors-proxy-range"');
});

test("service worker projects both configured proxy boundaries", async ({
  context,
  page,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const directObserved: ProxyRequest[] = [];
  const directTarget = corsOpenTargetFixture(directObserved);
  const directRoot = await listen(directTarget);
  const rawServiceWorker = await readFile(serviceWorkerPath, "utf8");
  const config = {
    url: `${proxyRoot}/?`,
    ...EFFECTIVE_PROXY_CONFIG,
  };
  // Browser protocols differ in whether service-worker console events reach
  // Playwright. Read this diagnostic from the worker itself in every engine.
  const diagnosticProbe = `
var testProxyWarnings = [];
var testOriginalWarn = console.warn;
console.warn = function () { testProxyWarnings.push(Array.from(arguments).join(" ")); testOriginalWarn.apply(console, arguments); };
self.addEventListener("message", function (event) {
  if (event.data === "test-proxy-warnings" && event.ports[0]) event.ports[0].postMessage(testProxyWarnings);
});
`;
  const serviceWorker = diagnosticProbe + rawServiceWorker.replace(
    '"__CORS_PROXY_CONFIG__"',
    JSON.stringify(config),
  );
  const app = createServer((request, response) => {
    if (request.url === "/service-worker.js") {
      response.writeHead(200, {
        "Content-Type": "application/javascript",
      });
      response.end(serviceWorker);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><script>
      window.ready = navigator.serviceWorker.controller !== null;
      if (!window.ready) {
        navigator.serviceWorker.register('/service-worker.js', {
          scope: '/',
          updateViaCache: 'none',
        }).then(() =>
          navigator.serviceWorker.ready.then(() => location.reload()));
      }
    </script>`);
  });
  const appRoot = await listen(app);
  const corsErrors: string[] = [];
  context.on("console", (message) => {
    if (message.type() === "error" && /cors/i.test(message.text())) {
      corsErrors.push(message.text());
    }
  });

  try {
    await page.goto(appRoot);
    await page.waitForFunction(
      () => (window as Window & { ready?: boolean }).ready === true,
    );
    const results = await page.evaluate(
      async ({ proxyUrl, directUrl }) => {
        async function outcome(url: string, init: RequestInit) {
          const response = await fetch(url, init);
          return { status: response.status, body: await response.text() };
        }
        const target = "https://origin.example/browser-owned";
        const browserOwned = await outcome(target, {
          headers: {
            "Git-Protocol": "version=2",
            "X-Arbitrary-Metadata": "omit",
          },
        });
        const wrappedUrl = `${proxyUrl}/?https://origin.example/already-wrapped`;
        const alreadyWrapped = await outcome(wrappedUrl, {
          headers: {
            "Content-Type": "application/json",
            "X-Arbitrary-Metadata": "omit",
          },
        });
        const allowedPost = await outcome(wrappedUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"message":"preserve this body"}',
        });
        await outcome(target, {
          headers: {
            "Git-Protocol": "version=2",
            "X-Arbitrary-Metadata": "omit",
          },
        });
        const beforeRejected = performance.now();
        const rejected = await outcome(wrappedUrl, {
          method: "POST",
          headers: { "X-Arbitrary-Metadata": "reject" },
          body: "state change",
        });
        // A body-bearing request to a CORS-open server — the signalling
        // piplet's shape — must reach it directly, never the proxy.
        const directPost = await outcome(`${directUrl}/session`, {
          method: "POST",
          body: "kandelo1:offer",
        });
        return {
          browserOwned,
          alreadyWrapped,
          allowedPost,
          rejected,
          beforeRejected,
          directPost,
        };
      },
      { proxyUrl: proxyRoot, directUrl: directRoot },
    );

    expect(results.browserOwned).toEqual({
      status: 200,
      body: "constrained proxy response\n",
    });
    expect(results.alreadyWrapped).toEqual({
      status: 200,
      body: "constrained proxy response\n",
    });
    expect(results.allowedPost).toEqual({
      status: 200,
      body: "constrained proxy response\n",
    });
    expect(results.rejected.status).toBe(502);
    expect(results.directPost).toEqual({
      status: 200,
      body: "cors-open target response\n",
    });
    expect(directObserved).toMatchObject([
      { method: "POST", url: "/session", body: "kandelo1:offer" },
    ]);
    const actual = observed.filter(({ method }) => method !== "OPTIONS");
    expect(actual).toHaveLength(4);
    expect(actual[0]?.headers["git-protocol"]).toBe("version=2");
    expect(actual[0]?.headers["x-arbitrary-metadata"]).toBeUndefined();
    expect(actual[1]?.headers["content-type"]).toBe("application/json");
    expect(actual[1]?.headers["x-arbitrary-metadata"]).toBeUndefined();
    expect(actual[2]).toMatchObject({
      method: "POST",
      body: '{"message":"preserve this body"}',
    });
    expect(actual[2]?.headers["content-type"]).toBe("application/json");
    expect(actual[3]?.headers["git-protocol"]).toBe("version=2");
    const warnings = await page.evaluate(() => new Promise<string[]>(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
      navigator.serviceWorker.controller!.postMessage("test-proxy-warnings", [channel.port2]);
    }));
    expect(
      warnings.filter((message) =>
        message.includes(
          "Browser CORS proxy omitted unsupported request headers",
        ),
      ),
    ).toHaveLength(1);
    expect(
      warnings.every((message) => message.includes("https://origin.example")),
    ).toBe(true);
    expect(corsErrors).toEqual([]);
  } finally {
    await Promise.all([close(app), close(proxy), close(directTarget)]);
  }
});

test("service worker relays byte-range reads through the development relay", async ({
  page,
}) => {
  // Byte N of the entity is N mod 251, so a slice from the wrong offset
  // cannot match the expected bytes.
  const entity = Buffer.from(
    Array.from({ length: 8192 }, (_, index) => index % 251),
  );
  let streamingClosed = false;
  const upstreamRanges: Array<string | undefined> = [];
  const upstream = createServer((request, response) => {
    upstreamRanges.push(request.headers.range);
    if (request.url === "/streaming") {
      // Send one chunk and hold the body open: only a cancellation that
      // crosses the service worker and the relay can close this request.
      response.once("close", () => {
        streamingClosed = true;
      });
      response.writeHead(206, {
        "Content-Range": `bytes 0-${entity.byteLength - 1}/${entity.byteLength}`,
        "Content-Type": "application/octet-stream",
      });
      response.write(entity.subarray(0, 1024));
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (request.url === "/ranged" && match !== null) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      response.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${entity.byteLength}`,
        "Content-Type": "application/octet-stream",
      });
      response.end(entity.subarray(start, end + 1));
      return;
    }
    // A range-ignoring origin, like the production proxy today.
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.end(entity);
  });
  const upstreamRoot = await listen(upstream);

  try {
    await page.goto("/pages/test-runner/?minimal=1", { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/service-worker.js", {
        scope: "/",
        updateViaCache: "none",
      });
      await navigator.serviceWorker.ready;
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    const results = await page.evaluate(async (root) => {
      async function read(path: string, range: string) {
        const response = await fetch(`${root}${path}`, {
          headers: { Range: range },
        });
        return {
          status: response.status,
          contentRange: response.headers.get("content-range"),
          bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        };
      }
      return {
        tail: await read("/ranged", "bytes=8170-8191"),
        middle: await read("/ranged", "bytes=1000-1015"),
        ignored: await read("/no-ranges", "bytes=1000-1015"),
      };
    }, upstreamRoot);

    expect(results.tail).toEqual({
      status: 206,
      contentRange: "bytes 8170-8191/8192",
      bytes: Array.from(entity.subarray(8170, 8192)),
    });
    expect(results.middle).toEqual({
      status: 206,
      contentRange: "bytes 1000-1015/8192",
      bytes: Array.from(entity.subarray(1000, 1016)),
    });
    // A range-ignoring answer stays a 200 with the whole entity from offset
    // 0; nothing on the path reshapes it into a fake slice.
    expect(results.ignored.status).toBe(200);
    expect(results.ignored.contentRange).toBeNull();
    expect(results.ignored.bytes).toEqual(Array.from(entity));
    expect(upstreamRanges).toEqual([
      "bytes=8170-8191",
      "bytes=1000-1015",
      "bytes=1000-1015",
    ]);

    // Abandoning a read mid-body cancels the upstream transfer. An abort
    // before response headers is not covered: Chromium and WebKit did not
    // propagate it to the service worker's request signal when measured, so
    // it is a documented browser boundary (docs/browser-support.md).
    await page.evaluate(async (root) => {
      const controller = new AbortController();
      const response = await fetch(`${root}/streaming`, {
        headers: { Range: "bytes=0-" },
        signal: controller.signal,
      });
      await response.body!.getReader().read();
      controller.abort();
    }, upstreamRoot);
    await expect.poll(() => streamingClosed, { timeout: 10_000 }).toBe(true);
  } finally {
    upstream.closeAllConnections();
    await close(upstream);
  }
});

test("service worker reads ranges through a production-shaped proxy", async ({
  browserName,
  context,
  page,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const rawServiceWorker = await readFile(serviceWorkerPath, "utf8");
  const serviceWorker = rawServiceWorker.replace(
    '"__CORS_PROXY_CONFIG__"',
    JSON.stringify({ url: `${proxyRoot}/?`, ...EFFECTIVE_PROXY_CONFIG }),
  );
  const app = createServer((request, response) => {
    if (request.url === "/service-worker.js") {
      response.writeHead(200, { "Content-Type": "application/javascript" });
      response.end(serviceWorker);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><script>
      window.ready = navigator.serviceWorker.controller !== null;
      if (!window.ready) {
        navigator.serviceWorker.register('/service-worker.js', {
          scope: '/',
          updateViaCache: 'none',
        }).then(() =>
          navigator.serviceWorker.ready.then(() => location.reload()));
      }
    </script>`);
  });
  const appRoot = await listen(app);
  const warnings: string[] = [];
  context.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });

  try {
    await page.goto(appRoot);
    await page.waitForFunction(
      () => (window as Window & { ready?: boolean }).ready === true,
    );
    const results = await page.evaluate(async () => {
      async function read(headers: Record<string, string>) {
        const response = await fetch("https://origin.example/archive.zip", {
          headers,
        });
        return {
          status: response.status,
          contentRange: response.headers.get("content-range"),
          bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        };
      }
      return {
        // A suffix range is never CORS-safelisted, so this one preflights.
        suffix: await read({ Range: "bytes=-22" }),
        bounded: await read({ Range: "bytes=1000-1015" }),
        // Overlapping reads: with cacheable answers, Chromium's HTTP cache
        // used to narrow Range to the missing bytes while the alias kept the
        // original range, and spliced bodies shorter than Content-Range.
        overlapFirst: await read({ Range: "bytes=2000-2099" }),
        overlapShifted: await read({ Range: "bytes=2050-2149" }),
        overlapWider: await read({ Range: "bytes=2000-2199" }),
        // If-Range is never sent (the proxy's preflight would reject it);
        // the service worker applies it to the answer instead.
        currentIfRange: await read({ Range: "bytes=0-3", "If-Range": '"v1"' }),
        staleIfRange: await read({ Range: "bytes=0-3", "If-Range": '"v0"' }),
      };
    });

    expect(results.suffix).toEqual({
      status: 206,
      contentRange: "bytes 4074-4095/4096",
      bytes: Array.from(RANGED_ENTITY.subarray(4074)),
    });
    expect(results.bounded).toEqual({
      status: 206,
      contentRange: "bytes 1000-1015/4096",
      bytes: Array.from(RANGED_ENTITY.subarray(1000, 1016)),
    });
    // The resource is still "v1": the slice stands.
    expect(results.currentIfRange).toEqual({
      status: 206,
      contentRange: "bytes 0-3/4096",
      bytes: Array.from(RANGED_ENTITY.subarray(0, 4)),
    });
    // The client's copy is "v0": like a server whose If-Range condition is
    // false, the answer is the whole current representation.
    expect(results.staleIfRange).toEqual({
      status: 200,
      contentRange: null,
      bytes: Array.from(RANGED_ENTITY),
    });

    for (const [name, start, end] of [
      ["overlapFirst", 2000, 2099],
      ["overlapShifted", 2050, 2149],
      ["overlapWider", 2000, 2199],
    ] as const) {
      expect(results[name], name).toEqual({
        status: 206,
        contentRange: `bytes ${start}-${end}/4096`,
        bytes: Array.from(RANGED_ENTITY.subarray(start, end + 1)),
      });
    }

    const gets = observed.filter(({ method }) => method === "GET");
    // Every ranged request reached the proxy with Range and its alias equal,
    // and no If-Range ever went out: not the page's, and not one added by
    // the HTTP cache (aliased requests bypass it).
    expect(gets.map(({ headers }) => [
      headers.range,
      headers["x-cors-proxy-range"],
      headers["if-range"],
    ])).toEqual([
      ["bytes=-22", "bytes=-22", undefined],
      ["bytes=1000-1015", "bytes=1000-1015", undefined],
      ["bytes=2000-2099", "bytes=2000-2099", undefined],
      ["bytes=2050-2149", "bytes=2050-2149", undefined],
      ["bytes=2000-2199", "bytes=2000-2199", undefined],
      ["bytes=0-3", "bytes=0-3", undefined],
      ["bytes=0-3", "bytes=0-3", undefined],
      [undefined, undefined, undefined],
    ]);
    expect(observed.some(({ method }) => method === "OPTIONS")).toBe(true);
    // Playwright receives service-worker console messages only in Chromium,
    // so only there can this show If-Range was honored, not dropped.
    if (browserName === "chromium") {
      expect(warnings.filter((message) => message.includes("if-range")))
        .toEqual([]);
    }
  } finally {
    await Promise.all([close(app), close(proxy)]);
  }
});

test("guest curl reads a range through a production-shaped proxy", async ({
  page,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const targetRoot = proxyRoot.replace("127.0.0.1", "localtest.me");
  try {
    const curlBytes = Array.from(await readFile(curlPath));
    await page.goto("/pages/test-runner/?minimal=1", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    );
    const result = await page.evaluate(
      async ({ bytes, proxyUrl, proxyConfig, targetUrl }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          // Bytes 2040-2055 of the entity are the printable run " !"..."/",
          // so stdout can carry the slice itself, followed by the status.
          ["curl", "-sS", "-r", "2040-2055", "-w", "|%{http_code}", targetUrl],
          60_000,
          { corsProxy: { url: `${proxyUrl}/?`, ...proxyConfig } },
        ),
      {
        bytes: curlBytes,
        proxyUrl: proxyRoot,
        proxyConfig: EFFECTIVE_PROXY_CONFIG,
        targetUrl: `${targetRoot}/archive.zip`,
      },
    );

    expect(result.exitCode, JSON.stringify({ result, observed }, null, 2)).toBe(0);
    expect(result.stdout).toBe(
      `${RANGED_ENTITY.subarray(2040, 2056).toString("latin1")}|206`,
    );
    const proxied = observed.find(
      ({ method, url }) => method === "GET" && url.startsWith("/?"),
    );
    expect(proxied?.headers.range).toBe("bytes=2040-2055");
    expect(proxied?.headers["x-cors-proxy-range"]).toBe("bytes=2040-2055");

    // A resume whose stored ETag is stale gets the whole current file.
    observed.length = 0;
    const stale = await page.evaluate(
      async ({ bytes, proxyUrl, proxyConfig, targetUrl }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          ["curl", "-sS", "-r", "2040-2055", "-H", 'If-Range: "v0"',
            "-o", "/dev/null", "-w", "%{http_code} %{size_download}", targetUrl],
          60_000,
          { corsProxy: { url: `${proxyUrl}/?`, ...proxyConfig } },
        ),
      {
        bytes: curlBytes,
        proxyUrl: proxyRoot,
        proxyConfig: EFFECTIVE_PROXY_CONFIG,
        targetUrl: `${targetRoot}/archive.zip`,
      },
    );
    expect(stale.exitCode, JSON.stringify({ stale, observed }, null, 2)).toBe(0);
    expect(stale.stdout).toBe(`200 ${RANGED_ENTITY.byteLength}`);
    expect(
      observed.filter(({ method, url }) => method === "GET" && url.startsWith("/?"))
        .map(({ headers }) => [headers.range, headers["if-range"]]),
    ).toEqual([["bytes=2040-2055", undefined], [undefined, undefined]]);
  } finally {
    await close(proxy);
  }
});

test("guest HTTP uses the test runner's same-origin CORS proxy", async ({
  page,
}) => {
  const upstreamRequests: string[] = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Kandelo CORS proxy regression\n");
  });
  const upstreamRoot = await listen(upstream);

  try {
    // The guest's own 127.0.0.1 is its loopback, so it names the test's
    // server through a kernel DNS alias. The alias resolves to the server's
    // literal address, so the proxy's upstream fetch needs no name lookup:
    // the result cannot depend on the host's resolver, which can stall or
    // fail while the machine's network configuration changes.
    const upstreamName = "cors-proxy-upstream.test";
    const wgetBytes = Array.from(await readFile(wgetPath));

    await page.goto("/pages/test-runner/?minimal=1", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    );
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller),
      "the regression must exercise explicit BrowserKernel proxy configuration",
    ).toBeNull();

    const result = await page.evaluate(
      async ({ bytes, url, aliases }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          // -S and --content-on-error put the status line and an error body
          // in the failure message, so a failure names its cause.
          ["wget", "-S", "--content-on-error", "-O-", url],
          60_000,
          { dnsAliases: aliases },
        ),
      {
        bytes: wgetBytes,
        url: `http://${upstreamName}/probe`,
        aliases: { [upstreamName]: upstreamRoot },
      },
    );

    expect(
      result.exitCode,
      JSON.stringify({ result, upstreamRequests }, null, 2),
    ).toBe(0);
    expect(result.stdout).toBe("Kandelo CORS proxy regression\n");
    expect(upstreamRequests).toEqual(["/probe"]);
  } finally {
    await close(upstream);
  }
});

test("guest proxy fallback completes real preflight with name-only projection", async ({
  page,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const targetRoot = proxyRoot.replace("127.0.0.1", "localtest.me");
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /cors/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });

  try {
    const curlBytes = Array.from(await readFile(curlPath));
    await page.goto("/pages/test-runner/?minimal=1", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    );
    const result = await page.evaluate(
      async ({ bytes, proxyUrl, proxyConfig, targetUrl }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          [
            "curl",
            "-sS",
            "-H",
            "Git-Protocol: version=2",
            "-H",
            'Content-Type: application/json; profile="a very long arbitrary value preserved without interpretation"',
            "-H",
            "X-Arbitrary-Metadata: omitted",
            targetUrl,
          ],
          60_000,
          {
            corsProxy: {
              url: `${proxyUrl}/?`,
              ...proxyConfig,
            },
          },
        ),
      {
        bytes: curlBytes,
        proxyUrl: proxyRoot,
        proxyConfig: EFFECTIVE_PROXY_CONFIG,
        targetUrl: `${targetRoot}/direct-probe`,
      },
    );

    expect(result.exitCode, JSON.stringify({ result, observed }, null, 2)).toBe(
      0,
    );
    expect(result.stdout).toBe("constrained proxy response\n");
    expect(result.hostDiagnostics).toHaveLength(1);
    expect(result.hostDiagnostics[0]?.message).toContain(
      `Browser CORS proxy omitted unsupported request headers for ${targetRoot}:`,
    );
    expect(result.hostDiagnostics[0]?.message).toContain(
      "x-arbitrary-metadata",
    );
    const actual = observed.find(
      ({ method, url }) => method === "GET" && url.startsWith("/?"),
    );
    expect(observed.some(({ method }) => method === "OPTIONS")).toBe(true);
    expect(actual?.headers["git-protocol"]).toBe("version=2");
    expect(actual?.headers["content-type"]).toBe(
      'application/json; profile="a very long arbitrary value preserved without interpretation"',
    );
    expect(actual?.headers["x-arbitrary-metadata"]).toBeUndefined();
    expect(consoleErrors).toEqual([]);
  } finally {
    await close(proxy);
  }
});

test("guest proxy rejects lossy credentials and state-changing requests", async ({
  page,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const targetRoot = proxyRoot.replace("127.0.0.1", "localtest.me");
  try {
    const curlBytes = Array.from(await readFile(curlPath));
    await page.goto("/pages/test-runner/?minimal=1", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    );
    const run = (args: string[]) =>
      page.evaluate(
        async ({ bytes, argv, proxyUrl, proxyConfig }) =>
          (window as unknown as TestRunnerWindow).__runTest(
            new Uint8Array(bytes).buffer,
            argv,
            60_000,
            {
              corsProxy: {
                url: `${proxyUrl}/?`,
                ...proxyConfig,
              },
            },
          ),
        {
          bytes: curlBytes,
          argv: args,
          proxyUrl: proxyRoot,
          proxyConfig: EFFECTIVE_PROXY_CONFIG,
        },
      );
    const authorization = await run([
      "curl",
      "-sS",
      "-H",
      "Authorization: Bearer secret",
      `${targetRoot}/direct-auth`,
    ]);
    const post = await run([
      "curl",
      "-sS",
      "-X",
      "POST",
      "-H",
      "X-Arbitrary: reject",
      "--data-binary",
      "state-changing",
      `${targetRoot}/direct-post`,
    ]);

    expect(authorization.exitCode).not.toBe(0);
    expect(post.exitCode).not.toBe(0);
    expect(observed.filter(({ url }) => url.startsWith("/?"))).toEqual([]);
  } finally {
    await close(proxy);
  }
});

test("controlled guest curl POST goes direct and preserves the CORS boundary", async ({
  context,
  page,
  browserName,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const directObserved: ProxyRequest[] = [];
  const target = corsOpenTargetFixture(directObserved);
  const targetRoot = (await listen(target)).replace("127.0.0.1", "localtest.me");
  const relayedPosts: string[] = [];
  const serviceWorkerPosts: string[] = [];
  context.on("request", (request) => {
    if (request.method() === "POST" && request.serviceWorker()) {
      serviceWorkerPosts.push(request.url());
    }
    if (request.method() === "POST" && request.url().includes("/?")) {
      relayedPosts.push(request.url());
    }
  });
  try {
    const bytes = Array.from(await readFile(curlPath));
    await page.goto("/pages/test-runner/?minimal=1", { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/service-worker.js", {
        scope: "/", updateViaCache: "none",
      });
      await navigator.serviceWorker.ready;
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null
      && (window as unknown as TestRunnerWindow).__testRunnerReady === true);
    const run = (url: string) => page.evaluate(
      async ({ bytes, url }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          ["curl", "-sS", "-X", "POST", "--data-binary", "guest-body", url],
          60_000,
          { corsProxy: null },
        ),
      { bytes, url },
    );
    const open = await run(`${targetRoot}/guest-post`);
    expect(open.exitCode, JSON.stringify(open)).toBe(0);
    expect(open.stdout).toBe("cors-open target response\n");
    expect(directObserved.filter(({ method }) => method !== "OPTIONS")).toMatchObject([
      { method: "POST", url: "/guest-post", body: "guest-body" },
    ]);
    const blocked = await run(`${proxyRoot.replace("127.0.0.1", "localtest.me")}/cors-less`);
    expect(blocked.exitCode, JSON.stringify(blocked)).not.toBe(0);
    // The CORS-less server never authorizes the response. A simple request
    // reaches it and only its response is blocked; a preflighted request is
    // refused before the POST is sent. Either way nothing goes through the
    // relay.
    const posts = observed.filter(({ method }) => method === "POST");
    if (posts.length > 0) {
      expect(posts).toMatchObject([{ url: "/cors-less", body: "guest-body" }]);
    } else {
      expect(observed).toMatchObject([{ method: "OPTIONS", url: "/cors-less" }]);
    }
    expect(relayedPosts).toEqual([]);
    // Playwright attributes requests to the service worker that issued them
    // only in Chromium; other engines still prove the direct path above.
    if (browserName === "chromium") {
      expect(serviceWorkerPosts).toContain(`${targetRoot}/guest-post`);
      expect(serviceWorkerPosts).toContain(`${proxyRoot.replace("127.0.0.1", "localtest.me")}/cors-less`);
    }
  } finally {
    await Promise.all([close(proxy), close(target)]);
  }
});

test("controlled guest git clone preserves the reviewed HTTPS proxy POST", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  const gitBytes = Array.from(await readFile(resolveBinary("programs/git/git.wasm")));
  const helperBytes = Array.from(await readFile(resolveBinary("programs/git/git-remote-http.wasm")));
  const uploadPacks: string[] = [];
  context.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("__kandelo_cors_proxy")
      && request.url().includes("git-upload-pack")) uploadPacks.push(request.url());
  });
  await page.goto("/pages/test-runner/?minimal=1", { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null
    && (window as unknown as TestRunnerWindow).__testRunnerReady === true);
  const result = await page.evaluate(async ({ gitBytes, helperBytes }) =>
    (window as unknown as TestRunnerWindow).__runTest(
      new Uint8Array(gitBytes).buffer,
      ["git", "clone", "--depth=1", "https://github.com/Automattic/page-optimize.git", "/tmp/clone"],
      120_000,
      {
        env: ["PATH=/bin:/usr/bin", "HOME=/tmp", "GIT_EXEC_PATH=/usr/libexec/git-core", "GIT_TERMINAL_PROMPT=0"],
        dataFiles: [
          { path: "/usr/bin/git", data: gitBytes },
          { path: "/usr/libexec/git-core/git", data: gitBytes },
          { path: "/usr/libexec/git-core/git-remote-http", data: helperBytes },
          { path: "/usr/libexec/git-core/git-remote-https", data: helperBytes },
        ],
      },
    ), { gitBytes, helperBytes });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(uploadPacks.length).toBeGreaterThan(0);
});
