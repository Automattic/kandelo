import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

// The app's credential prompt (docs/browser-support.md, "Per-process
// credential grants"). When a program its image declared in
// /etc/kandelo/credential-requests.d starts, the kernel worker asks the
// page; the app answers by asking the user in its own dialog, never in the
// terminal. Only "Allow for this process" grants, and only that process.
//
// The machine is the real shell image plus one test declaration for
// /usr/bin/curl, booted through `?vfs=` like any user-supplied image. The
// deployment's proxy is a local fake that records what reaches it, injected
// the way a production build configures it (VITE_CORS_PROXY_URL), so a
// granted request is observable and a refused one provably went nowhere.

test.describe.configure({ mode: "serial" });

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const DESTINATION = "https://credential-dialog.test";
const SECOND_DESTINATION = "https://second.credential-dialog.test";
const AUTHORIZATION = "Bearer dialog-secret-credential";
const TAG_HEADER = "x-kandelo-credential-grant";
const OPT_IN_HEADER = "x-cors-proxy-allowed-request-headers";
const CURL_TITLE = "curl (credential dialog test)";
const CURL_DIALOG = `${CURL_TITLE} wants to use your sign-in credentials`;
const CODEX_DECLARATION = "/etc/kandelo/credential-requests.d/codex.json";
// A declared program the guest account can overwrite, to show the prompt
// for a file that changed after boot.
const CHANGED_PROGRAM = "/home/maker/credtool";
const CHANGED_TITLE = "credtool (changed-file test)";
const CHANGED_FILE_SOURCE = "Not from the image: this file changed after the machine started";
const STOP_ASKING = "Don't allow, and stop asking for this machine";

interface ProxyRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

const observed: ProxyRequest[] = [];
let proxy: Server;
let vite: ViteDevServer;
let origin = "";
// The intermediary the prompt must name for the test destinations: the
// proxy this test configured, by its origin and path (here the root, so
// its origin alone).
let proxyName = "";
let imageDirectory = "";
let imageUrl = "";
let imageDeclaresCodex = false;
let context: BrowserContext;
let page: Page;

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

/** The shell image this worktree serves, plus a declaration for curl. */
async function buildTestImage(): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(await readFile(resolveBinary("programs/wasm32/shell.vfs.zst"))));
  try {
    fs.lstat(CODEX_DECLARATION);
    imageDeclaresCodex = true;
  } catch {
    imageDeclaresCodex = false;
  }
  fs.ensureDirRecursive("/etc/kandelo/credential-requests.d", 0o755);
  fs.createFileWithOwner(
    "/etc/kandelo/credential-requests.d/curl-dialog-test.json",
    0o644,
    0,
    0,
    new TextEncoder().encode(JSON.stringify({
      program: "/usr/bin/curl",
      title: CURL_TITLE,
      destinations: [DESTINATION, SECOND_DESTINATION],
      launch: "wait",
    })),
  );
  // Not a program yet: the test copies curl over it after boot.
  fs.ensureDirRecursive("/home/maker", 0o755, 1000, 1000);
  fs.createFileWithOwner(CHANGED_PROGRAM, 0o755, 1000, 1000, new TextEncoder().encode("placeholder\n"));
  fs.createFileWithOwner(
    "/etc/kandelo/credential-requests.d/credtool-changed-test.json",
    0o644,
    0,
    0,
    new TextEncoder().encode(JSON.stringify({
      program: CHANGED_PROGRAM,
      title: CHANGED_TITLE,
      destinations: [DESTINATION],
      launch: "wait",
    })),
  );
  return fs.saveImage();
}

