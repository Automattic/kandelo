import { expect, test, type Page, type Worker } from "@playwright/test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { DEFAULT_BROWSER_CORS_PROXY_CONFIG } from "../lib/browser-cors-proxy";

// The service worker's credential gate (docs/browser-support.md, "Per-process
// credential grants"). The kernel worker is the first gate: it adds
// credentials, the proxy's opt-in and the grant's tag only for a process the
// user granted. The service worker is a second, independent gate at the
// browser's network edge: it refuses every request to the proxy that carries
// credentials or the opt-in without a tag the owning kernel worker vouches
// for, and it removes the tag before the request leaves the browser.
//
// The deployment's proxy is what the service worker gates, so this file runs
// its own Vite server whose injected proxy is a local fake that records what
// reaches it (VITE_CORS_PROXY_URL, as a production build would configure).

test.describe.configure({ mode: "serial" });
test.use({ serviceWorkers: "allow" });

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESTINATION = "https://credential-gate.test";
const GUEST_AUTHORIZATION = "Bearer guest-secret-credential";
const TAG_HEADER = "x-kandelo-credential-grant";
const OPT_IN_HEADER = "x-cors-proxy-allowed-request-headers";
const DECLARATION_PATH = "/etc/kandelo/credential-requests.d/curl.json";

interface ProxyRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  hostDiagnostics: Array<{ message: string }>;
  credentialRequests: Array<{ pid: number; program: string; destinations: string[] }>;
}

type TestRunnerWindow = Window & {
  __testRunnerReady: boolean;
  __runTest(
    wasmBytes: ArrayBuffer,
    argv: string[],
    timeoutMs: number,
    options?: {
      dataFiles?: Array<{ path: string; data: number[] }>;
      corsProxy?: {
        url: string;
        allowedRequestHeaderNames: readonly string[];
        allowAnonymousGetHeaderOmission: boolean;
        rangeRequestHeaderAlias?: string;
      };
      credentialRequests?: "allow" | "deny";
    },
  ): Promise<RunResult>;
  __credentialGateRun?: Promise<RunResult>;
};

const observed: ProxyRequest[] = [];
const held = new Map<string, () => void>();
let proxy: Server;
let proxyUrl = "";
let vite: ViteDevServer;
let origin = "";

function listen(server: Server): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolvePromise(`http://127.0.0.1:${port}`);
    });
  });
}

function proxied(path: string): ProxyRequest | undefined {
  return observed.find((request) =>
    request.method !== "OPTIONS" && request.url === `/?${DESTINATION}${path}`
  );
}

test.beforeAll(async () => {
  observed.length = 0;
  held.clear();
  // A permissive stand-in for the Playground/Spacefast proxy protocol: it
  // allows whatever the preflight asks for, so only the service worker
  // decides what reaches it. Paths under /held/ wait for the test.
  proxy = createServer((request, response) => {
    const requestOrigin = request.headers.origin ?? "*";
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": requestOrigin,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers":
          request.headers["access-control-request-headers"] ?? "",
        Vary: "Origin",
      });
      response.end();
      return;
    }
    observed.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
    });
    const answer = () => {
      if (response.headersSent) return;
      response.writeHead(200, {
        "Access-Control-Allow-Origin": requestOrigin,
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Type": "text/plain",
        Vary: "Origin",
      });
      response.end(`proxied ${request.url}\n`);
    };
    const path = request.url?.slice(`/?${DESTINATION}`.length) ?? "";
    if (path.startsWith("/held/")) held.set(path, answer);
    else answer();
  });
  proxyUrl = `${await listen(proxy)}/?`;

  const saved = {
    VITE_CORS_PROXY_URL: process.env.VITE_CORS_PROXY_URL,
    KANDELO_BROWSER_TEST_NO_HMR: process.env.KANDELO_BROWSER_TEST_NO_HMR,
  };
  process.env.VITE_CORS_PROXY_URL = proxyUrl;
  process.env.KANDELO_BROWSER_TEST_NO_HMR = "1";
  try {
    vite = await createViteServer({
      configFile: resolve(appRoot, "vite.config.ts"),
      root: appRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });
    await vite.listen();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  for (const answer of held.values()) answer();
  await vite?.close();
  proxy?.closeAllConnections();
  await new Promise<void>((resolvePromise) => proxy.close(() => resolvePromise()));
});

