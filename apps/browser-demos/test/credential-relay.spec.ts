import { expect, test, type Page } from "@playwright/test";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type Plugin, type ViteDevServer } from "vite";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { DEVELOPMENT_CREDENTIAL_RELAY_ORIGINS } from "../lib/browser-cors-proxy";

// The development credential relay (docs/browser-support.md, "Development
// credential relay"). There is no approval page: a per-process credential
// grant is the only permission. The kernel worker adds a credential, the
// proxy opt-in and the grant's tag only for a granted process; the service
// worker verifies and removes the tag; the relay carries a credential only
// with the opt-in and refuses a request that still has a tag.
//
// This file runs its own Vite development server, so the relay is the one
// vite.config.ts wires up. The relay's upstream fetch runs in this process;
// the test answers requests to the relay's OpenAI origins itself, so no
// request leaves the machine.

test.describe.configure({ mode: "serial" });
test.use({ serviceWorkers: "allow" });

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESTINATION = "https://chatgpt.com";
const RELAY_PATH = "/__kandelo_credential_relay";
const GUEST_AUTHORIZATION = "Bearer guest-secret-credential";
const TAG_HEADER = "x-kandelo-credential-grant";
const OPT_IN_HEADER = "x-cors-proxy-allowed-request-headers";
const DECLARATION_PATH = "/etc/kandelo/credential-requests.d/curl.json";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
      credentialRequests?: "allow" | "deny";
    },
  ): Promise<RunResult>;
};

/** What reached the relay (before it answered). */
const atRelay: Seen[] = [];
/** What the relay sent upstream. */
const upstream: Seen[] = [];
let vite: ViteDevServer;
let origin = "";
const originalFetch = globalThis.fetch;

function relayUrl(path: string): string {
  return `${RELAY_PATH}?url=${encodeURIComponent(`${DESTINATION}${path}`)}`;
}

function seenAtRelay(path: string): Seen[] {
  return atRelay.filter(({ url }) => url === relayUrl(path));
}

function seenUpstream(path: string): Seen[] {
  return upstream.filter(({ url }) => url === `${DESTINATION}${path}`);
}

function plainHeaders(headers: IncomingMessage["headers"] | Headers): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, name) => { result[name] = value; });
  } else {
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) result[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return result;
}

test.beforeAll(async () => {
  atRelay.length = 0;
  upstream.length = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!DEVELOPMENT_CREDENTIAL_RELAY_ORIGINS.includes(url.origin)) {
      return originalFetch(input, init);
    }
    upstream.push({ method: init?.method ?? "GET", url: url.href, headers: plainHeaders(new Headers(init?.headers)) });
    return new Response(`upstream ${url.pathname}\n`, { headers: { "Content-Type": "text/plain" } });
  };
  // Observe, never answer: the relay vite.config.ts installs handles it.
  const observer: Plugin = {
    name: "credential-relay-observer",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url?.startsWith(RELAY_PATH)) {
          atRelay.push({ method: request.method ?? "", url: request.url, headers: plainHeaders(request.headers) });
        }
        next();
      });
    },
  };
  const saved = process.env.KANDELO_BROWSER_TEST_NO_HMR;
  const savedPreview = process.env.KANDELO_PREVIEW_ORIGIN;
  process.env.KANDELO_BROWSER_TEST_NO_HMR = "1";
  // This server's ephemeral port + 1 may belong to another server; it opens
  // no web previews, so it serves no preview origin.
  process.env.KANDELO_PREVIEW_ORIGIN = "off";
  try {
    vite = await createViteServer({
      configFile: resolve(appRoot, "vite.config.ts"),
      root: appRoot,
      logLevel: "silent",
      plugins: [observer],
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });
    await vite.listen();
  } finally {
    if (saved === undefined) delete process.env.KANDELO_BROWSER_TEST_NO_HMR;
    else process.env.KANDELO_BROWSER_TEST_NO_HMR = saved;
    if (savedPreview === undefined) delete process.env.KANDELO_PREVIEW_ORIGIN;
    else process.env.KANDELO_PREVIEW_ORIGIN = savedPreview;
  }
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  globalThis.fetch = originalFetch;
  await vite?.close();
});