async function terminalText(target: Page): Promise<string> {
  return target.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function runTerminalLine(target: Page, command: string): Promise<void> {
  await target.locator(".kshell-host").first().click();
  const terminalInput = target.getByRole("textbox", { name: "Terminal input" }).first();
  if (await terminalInput.count()) await terminalInput.focus();
  await target.keyboard.insertText(command);
  await target.waitForTimeout(250);
  await target.keyboard.press("Enter");
}

/** A curl command whose result line the terminal echo cannot satisfy. */
function curlLine(marker: string, path: string): string {
  return `curl -sS -H 'Authorization: ${AUTHORIZATION}' -w ' HTTP_%{http_code}\\n' ` +
    `${DESTINATION}${path}; echo "${marker}_EXIT""=$?"`;
}

async function waitForResult(marker: string): Promise<string> {
  let line = "";
  await expect.poll(async () => {
    const match = new RegExp(`${marker}_EXIT=(\\d+)`).exec(await terminalText(page));
    line = match?.[0] ?? "";
    return line;
  }, { timeout: 120_000, message: `waiting for ${marker}` }).not.toBe("");
  return line;
}

/**
 * Several curlLine jobs at once, `delay` seconds apart, whose outputs cannot
 * interleave. They run in a subshell, which has no job control, so the
 * interactive shell prints no "[2]- Done" notices between a job's writes;
 * each job writes its own file, and the files are printed in order once all
 * jobs end. Each job's output therefore ends with its own marker line.
 */
function concurrentCurlLines(jobs: ReadonlyArray<{ marker: string; path: string; delay: number }>): string {
  const file = (marker: string) => `/tmp/credential-dialog-${marker}.out`;
  const background = jobs
    .map(({ marker, path, delay }) =>
      `(${delay > 0 ? `sleep ${delay}; ` : ""}${curlLine(marker, path)}) >${file(marker)} 2>&1 &`)
    .join(" ");
  return `( ${background} wait ); cat ${jobs.map(({ marker }) => file(marker)).join(" ")}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What the curlLine for `marker` prints when Kandelo refuses its ungranted
 * credential: the kernel answers the request itself with a 502 whose body
 * names the refusal. The match must end at that job's own marker and cannot
 * span another request's output, so one request's refusal is never credited
 * to another.
 */
function refusal(marker: string, path: string): RegExp {
  return new RegExp(
    `Error fetching \\S+${escapeRegExp(`${DESTINATION}${path}`)}: BrowserCorsProxyRequestError: ` +
      `(?:(?!Error fetching |_EXIT=).)*` +
      `unsupported request headers: authorization HTTP_502${marker}_EXIT=\\d+`,
  );
}

/** What the curlLine for `marker` prints when the proxy received its request. */
function proxiedResult(marker: string, path: string): string {
  return `proxied /?${DESTINATION}${path} HTTP_200${marker}_EXIT=0`;
}

function credentialDialog(name: string): Locator {
  return page.getByRole("dialog", { name });
}

async function bootApp(browser: Browser): Promise<void> {
  context = await browser.newContext({ serviceWorkers: "allow" });
  page = await context.newPage();
  await page.goto(`${origin}/?vfs=${encodeURIComponent(imageUrl)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 180_000 });
  await expect.poll(() => terminalText(page), { timeout: 180_000 }).toContain("kandelo$");
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  observed.length = 0;
  // A permissive stand-in for the Playground/Spacefast proxy protocol: it
  // allows whatever the preflight asks for, so only Kandelo decides what
  // reaches it.
  proxy = createServer((request, response) => {
    const requestOrigin = request.headers.origin ?? "*";
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": requestOrigin,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": request.headers["access-control-request-headers"] ?? "",
        Vary: "Origin",
      });
      response.end();
      return;
    }
    observed.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    response.writeHead(200, {
      "Access-Control-Allow-Origin": requestOrigin,
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Type": "text/plain",
      Vary: "Origin",
    });
    response.end(`proxied ${request.url}`);
  });
  const proxyUrl = `${await listen(proxy)}/?`;
  proxyName = new URL(proxyUrl).origin;

  imageDirectory = resolve(repoRoot, "target/browser-test-runs", `credential-dialog-${randomUUID()}`);
  await mkdir(imageDirectory, { recursive: true });
  const imagePath = resolve(imageDirectory, "credential-dialog-shell.vfs.zst");
  await writeFile(imagePath, zstdCompressSync(await buildTestImage()));

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
  imageUrl = `${origin}/@fs${imagePath}`;
  await bootApp(browser);
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page === undefined) return;
  await testInfo.attach("terminal", {
    body: await terminalText(page).catch((error) => String(error)),
    contentType: "text/plain",
  });
  await testInfo.attach("app", {
    body: await page.screenshot().catch(() => Buffer.from("")),
    contentType: "image/png",
  });
});

test.afterAll(async () => {
  await context?.close();
  await vite?.close();
  proxy?.closeAllConnections();
  await new Promise<void>((resolvePromise) => proxy?.close(() => resolvePromise()) ?? resolvePromise());
  if (imageDirectory) await rm(imageDirectory, { recursive: true, force: true });
});