async function openControlledRunner(page: Page, runnerOrigin = origin): Promise<void> {
  await page.goto(`${runnerOrigin}/pages/test-runner/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/service-worker.js", { scope: "/", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.waitForFunction(
    () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    null,
    { timeout: 60_000 },
  );
}

/** Fetch from the page, as any script in the app's origin could. */
function pageFetch(
  page: Page,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return page.evaluate(async ({ url, headers }) => {
    const response = await fetch(url, { headers });
    return { status: response.status, body: await response.text() };
  }, { url, headers });
}

/** Fetch from inside the kernel worker, as the kernel's own code would. */
function kernelWorkerFetch(
  worker: Worker,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return worker.evaluate(async ({ url, headers }) => {
    const response = await fetch(url, { headers });
    return { status: response.status, body: await response.text() };
  }, { url, headers });
}

/**
 * Start `/usr/bin/curl <args>` (through dash) in a fresh machine whose image
 * declares curl for DESTINATION and whose runner allows the prompt. Resolves
 * to the run's result as JSON, or to the error text.
 * `corsProxyUrl` null keeps the runner's own (same-origin development) proxy.
 */
async function startGrantedCurl(
  page: Page,
  args: string,
  corsProxyUrl: string | null,
): Promise<string> {
  const [dash, curl] = await Promise.all([
    readFile(resolveBinary("programs/dash.wasm")),
    readFile(resolveBinary("programs/curl.wasm")),
  ]);
  const declaration = JSON.stringify({
    program: "/usr/bin/curl",
    title: "curl (credential gate test)",
    destinations: [DESTINATION],
    launch: "wait",
  });
  await page.evaluate(({ dash, curl, declaration, declarationPath, args, corsProxy }) => {
    const runner = window as unknown as TestRunnerWindow;
    runner.__credentialGateRun = runner.__runTest(
      new Uint8Array(dash).buffer,
      ["sh", "-c", `/usr/bin/curl -sS ${args}`],
      120_000,
      {
        dataFiles: [
          { path: "/usr/bin/curl", data: curl },
          { path: declarationPath,
            data: Array.from(new TextEncoder().encode(declaration)) },
        ],
        ...(corsProxy === null ? {} : { corsProxy }),
        credentialRequests: "allow",
      },
    );
  }, {
    dash: Array.from(dash),
    curl: Array.from(curl),
    declaration,
    declarationPath: DECLARATION_PATH,
    args,
    corsProxy: corsProxyUrl === null ? null : {
      allowedRequestHeaderNames: [...DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowedRequestHeaderNames],
      allowAnonymousGetHeaderOmission: DEFAULT_BROWSER_CORS_PROXY_CONFIG.allowAnonymousGetHeaderOmission,
      rangeRequestHeaderAlias: DEFAULT_BROWSER_CORS_PROXY_CONFIG.rangeRequestHeaderAlias,
      url: corsProxyUrl,
    },
  });
  return page.evaluate(() =>
    (window as unknown as TestRunnerWindow).__credentialGateRun!.then(
      (result) => JSON.stringify(result),
      (error) => String(error),
    )
  );
}

test("page scripts cannot send credentials or a grant tag through the proxy", async ({ page }) => {
  await openControlledRunner(page);
  const attempts: Array<[string, string, Record<string, string>]> = [
    ["credential and opt-in", `${proxyUrl}${DESTINATION}/page/1`,
      { Authorization: "Bearer page", "X-Cors-Proxy-Allowed-Request-Headers": "Authorization" }],
    ["credential alone", `${proxyUrl}${DESTINATION}/page/2`, { Authorization: "Bearer page" }],
    ["opt-in alone", `${proxyUrl}${DESTINATION}/page/3`,
      { "X-Cors-Proxy-Allowed-Request-Headers": "Authorization" }],
    ["account id", `${proxyUrl}${DESTINATION}/page/4`, { "ChatGPT-Account-ID": "account" }],
    ["forged tag", `${proxyUrl}${DESTINATION}/page/5`,
      { Authorization: "Bearer page", "X-Kandelo-Credential-Grant": "forged-page-tag" }],
    // The service worker wraps a cross-origin GET in the proxy itself.
    ["wrapped credential", `${DESTINATION}/page/6`, { Authorization: "Bearer page" }],
    // A tag is meaningful only on the way to the configured proxy.
    ["tag elsewhere", `${DESTINATION}/page/7`, { "X-Kandelo-Credential-Grant": "forged-page-tag" }],
  ];
  for (const [label, url, headers] of attempts) {
    const result = await pageFetch(page, url, headers);
    expect(result.status, `${label}: ${result.body}`).toBe(403);
    expect(result.body, label).not.toContain("forged-page-tag");
  }
  expect(observed.filter(({ url }) => url.includes("/page/"))).toEqual([]);
});

test("a granted guest request reaches the proxy without its tag, across a fresh service worker", async ({ page }) => {
  test.setTimeout(180_000);
  await openControlledRunner(page);

  // Watch the kernel worker's own fetches: the tag the kernel attached, and
  // its answers to the service worker's verification requests.
  let kernelWorker: Worker | null = null;
  page.on("worker", (worker) => {
    if (!/browser-kernel-worker-entry/.test(worker.url())) return;
    kernelWorker = worker;
    void worker.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __gateTags?: string[];
        __gateReplies?: number;
      };
      scope.__gateTags = [];
      scope.__gateReplies = 0;
      const original = globalThis.fetch;
      globalThis.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("__kandelo_credential_grant_reply")) scope.__gateReplies! += 1;
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const tag = headers.get("x-kandelo-credential-grant");
        if (tag !== null) scope.__gateTags!.push(tag);
        return original.call(this, input, init);
      } as typeof fetch;
    }).catch(() => {});
  });

  const runFailure = startGrantedCurl(
    page,
    // One curl process makes both requests, so both use one grant. --rate
    // spaces their starts 15 s apart, which leaves time to replace the
    // service worker between them.
    `--rate 4/m -H 'Authorization: ${GUEST_AUTHORIZATION}' ` +
      `-w ' %{http_code}\\n' ${DESTINATION}/held/one ${DESTINATION}/held/two`,
    proxyUrl,
  );
  const waitForProxied = async (path: string) => {
    await expect.poll(() => proxied(path) !== undefined || held.has(path), {
      timeout: 90_000,
      message: `waiting for ${path} at the proxy`,
    }).toBe(true);
  };

  await Promise.race([
    waitForProxied("/held/one"),
    runFailure.then((result) => { throw new Error(`guest finished first: ${result}`); }),
  ]);
  const first = proxied("/held/one")!;
  expect(first.headers.authorization).toBe(GUEST_AUTHORIZATION);
  expect(first.headers[OPT_IN_HEADER]).toBe("Authorization");
  expect(first.headers[TAG_HEADER]).toBeUndefined();

  expect(kernelWorker).not.toBeNull();
  const tags = await kernelWorker!.evaluate(() =>
    (globalThis as typeof globalThis & { __gateTags?: string[] }).__gateTags ?? []
  );
  expect(tags.length).toBeGreaterThan(0);
  const tag = tags[0];
  const tagged = {
    Authorization: "Bearer copied",
    "X-Cors-Proxy-Allowed-Request-Headers": "Authorization",
    "X-Kandelo-Credential-Grant": tag,
  };
  // The live grant's own tag, copied into a page script's request.
  const copied = await pageFetch(page, `${proxyUrl}${DESTINATION}/page/copied-1`, tagged);
  expect(copied.status, copied.body).toBe(403);
  expect(copied.body).not.toContain(tag);
  held.get("/held/one")!();

  // Replace the service worker. registration.update() keeps a byte-identical
  // worker, so register the same source under a new script URL; the new
  // worker claims the page and the running kernel worker, and starts with an
  // empty in-memory gate.
  const replacement = await page.evaluate(async () => {
    const changed = new Promise<string>((resolvePromise) =>
      navigator.serviceWorker.addEventListener("controllerchange", () =>
        resolvePromise(navigator.serviceWorker.controller!.scriptURL), { once: true }));
    await navigator.serviceWorker.register("/service-worker.js?fresh=1", {
      scope: "/",
      updateViaCache: "none",
    });
    return changed;
  });
  expect(replacement).toContain("fresh=1");

  await waitForProxied("/held/two");
  const second = proxied("/held/two")!;
  expect(second.headers.authorization).toBe(GUEST_AUTHORIZATION);
  expect(second.headers[OPT_IN_HEADER]).toBe("Authorization");
  expect(second.headers[TAG_HEADER]).toBeUndefined();
  // Each service worker asked the kernel worker once.
  expect(await kernelWorker!.evaluate(() =>
    (globalThis as typeof globalThis & { __gateReplies?: number }).__gateReplies ?? 0
  )).toBe(2);

  // The fresh worker has bound the tag to the kernel worker; a page script
  // still cannot use it.
  const copiedAgain = await pageFetch(page, `${proxyUrl}${DESTINATION}/page/copied-2`, tagged);
  expect(copiedAgain.status, copiedAgain.body).toBe(403);
  // Even from the kernel worker itself, the tag covers only its destinations,
  // an unknown tag is refused, and credentials need a tag.
  const otherOrigin = await kernelWorkerFetch(kernelWorker!, `${proxyUrl}https://other.test/page/origin`, tagged);
  expect(otherOrigin.status, otherOrigin.body).toBe(403);
  const unknown = await kernelWorkerFetch(kernelWorker!, `${proxyUrl}${DESTINATION}/page/unknown`, {
    ...tagged,
    "X-Kandelo-Credential-Grant": "unknown-tag-value",
  });
  expect(unknown.status, unknown.body).toBe(403);
  const untagged = await kernelWorkerFetch(kernelWorker!, `${proxyUrl}${DESTINATION}/page/untagged`, {
    Authorization: "Bearer untagged",
  });
  expect(untagged.status, untagged.body).toBe(403);
  held.get("/held/two")!();

  const result = JSON.parse(await runFailure) as RunResult;
  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stdout).toBe(
    `proxied /?${DESTINATION}/held/one\n 200\nproxied /?${DESTINATION}/held/two\n 200\n`,
  );
  expect(result.credentialRequests).toEqual([
    { pid: expect.any(Number), program: "/usr/bin/curl", destinations: [DESTINATION] },
  ]);
  expect(observed.filter(({ url }) => url.includes("/page/"))).toEqual([]);
  expect(observed.filter(({ headers }) => headers[TAG_HEADER] !== undefined)).toEqual([]);
});

