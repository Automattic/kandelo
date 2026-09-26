import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";

const curlPath = resolveBinary("programs/curl.wasm");
const wgetPath = resolveBinary("programs/wget.wasm");
const serviceWorkerPath = fileURLToPath(
  new URL("../public/service-worker.js", import.meta.url),
);

const ALLOWED_PREFLIGHT_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "git-protocol",
  "wp_blog",
  "wp_install",
  "x-cors-proxy-allowed-request-headers",
  "x-cors-proxy-content-type",
].join(", ");

const EFFECTIVE_PROXY_CONFIG = {
  allowedRequestHeaderNames: [
    "accept",
    "content-type",
    "git-protocol",
    "if-range",
    "range",
    "wp_blog",
    "wp_install",
  ],
  allowAnonymousGetHeaderOmission: true,
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
      corsProxy?: {
        url: string;
        allowedRequestHeaderNames: string[];
        allowAnonymousGetHeaderOmission: boolean;
      };
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
    response.writeHead(200, {
      ...(proxied ? { "Access-Control-Allow-Origin": origin } : {}),
      "Content-Type": "text/plain",
      "Cross-Origin-Resource-Policy": "cross-origin",
      Vary: "Origin",
    });
    response.end("constrained proxy response\n");
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
  expect(source).toContain(
    '"allowedRequestHeaderNames":["accept","content-type","git-protocol","if-range","range","wp_blog","wp_install"]',
  );
  expect(source).toContain('"allowAnonymousGetHeaderOmission":true');
});

test("service worker projects both configured proxy boundaries", async ({
  context,
  page,
}) => {
  const observed: ProxyRequest[] = [];
  const proxy = constrainedProxyFixture(observed);
  const proxyRoot = await listen(proxy);
  const rawServiceWorker = await readFile(serviceWorkerPath, "utf8");
  const config = {
    url: `${proxyRoot}/?`,
    ...EFFECTIVE_PROXY_CONFIG,
  };
  const serviceWorker = rawServiceWorker.replace(
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
  const warnings: string[] = [];
  const corsErrors: string[] = [];
  context.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
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
      async ({ proxyUrl }) => {
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
        return {
          browserOwned,
          alreadyWrapped,
          allowedPost,
          rejected,
          beforeRejected,
        };
      },
      { proxyUrl: proxyRoot },
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
    await Promise.all([close(app), close(proxy)]);
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
    await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
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

test("guest HTTP uses the test runner's same-origin CORS proxy", async ({
  page,
}) => {
  const upstreamRequests: string[] = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Kandelo CORS proxy regression\n");
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "::1", () => {
      upstream.off("error", reject);
      resolve();
    });
  });

  try {
    const { port } = upstream.address() as AddressInfo;
    // The trailing root dot avoids the guest's /etc/hosts localhost entry, so
    // Kandelo delegates the connection to its browser backend. Node still
    // resolves the proxy's upstream target to this test-only ::1 listener.
    const targetUrl = `http://localhost.:${port}/probe`;
    const wgetBytes = Array.from(await readFile(wgetPath));

    await page.goto("/pages/test-runner/", {
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
      async ({ bytes, url }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          ["wget", "-qO-", url],
          60_000,
        ),
      { bytes: wgetBytes, url: targetUrl },
    );

    expect(
      result.exitCode,
      JSON.stringify({ result, upstreamRequests }, null, 2),
    ).toBe(0);
    expect(result.stdout).toBe("Kandelo CORS proxy regression\n");
    expect(upstreamRequests).toEqual(["/probe"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
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
    await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
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
    await page.goto("/pages/test-runner/", { waitUntil: "domcontentloaded" });
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