test("a declared program's prompt names it, its destinations, its file and its image", async () => {
  await runTerminalLine(page, curlLine("SHOWN", "/shown"));
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(dialog.getByRole("listitem")).toHaveText([DESTINATION, SECOND_DESTINATION]);
  // Identity is the executable's path, so the file and the image it came
  // from are shown outright, not only inside the details.
  await expect(dialog.getByTestId("credential-request-program")).toHaveText("/usr/bin/curl");
  // The provenance label leads, so a long URL is what gets clipped.
  await expect(dialog.getByTestId("credential-request-image"))
    .toHaveText(`Not an image this site ships: ${imageUrl}`);
  // The file is the one the image booted with: no changed-file warning.
  await expect(dialog.getByTestId("credential-request-changed")).toHaveCount(0);
  // The intermediary that would see the credentials is named in the main
  // body, from the deployment's real proxy configuration: the local proxy
  // this test injected, which carries both test destinations.
  const transport = dialog.getByTestId("credential-request-transport");
  await expect(transport).toBeVisible();
  await expect(transport.locator("[data-transport-kind]")).toHaveCount(1);
  await expect(transport.locator("[data-transport-kind]")).toHaveAttribute("data-transport-kind", "proxy");
  await expect(transport.getByTestId("credential-request-via")).toHaveText(proxyName);
  await expect(transport).toHaveText(
    `Your credentials pass through ${proxyName}, the CORS proxy this site uses, which ` +
      "forwards them to these destinations. Whoever operates that proxy can read them.",
  );
  await expect(dialog.locator("details").getByTestId("credential-request-transport")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("credential-dialog-proxy.png"),
    animations: "disabled",
  });
  await expect(dialog).toContainText("only this running process");
  await expect(dialog.getByRole("button", { name: "Don't allow", exact: true })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Allow for this process" })).toBeVisible();
  // Nothing is ever remembered.
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);

  const details = dialog.locator("details");
  await details.locator("summary").click();
  await expect(details).toContainText("/usr/bin/curl");
  await expect(details).toContainText(`curl -sS -H`);
  await expect(details).toContainText(DESTINATION);
  await expect(details).toContainText(imageUrl);
  await expect(details.getByTestId("credential-request-parents")).toContainText("bash");

  await dialog.getByRole("button", { name: "Don't allow", exact: true }).click();
  await waitForResult("SHOWN");
  await expect(credentialDialog(CURL_DIALOG)).toHaveCount(0);
});

test("a declared program whose file changed after boot is flagged, and not credited to the image", async () => {
  await runTerminalLine(
    page,
    `cp /usr/bin/curl ${CHANGED_PROGRAM} && ${CHANGED_PROGRAM} -sS -H 'Authorization: ${AUTHORIZATION}' ` +
      `-w ' HTTP_%{http_code}\\n' ${DESTINATION}/changed; echo "CHANGED_EXIT""=$?"`,
  );
  const dialog = credentialDialog(`${CHANGED_TITLE} wants to use your sign-in credentials`);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(dialog.getByTestId("credential-request-program")).toHaveText(CHANGED_PROGRAM);
  await expect(dialog.getByTestId("credential-request-changed"))
    .toContainText("This file has changed since the machine started");
  // The image's provenance is not shown as the file's.
  await expect(dialog.getByTestId("credential-request-image")).toHaveText(CHANGED_FILE_SOURCE);
  await expect(dialog.getByTestId("credential-request-image")).not.toContainText("image this site");
  await dialog.getByRole("button", { name: "Don't allow", exact: true }).click();
  await waitForResult("CHANGED");
  expect(proxied("/changed")).toBeUndefined();
});

test("Don't allow leaves the program running and its credentialed request fails visibly", async () => {
  await runTerminalLine(page, curlLine("DENIED", "/denied"));
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await dialog.getByRole("button", { name: "Don't allow", exact: true }).click();
  // curl kept running, made its request, and printed Kandelo's refusal: the
  // credential was neither sent nor silently dropped.
  await waitForResult("DENIED");
  expect(await terminalText(page)).toMatch(refusal("DENIED", "/denied"));
  expect(proxied("/denied")).toBeUndefined();
});

test("Allow for this process lets that process's credentialed request through", async () => {
  await runTerminalLine(page, curlLine("ALLOWED", "/allowed"));
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await dialog.getByRole("button", { name: "Allow for this process" }).click();
  expect(await waitForResult("ALLOWED")).toBe("ALLOWED_EXIT=0");
  expect(await terminalText(page)).toContain(`proxied /?${DESTINATION}/allowed HTTP_200`);
  const allowed = proxied("/allowed")!;
  expect(allowed.headers.authorization).toBe(AUTHORIZATION);
  expect(allowed.headers[OPT_IN_HEADER]).toBe("Authorization");
  expect(allowed.headers[TAG_HEADER]).toBeUndefined();
});

