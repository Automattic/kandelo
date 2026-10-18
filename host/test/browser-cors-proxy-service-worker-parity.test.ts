import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BROWSER_CONTROLLED_REQUEST_HEADER_NAMES,
  ifRangeMatches,
} from "../src/networking/browser-cors-proxy";

// The CORS proxy request-header projection is implemented twice: once in TS
// (browser-cors-proxy.ts, used by the guest-socket backends) and once in plain
// JS inside the service worker, which cannot import the TS module. The two must
// classify browser-controlled request headers identically or a request the
// backend accepts can still be rejected at the service-worker boundary (or vice
// versa). This test fails loudly if the hand-maintained copies drift.

const serviceWorkerSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../apps/browser-demos/public/service-worker.js",
      import.meta.url,
    ),
  ),
  "utf8",
);

function serviceWorkerBrowserControlledNames(): Set<string> {
  const match = serviceWorkerSource.match(
    /BROWSER_CONTROLLED_REQUEST_HEADER_NAMES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
  );
  if (!match) {
    throw new Error(
      "service-worker.js no longer declares BROWSER_CONTROLLED_REQUEST_HEADER_NAMES as a Set literal; update this parity test",
    );
  }
  const names = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return new Set(names);
}

describe("browser CORS proxy service-worker parity", () => {
  it("shares the exact browser-controlled request-header set with the service worker", () => {
    const swNames = serviceWorkerBrowserControlledNames();
    expect([...swNames].sort()).toEqual(
      [...BROWSER_CONTROLLED_REQUEST_HEADER_NAMES].sort(),
    );
  });

  it("applies the same proxy-/sec- prefix rule in both implementations", () => {
    // The TS side treats proxy-* and sec-* as browser-controlled via
    // startsWith; the service worker must use the same prefixes.
    expect(serviceWorkerSource).toMatch(/indexOf\("proxy-"\)\s*===\s*0/);
    expect(serviceWorkerSource).toMatch(/indexOf\("sec-"\)\s*===\s*0/);
  });

  it("mirrors a forwarded Range into the configured alias like project()", () => {
    // Behavior is proven in a real browser by browser-cors-proxy.spec.ts;
    // this guards that the hand-maintained copy still reads the same field.
    expect(serviceWorkerSource).toMatch(
      /config\.rangeRequestHeaderAlias && range !== null[\s\S]{0,80}headers\.set\(config\.rangeRequestHeaderAlias, range\)/,
    );
  });

  it("decides If-Range matches exactly like ifRangeMatches()", () => {
    const start = serviceWorkerSource.indexOf("function ifRangeMatches(");
    const end = serviceWorkerSource.indexOf("\n  }\n", start);
    expect(start).toBeGreaterThan(-1);
    const serviceWorkerIfRangeMatches = new Function(
      `${serviceWorkerSource.slice(start, end + 4)}; return ifRangeMatches;`,
    )() as (ifRange: string, headers: Headers) => boolean;
    const date = "Sun, 28 Sep 2026 12:00:10 GMT";
    const modified = "Sun, 28 Sep 2026 12:00:00 GMT";
    const cases: Array<[string, Record<string, string>]> = [
      ['"v1"', { ETag: '"v1"' }],
      ['"v1"', { ETag: '"v2"' }],
      ['"v1"', { ETag: 'W/"v1"' }],
      ['W/"v1"', { ETag: 'W/"v1"' }],
      ['"v1"', {}],
      [modified, { "Last-Modified": modified, Date: date }],
      [modified, { "Last-Modified": modified }],
      [modified, { "Last-Modified": modified, Date: modified }],
      [modified, { "Last-Modified": date, Date: date }],
    ];
    for (const [ifRange, headers] of cases) {
      expect(serviceWorkerIfRangeMatches(ifRange, new Headers(headers)))
        .toBe(ifRangeMatches(ifRange, new Headers(headers)));
    }
  });

  it("checks credential headers before the browser-controlled drop in the service worker", () => {
    // proxy-authorization matches the proxy- prefix, so the credential check
    // must run first or credentials would be silently dropped instead of
    // failing loudly. Assert the credential branch precedes the managed drop.
    const credentialIndex = serviceWorkerSource.indexOf('"proxy-authorization"');
    const managedIndex = serviceWorkerSource.indexOf(
      "isBrowserManagedRequestHeader(lower)",
    );
    expect(credentialIndex).toBeGreaterThan(-1);
    expect(managedIndex).toBeGreaterThan(-1);
    expect(credentialIndex).toBeLessThan(managedIndex);
  });
});

interface SentRequest {
  url: string;
  method: string;
  cache: RequestCache;
  headers: Record<string, string>;
}