test("only the kernel worker's own script can present and vouch for a tag", async ({ page }) => {
  // A worker from any other same-origin script can read the gate's
  // broadcast and answer its own question. The service worker must not ask
  // it at all.
  const directory = resolve(appRoot, "../../target/browser-test-runs", `credential-gate-${randomUUID()}`);
  const script = resolve(directory, "rogue-worker.js");
  await mkdir(directory, { recursive: true });
  await writeFile(script, `
    const replies = [];
    const channel = new BroadcastChannel("kandelo-credential-grants");
    channel.onmessage = (event) => {
      const message = event.data;
      if (!message || message.type !== "credential-grant-verify") return;
      fetch(message.replyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "credential-grant-verified", id: message.id, valid: true }),
      }).then((response) => replies.push(response.status));
    };
    self.onmessage = async (event) => {
      const response = await fetch(event.data.url, { headers: event.data.headers });
      self.postMessage({ status: response.status, body: await response.text(), replies });
    };
  `);
  try {
    await openControlledRunner(page);
    const result = await page.evaluate(async ({ workerUrl, url }) => {
      const worker = new Worker(workerUrl, { type: "module" });
      return new Promise<{ status: number; body: string; replies: number[] }>((resolvePromise, reject) => {
        worker.onmessage = (event) => resolvePromise(event.data);
        worker.onerror = (event) => reject(new Error(String(event.message)));
        worker.postMessage({
          url,
          headers: {
            Authorization: "Bearer rogue",
            "X-Cors-Proxy-Allowed-Request-Headers": "Authorization",
            "X-Kandelo-Credential-Grant": "rogue-tag",
          },
        });
      });
    }, { workerUrl: `/@fs${script}`, url: `${proxyUrl}${DESTINATION}/page/rogue` });
    expect(result.status, result.body).toBe(403);
    expect(result.replies).toEqual([]);
    expect(proxied("/page/rogue")).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("proxied third-party bytes never load as a script, worker or document", async ({ browser, page }) => {
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, {
      "Content-Type": "text/javascript",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    response.end("self.__proxiedRan = true; try { self.postMessage('ran'); } catch {}");
  });
  const upstreamRoot = await listen(upstream);
  const devRelay = `/__kandelo_cors_proxy?url=${encodeURIComponent(`${upstreamRoot}/evil.js`)}`;
  const tryLoads = (target: Page) => target.evaluate(async ({ remote, devRelay }) => {
    const scope = window as Window & { __proxiedRan?: boolean };
    const script = await new Promise<string>((resolvePromise) => {
      const element = document.createElement("script");
      element.src = remote;
      element.onload = () => resolvePromise("loaded");
      element.onerror = () => resolvePromise("error");
      document.head.append(element);
    });
    const worker = await new Promise<string>((resolvePromise) => {
      try {
        const started = new Worker(devRelay);
        started.onmessage = () => resolvePromise("ran");
        started.onerror = () => resolvePromise("error");
        setTimeout(() => resolvePromise("silent"), 3000);
      } catch (error) {
        resolvePromise(`threw ${error}`);
      }
    });
    return { script, worker, ran: scope.__proxiedRan === true };
  }, { remote: `${proxyUrl}${upstreamRoot}/evil.js`, devRelay });

  try {
    // Controlled by the service worker, which refuses both loads.
    await openControlledRunner(page);
    const controlled = await tryLoads(page);
    expect(controlled.ran, JSON.stringify(controlled)).toBe(false);
    expect(controlled.worker).not.toBe("ran");
    expect(observed.filter(({ url }) => url.includes("/evil.js"))).toEqual([]);
    expect(upstreamRequests).toBe(0);

    // Without the service worker, the development relay refuses the worker
    // load itself, and marks what it does relay as inert data.
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const uncontrolled = await context.newPage();
      await uncontrolled.goto(`${origin}/pages/test-runner/`, { waitUntil: "domcontentloaded" });
      expect(await uncontrolled.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
      const worker = await uncontrolled.evaluate(async (devRelay) =>
        new Promise<string>((resolvePromise) => {
          const started = new Worker(devRelay);
          started.onmessage = () => resolvePromise("ran");
          started.onerror = () => resolvePromise("error");
          setTimeout(() => resolvePromise("silent"), 3000);
        }), devRelay);
      expect(worker).not.toBe("ran");
      expect(upstreamRequests).toBe(0);
      const data = await uncontrolled.evaluate(async (devRelay) => {
        const response = await fetch(devRelay);
        return {
          status: response.status,
          csp: response.headers.get("content-security-policy"),
          nosniff: response.headers.get("x-content-type-options"),
        };
      }, devRelay);
      expect(data).toEqual({ status: 200, csp: "sandbox", nosniff: "nosniff" });
      expect(upstreamRequests).toBe(1);
    } finally {
      await context.close();
    }
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
  }
});

test("a granted POST through the same-origin development relay is gated, then passed on without its tag", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  // The Playwright server's service worker uses the development relay as its
  // configured proxy, so the same-origin gate branch applies.
  const runnerOrigin = new URL(baseURL!).origin;
  await openControlledRunner(page, runnerOrigin);
  const relay = `${runnerOrigin}/__kandelo_cors_proxy?url=`;
  for (const headers of [
    { Authorization: "Bearer page" },
    { Authorization: "Bearer page", "X-Kandelo-Credential-Grant": "forged" },
  ]) {
    const refused = await page.evaluate(async ({ url, headers }) => {
      const response = await fetch(url, { method: "POST", headers, body: "payload" });
      return { status: response.status, body: await response.text() };
    }, { url: `${relay}${DESTINATION}/page/post`, headers });
    expect(refused.status, refused.body).toBe(403);
    expect(refused.body).toContain("Kandelo refused this request");
  }

  // The granted guest POST passes the gate. The development relay then
  // answers it with its own refusal (it relays POST only for Git), which
  // proves the service worker sent it on.
  const result = JSON.parse(await startGrantedCurl(
    page,
    `-X POST -d payload -H 'Authorization: ${GUEST_AUTHORIZATION}' -w ' %{http_code}' ${DESTINATION}/post`,
    null,
  )) as RunResult;
  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stdout).toBe("POST target is outside the Git upload-pack boundary 403");
  expect(result.credentialRequests).toHaveLength(1);
});