test("Escape answers Don't allow", async () => {
  await runTerminalLine(page, curlLine("ESCAPED", "/escaped"));
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await page.keyboard.press("Escape");
  await waitForResult("ESCAPED");
  expect(await terminalText(page)).toMatch(refusal("ESCAPED", "/escaped"));
  expect(proxied("/escaped")).toBeUndefined();
});

test("concurrent requests are asked one at a time", async () => {
  // Two curl processes start together; each is held until it is answered.
  await runTerminalLine(
    page,
    concurrentCurlLines([
      { marker: "FIRST", path: "/queued-first", delay: 0 },
      { marker: "SECOND", path: "/queued-second", delay: 1 },
    ]),
  );
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(dialog).toContainText("1 more request is waiting", { timeout: 60_000 });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const firstPid = await dialog.getByTestId("credential-request-pid").textContent();
  await dialog.getByRole("button", { name: "Don't allow", exact: true }).click();

  // The second process's question replaces the first.
  await expect(dialog.getByTestId("credential-request-pid")).not.toHaveText(firstPid!, { timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(dialog).not.toContainText("more request");
  await expect(dialog.getByRole("button", { name: "Don't allow", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Allow for this process" }).click();

  await waitForResult("FIRST");
  await waitForResult("SECOND");
  const text = await terminalText(page);
  expect(text).toMatch(refusal("FIRST", "/queued-first"));
  expect(text).toContain(proxiedResult("SECOND", "/queued-second"));
  expect(proxied("/queued-first")).toBeUndefined();
  expect(proxied("/queued-second")?.headers.authorization).toBe(AUTHORIZATION);
});

test("keys typed as the prompt opens cannot allow it", async () => {
  // Shell completion (Tab) then Enter, typed into the terminal just as the
  // dialog takes focus. Tab from "Don't allow" wraps to the top of the
  // dialog, not onto Allow.
  await runTerminalLine(page, curlLine("TABBED", "/tabbed"));
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Don't allow", exact: true }).click();
  await waitForResult("TABBED");

  // Shift+Tab from "Don't allow" does reach Allow in DOM order, but for the
  // first moments Allow is disabled: focus skips past it and Enter cannot
  // activate it.
  await runTerminalLine(page, curlLine("SHIFTED", "/shifted"));
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  // Answered by nothing so far: the dialog still asks.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Allow for this process" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Don't allow", exact: true }).click();
  await waitForResult("SHIFTED");

  const text = await terminalText(page);
  expect(text).toMatch(refusal("TABBED", "/tabbed"));
  expect(text).toMatch(refusal("SHIFTED", "/shifted"));
  expect(proxied("/tabbed")).toBeUndefined();
  expect(proxied("/shifted")).toBeUndefined();
});

test("a double-click on Allow answers only the question it was aimed at", async () => {
  await runTerminalLine(
    page,
    concurrentCurlLines([1, 2, 3].map((n) => ({ marker: `DOUBLE${n}`, path: `/double-${n}`, delay: n - 1 }))),
  );
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toContainText("2 more requests are waiting", { timeout: 120_000 });
  const allow = dialog.getByRole("button", { name: "Allow for this process" });
  await expect(allow).toBeEnabled();
  const firstPid = await dialog.getByTestId("credential-request-pid").textContent();
  const box = (await allow.boundingBox())!;
  // The next queued dialog is laid out identically, so the second click
  // lands on its Allow button, which is still disarmed.
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(dialog.getByTestId("credential-request-pid")).not.toHaveText(firstPid!);
  await expect(dialog).toContainText("1 more request is waiting");
  await dialog.getByRole("button", { name: "Don't allow", exact: true }).click();
  await expect(dialog).not.toContainText("more request");
  await dialog.getByRole("button", { name: "Don't allow", exact: true }).click();
  for (const n of [1, 2, 3]) await waitForResult(`DOUBLE${n}`);

  const text = await terminalText(page);
  expect(text).toContain(proxiedResult("DOUBLE1", "/double-1"));
  expect(text).toMatch(refusal("DOUBLE2", "/double-2"));
  expect(text).toMatch(refusal("DOUBLE3", "/double-3"));
  expect(proxied("/double-1")?.headers.authorization).toBe(AUTHORIZATION);
  expect(proxied("/double-2")).toBeUndefined();
  expect(proxied("/double-3")).toBeUndefined();
});

test("a question for a process that ends closes its dialog", async () => {
  await runTerminalLine(
    page,
    `curl -sS -H 'Authorization: ${AUTHORIZATION}' ${DESTINATION}/killed & pid=$!; ` +
      `sleep 4; kill -KILL $pid; wait $pid; echo "KILLED_WAIT""=$?"`,
  );
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => terminalText(page), { timeout: 60_000 }).toContain("KILLED_WAIT=137");
  expect(proxied("/killed")).toBeUndefined();
});

test("a flood of declared launches keeps a bounded queue that Deny all waiting clears", async () => {
  // A guest that starts declared programs in a loop: at most eight
  // questions are open per machine (one shown, seven waiting); the rest are
  // denied without asking, and "Deny all waiting" frees the terminal.
  await runTerminalLine(
    page,
    `for i in $(seq 20); do curl --version >/dev/null & done; wait; echo "FLOOD""_DONE"`,
  );
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toContainText("7 more requests are waiting", { timeout: 180_000 });
  // Bounded: with every launch made, no more are queued.
  await expect.poll(() => terminalText(page), { timeout: 5_000 }).not.toContain("FLOOD_DONE");
  await page.waitForTimeout(3_000);
  await expect(dialog).toContainText("7 more requests are waiting");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const denyAll = dialog.getByRole("button", { name: "Deny all waiting" });
  await expect(denyAll).toBeEnabled();
  await denyAll.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain("FLOOD_DONE");
  // The terminal is usable again.
  await runTerminalLine(page, `echo "USABLE""_AFTER_FLOOD"`);
  await expect.poll(() => terminalText(page), { timeout: 60_000 }).toContain("USABLE_AFTER_FLOOD");
  // A later declared launch still asks.
  await runTerminalLine(page, curlLine("AFTERFLOOD", "/after-flood"));
  await expect(credentialDialog(CURL_DIALOG)).toBeVisible({ timeout: 120_000 });
  await credentialDialog(CURL_DIALOG).getByRole("button", { name: "Don't allow", exact: true }).click();
  await waitForResult("AFTERFLOOD");
});

test("codex --version asks for Codex's three destinations, and runs when denied", async () => {
  if (!imageDeclaresCodex) {
    throw new Error(
      `rebuild the shell image: ${CODEX_DECLARATION} is missing from ` +
        resolveBinary("programs/wasm32/shell.vfs.zst"),
    );
  }
  test.setTimeout(420_000);
  await runTerminalLine(page, `codex --version; echo "CODEX_EXIT""=$?"`);
  const dialog = credentialDialog("Codex wants to use your sign-in credentials");
  await expect(dialog).toBeVisible({ timeout: 360_000 });
  await expect(dialog.getByRole("listitem")).toHaveText([
    "https://auth.openai.com",
    "https://chatgpt.com",
    "https://api.openai.com",
  ]);
  await expect(dialog.getByTestId("credential-request-program")).toHaveText("/usr/bin/codex");
  // Fetching a lazy program's bytes on first use does not count as a change.
  await expect(dialog.getByTestId("credential-request-changed")).toHaveCount(0);
  // On this loopback development server the three OpenAI origins go to the
  // development credential relay, not the proxy, and the prompt says so.
  const transport = dialog.getByTestId("credential-request-transport");
  await expect(transport.locator("[data-transport-kind]")).toHaveCount(1);
  await expect(transport.locator("[data-transport-kind]")).toHaveAttribute("data-transport-kind", "relay");
  await expect(transport.getByTestId("credential-request-via"))
    .toHaveText(`${origin}/__kandelo_credential_relay`);
  await expect(transport).toContainText("development server running on this computer");
  await expect(transport).toContainText("Whoever runs that server can read them.");
  await page.screenshot({
    path: test.info().outputPath("codex-credential-dialog.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Don't allow", exact: true }).click();
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toMatch(/codex-cli \d+\.\d+\.\d+/);
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("CODEX_EXIT=0");
});

// Last: the choice holds for the rest of this machine's life.
test("Don't allow, and stop asking denies this and every later question for the machine", async () => {
  await runTerminalLine(page, curlLine("STOPFIRST", "/stop-first"));
  const dialog = credentialDialog(CURL_DIALOG);
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  const stop = dialog.getByRole("button", { name: STOP_ASKING });
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await waitForResult("STOPFIRST");

  // The next declared launch is denied without a question.
  await runTerminalLine(page, curlLine("STOPSECOND", "/stop-second"));
  await waitForResult("STOPSECOND");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const text = await terminalText(page);
  expect(text).toMatch(refusal("STOPFIRST", "/stop-first"));
  expect(text).toMatch(refusal("STOPSECOND", "/stop-second"));
  expect(proxied("/stop-first")).toBeUndefined();
  expect(proxied("/stop-second")).toBeUndefined();
});