async function openControlledRunner(page: Page): Promise<void> {
  await page.goto(`${origin}/pages/test-runner/`, { waitUntil: "domcontentloaded" });
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

function pageFetch(
  page: Page,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; csp: string | null; cookie: string | null }> {
  return page.evaluate(async ({ url, init }) => {
    const response = await fetch(url, init);
    return {
      status: response.status,
      body: await response.text(),
      csp: response.headers.get("content-security-policy"),
      cookie: response.headers.get("set-cookie"),
    };
  }, { url, init });
}

/**
 * Run `/usr/bin/curl <args>` (through dash) in a fresh machine whose image
 * declares curl for DESTINATION, answering its credential prompt with
 * `answer`. The runner's own configuration is the app's: the development
 * CORS proxy, with this relay for the OpenAI origins.
 */
async function runDeclaredCurl(page: Page, args: string, answer: "allow" | "deny"): Promise<RunResult> {
  const [dash, curl] = await Promise.all([
    readFile(resolveBinary("programs/dash.wasm")),
    readFile(resolveBinary("programs/curl.wasm")),
  ]);
  const declaration = JSON.stringify({
    program: "/usr/bin/curl",
    title: "curl (credential relay test)",
    destinations: [DESTINATION],
    launch: "wait",
  });
  const result = await page.evaluate(({ dash, curl, declaration, declarationPath, args, answer }) => {
    const runner = window as unknown as TestRunnerWindow;
    return runner.__runTest(
      new Uint8Array(dash).buffer,
      ["sh", "-c", `/usr/bin/curl -sS ${args}`],
      120_000,
      {
        dataFiles: [
          { path: "/usr/bin/curl", data: curl },
          { path: declarationPath, data: Array.from(new TextEncoder().encode(declaration)) },
        ],
        credentialRequests: answer,
      },
    ).then((value) => JSON.stringify(value), (error) => String(error));
  }, {
    dash: Array.from(dash),
    curl: Array.from(curl),
    declaration,
    declarationPath: DECLARATION_PATH,
    args,
    answer,
  });
  try {
    return JSON.parse(result) as RunResult;
  } catch {
    throw new Error(`guest run failed: ${result}`);
  }
}

test("the former approval page, status and consent endpoints do not exist", async ({ page }) => {
  for (const path of [RELAY_PATH, `${RELAY_PATH}/status`]) {
    const response = await page.request.get(`${origin}${path}`, { maxRedirects: 0 });
    expect(response.status(), path).toBe(404);
    expect(response.headers()["set-cookie"], path).toBeUndefined();
  }
  const consent = await page.request.post(`${origin}${RELAY_PATH}/consent`, {
    form: { decision: "allow" }, maxRedirects: 0,
  });
  expect(consent.status()).toBe(404);
  // Through the service worker, too.
  await openControlledRunner(page);
  const controlled = await pageFetch(page, RELAY_PATH);
  expect(controlled.status).toBe(404);
  expect(controlled.csp).toBe("sandbox");
  expect(upstream).toEqual([]);
});

test("page scripts cannot send credentials through the relay", async ({ page }) => {
  await openControlledRunner(page);
  const attempts: Array<[string, Record<string, string>]> = [
    ["credential", { Authorization: "Bearer page" }],
    ["credential and opt-in", { Authorization: "Bearer page", "X-Cors-Proxy-Allowed-Request-Headers": "Authorization" }],
    ["forged tag", {
      Authorization: "Bearer page",
      "X-Cors-Proxy-Allowed-Request-Headers": "Authorization",
      "X-Kandelo-Credential-Grant": "forged-page-tag",
    }],
    ["opt-in alone", { "X-Cors-Proxy-Allowed-Request-Headers": "Authorization" }],
    ["account id", { "ChatGPT-Account-ID": "account" }],
  ];
  for (const [index, [label, headers]] of attempts.entries()) {
    const result = await pageFetch(page, relayUrl(`/page/${index}`), { method: "POST", headers, body: "{}" });
    expect(result.status, `${label}: ${result.body}`).toBe(403);
    expect(result.body, label).toContain("Kandelo refused this request");
    expect(result.body, label).not.toContain("forged-page-tag");
  }
  // The service worker refused them all; none reached the relay.
  expect(atRelay.filter(({ url }) => url.includes(encodeURIComponent("/page/")))).toEqual([]);
  expect(upstream).toEqual([]);
});

test("without the service worker, the relay itself requires the opt-in and refuses a tag", async ({ browser }) => {
  // A forced reload, or any page the service worker does not control,
  // reaches the relay directly.
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/pages/test-runner/`, { waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
    const refused = await pageFetch(page, relayUrl("/direct/credential"), {
      method: "POST", headers: { Authorization: "Bearer direct" }, body: "{}",
    });
    expect(refused.status, refused.body).toBe(403);
    expect(refused.body).toContain("without the credential opt-in");
    expect(refused.csp).toBe("sandbox");
    const tagged = await pageFetch(page, relayUrl("/direct/tagged"), {
      method: "POST",
      headers: {
        Authorization: "Bearer direct",
        "X-Cors-Proxy-Allowed-Request-Headers": "Authorization",
        "X-Kandelo-Credential-Grant": "direct-tag",
      },
      body: "{}",
    });
    expect(tagged.status, tagged.body).toBe(403);
    expect(tagged.body).toContain("did not pass the service worker's credential gate");
    expect(tagged.body).not.toContain("direct-tag");
    expect(seenUpstream("/direct/credential")).toEqual([]);
    expect(seenUpstream("/direct/tagged")).toEqual([]);

    // The documented trusted-origin boundary: the relay cannot tell the
    // service worker from another script on the app's own origin that writes
    // the opt-in itself. It forwards that request.
    const optedIn = await pageFetch(page, relayUrl("/direct/opted-in"), {
      method: "POST",
      headers: { Authorization: "Bearer direct", "X-Cors-Proxy-Allowed-Request-Headers": "Authorization" },
      body: "{}",
    });
    expect(optedIn.status, optedIn.body).toBe(200);
    expect(seenUpstream("/direct/opted-in")[0]?.headers.authorization).toBe("Bearer direct");
  } finally {
    await context.close();
  }
});

test("a granted guest process reaches the destination through the relay", async ({ page }) => {
  test.setTimeout(180_000);
  await openControlledRunner(page);
  const result = await runDeclaredCurl(
    page,
    `-H 'Authorization: ${GUEST_AUTHORIZATION}' -w ' %{http_code}' ${DESTINATION}/granted`,
    "allow",
  );
  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stdout).toBe("upstream /granted\n 200");
  expect(result.credentialRequests).toEqual([
    { pid: expect.any(Number), program: "/usr/bin/curl", destinations: [DESTINATION] },
  ]);
  // The service worker verified the tag, removed it and wrote the opt-in.
  const relayed = seenAtRelay("/granted");
  expect(relayed).toHaveLength(1);
  expect(relayed[0].headers.authorization).toBe(GUEST_AUTHORIZATION);
  expect(relayed[0].headers[OPT_IN_HEADER]).toBe("Authorization");
  expect(relayed[0].headers[TAG_HEADER]).toBeUndefined();
  expect(relayed[0].headers.cookie).toBeUndefined();
  // The relay consumed the opt-in and carried the credential upstream.
  const sent = seenUpstream("/granted");
  expect(sent).toHaveLength(1);
  expect(sent[0].headers.authorization).toBe(GUEST_AUTHORIZATION);
  expect(sent[0].headers[OPT_IN_HEADER]).toBeUndefined();
  expect(sent[0].headers[TAG_HEADER]).toBeUndefined();
});

test("an ungranted guest process is refused before the relay", async ({ page }) => {
  test.setTimeout(180_000);
  await openControlledRunner(page);
  const result = await runDeclaredCurl(
    page,
    `-H 'Authorization: ${GUEST_AUTHORIZATION}' -w ' %{http_code}' ${DESTINATION}/denied`,
    "deny",
  );
  expect(result.credentialRequests).toHaveLength(1);
  expect(result.stdout, JSON.stringify(result, null, 2)).toMatch(/ 502$/);
  expect(result.stdout).toContain("authorization");
  expect(seenAtRelay("/denied")).toEqual([]);
  expect(seenUpstream("/denied")).toEqual([]);
});