// Run the service worker's own proxy-dispatch code, not a copy: the section
// from the injected profile through fetchThroughCorsProxy, with a fake fetch.
function serviceWorkerDispatch(answer: (sent: SentRequest) => Response) {
  const start = serviceWorkerSource.indexOf(
    'var CORS_PROXY_CONFIG = "__CORS_PROXY_CONFIG__";',
  );
  const end = serviceWorkerSource.indexOf(
    "  /**\n   * Check if a URL is cross-origin",
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const section = serviceWorkerSource.slice(start, end).replace(
    '"__CORS_PROXY_CONFIG__"',
    JSON.stringify({
      url: "https://proxy.example/?",
      allowedRequestHeaderNames: ["accept", "content-type", "range"],
      allowAnonymousGetHeaderOmission: true,
      rangeRequestHeaderAlias: "x-cors-proxy-range",
    }),
  );
  const warnings: string[] = [];
  const sent: SentRequest[] = [];
  const fakeFetch = async (request: Request) => {
    const record = {
      url: request.url,
      method: request.method,
      cache: request.cache,
      headers: Object.fromEntries(request.headers.entries()),
    };
    sent.push(record);
    return answer(record);
  };
  const dispatch = new Function(
    "self",
    "console",
    "fetch",
    `${section}; return fetchThroughCorsProxy;`,
  )(
    { location: { href: "https://kandelo.test/" } },
    { warn: (message: string) => warnings.push(message) },
    fakeFetch,
  ) as (request: Request, outgoingUrl: string, targetUrl: string) => Promise<Response>;
  return { dispatch, sent, warnings };
}

const TARGET = "https://origin.example/archive.zip";
const PROXIED = `https://proxy.example/?${TARGET}`;

function partial(etag: string) {
  return () =>
    new Response("0123", {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/16", ETag: etag },
    });
}

describe("service worker proxy dispatch", () => {
  it("accepts the kernel worker's already-projected alias without a diagnostic", async () => {
    // Guest traffic reaches the proxy URL projected by BrowserCorsProxy, and
    // a controlled kernel worker's fetch passes through this service worker.
    for (const method of ["GET", "POST"]) {
      const { dispatch, sent, warnings } = serviceWorkerDispatch(partial('"v1"'));
      const response = await dispatch(
        new Request(PROXIED, {
          method,
          headers: { Range: "bytes=0-3", "X-Cors-Proxy-Range": "bytes=0-3" },
          ...(method === "POST" ? { body: "x" } : {}),
        }),
        PROXIED,
        TARGET,
      );
      expect(response.status).toBe(206);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers["x-cors-proxy-range"]).toBe("bytes=0-3");
      expect(warnings).toEqual([]);
    }
  });

  it("re-derives a caller's alias from Range rather than relaying it", async () => {
    const { dispatch, sent } = serviceWorkerDispatch(partial('"v1"'));
    await dispatch(
      new Request(TARGET, {
        headers: { Range: "bytes=0-3", "X-Cors-Proxy-Range": "bytes=8-9" },
      }),
      PROXIED,
      TARGET,
    );
    expect(sent[0]!.headers["x-cors-proxy-range"]).toBe("bytes=0-3");
  });

  it("keeps aliased requests out of the HTTP cache, and only those", async () => {
    const { dispatch, sent } = serviceWorkerDispatch(partial('"v1"'));
    await dispatch(new Request(TARGET, { headers: { Range: "bytes=0-3" } }), PROXIED, TARGET);
    await dispatch(new Request(TARGET), PROXIED, TARGET);
    expect(sent.map(({ cache }) => cache)).toEqual(["no-store", "default"]);
  });

  it.each<[string, Record<string, string> | Array<[string, string]>, () => Response]>([
    ["a stale If-Range", { Range: "bytes=0-3", "If-Range": '"v0"' }, partial('"v1"')],
    [
      "a 416 for a resource that changed",
      { Range: "bytes=4000-", "If-Range": '"v0"' },
      () => new Response(null, { status: 416, headers: { "Content-Range": "bytes */16" } }),
    ],
    [
      "several If-Range fields",
      [["Range", "bytes=0-3"], ["If-Range", '"v1"'], ["If-Range", '"v1"']],
      partial('"v1"'),
    ],
  ])("fetches the whole representation for %s", async (_label, headers, answer) => {
    const { dispatch, sent } = serviceWorkerDispatch((request) =>
      request.headers.range === undefined
        ? new Response("0123456789abcdef", { status: 200, headers: { ETag: '"v1"' } })
        : answer()
    );
    const response = await dispatch(new Request(TARGET, { headers }), PROXIED, TARGET);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers.range).toBeUndefined();
    expect(sent[1]!.headers["x-cors-proxy-range"]).toBeUndefined();
    expect(sent[1]!.cache).toBe("default");
    for (const request of sent) expect(request.headers["if-range"]).toBeUndefined();
  });

  it("keeps a 416 whose validator still matches", async () => {
    const { dispatch, sent } = serviceWorkerDispatch(() =>
      new Response(null, { status: 416, headers: { ETag: '"v1"' } })
    );
    const response = await dispatch(
      new Request(TARGET, { headers: { Range: "bytes=4000-", "If-Range": '"v1"' } }),
      PROXIED,
      TARGET,
    );
    expect(response.status).toBe(416);
    expect(sent).toHaveLength(1);
  });
});
