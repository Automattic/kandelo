import { readFileSync, writeFileSync } from "node:fs";
import {
  expect,
  test,
  type Frame,
  type Page,
  type Request,
} from "@playwright/test";

import {
  runParentShellProbe,
  runTerminalCommand,
} from "./support/terminal-command";
import {
  executeProtectedBrowserOperation,
  type ProtectedBrowserOperationAdapter,
} from "../../../scripts/abi-staging-protected-browser-operation";

declare global {
  interface Window {
    __KANDELO_ABI_STAGING_ACTIVATE_PAGES_PRODUCT__?: () => Promise<void>;
  }
}

interface EvidenceDefinition {
  id: string;
  runner: string;
  timeout_seconds: number;
  probe: Record<string, unknown>;
}

interface EvidenceSession {
  context: {
    definition: EvidenceDefinition;
    product: { id: string };
  };
  selection: {
    definitionId: string;
    productId: string;
    surface: string;
    pagesLoad: "eager" | "lazy" | null;
    boot: unknown;
    mounts: unknown;
    vfs: { url: string; bytes: number };
    lazyAssets: Array<{
      id: string;
      reference: string;
      url: string;
      sha256: string;
      bytes: number;
    }>;
    browserHarness: {
      url: string;
      sha256: string;
      bytes: number;
    };
    browserHost: {
      url: string;
      sha256: string;
      bytes: number;
    };
    kernelAsset: {
      url: string;
      sha256: string;
      bytes: number;
    };
  };
}

const sessionPath = process.env.KANDELO_ABI_STAGING_BROWSER_SESSION;
const observationPath = process.env.KANDELO_ABI_STAGING_BROWSER_OBSERVATION;
const session = sessionPath === undefined
  ? undefined
  : JSON.parse(readFileSync(sessionPath, "utf8")) as EvidenceSession;

test.describe("protected exact candidate product evidence", () => {
  test("executes the registered browser definition", async ({ page }) => {
    if (session === undefined || observationPath === undefined) {
      throw new Error("protected browser evidence inputs are unavailable");
    }
    const { context, selection } = session;
    if (
      context.definition.id !== selection.definitionId ||
      context.product.id !== selection.productId
    ) {
      throw new Error("protected browser evidence session identity differs");
    }
    test.setTimeout(context.definition.timeout_seconds * 1_000);

    const diagnostics = boundedDiagnostics(page);
    const documentStatusByFrame = new WeakMap<Frame, number>();
    type EvidencePhase = "protected" | "ui";
    let phase: EvidencePhase = "protected";
    let networkViolation: string | undefined;
    const protectedOrigin = new URL(selection.vfs.url).origin;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin !== protectedOrigin
      ) {
        networkViolation ??=
          `browser evidence attempted an undeclared network origin: ${boundedText(url.href, 8_192)}`;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    type ResourceObservation = {
      request: Request;
      method: string;
      status?: number;
      bytes?: number;
      finished: boolean;
    };
    const vfsRequests = new Map<EvidencePhase, ResourceObservation>();
    const kernelRequests = new Map<EvidencePhase, ResourceObservation>();
    let harnessRequest: {
      request: Request;
      method: string;
      status?: number;
      bytes?: number;
      finished: boolean;
    } | undefined;
    let hostRequest: {
      request: Request;
      method: string;
      status?: number;
      bytes?: number;
      finished: boolean;
    } | undefined;
    const expectedLazyByUrl = new Map(
      selection.lazyAssets.map((asset) => [asset.url, asset]),
    );
    const lazyRequests = new Map<Request, {
      phase: EvidencePhase;
      request: Request;
      url: string;
      method: string;
      status?: number;
      bytes?: number;
      finished: boolean;
    }>();
    const observedLazyByPhaseAndUrl = new Map<string, {
      phase: EvidencePhase;
      request: Request;
      url: string;
      method: string;
      status?: number;
      bytes?: number;
      finished: boolean;
    }>();
    const preOperationLazyRequest = new Map<EvidencePhase, string>();
    const operationStarted = new Map<EvidencePhase, boolean>([
      ["protected", false],
      ["ui", false],
    ]);
    page.on("request", (request) => {
      const url = request.url();
      if (url === selection.browserHarness.url) {
        if (phase !== "protected" || harnessRequest !== undefined) {
          networkViolation ??= "protected browser harness was requested more than once";
        } else {
          harnessRequest = { request, method: request.method(), finished: false };
        }
      } else if (url === selection.browserHost.url) {
        if (phase !== "protected" || hostRequest !== undefined) {
          networkViolation ??= "exact browser host entry was requested more than once";
        } else {
          hostRequest = { request, method: request.method(), finished: false };
        }
      } else if (url === selection.kernelAsset.url) {
        if (kernelRequests.has(phase)) {
          networkViolation ??= `browser kernel asset was requested more than once in ${phase}`;
        } else {
          kernelRequests.set(phase, {
            request,
            method: request.method(),
            finished: false,
          });
        }
      } else if (
        new URL(url).origin === protectedOrigin &&
        new URL(url).pathname.endsWith(".wasm")
      ) {
        networkViolation ??=
          `browser evidence requested an unattested runtime Wasm: ${boundedText(url, 8_192)}`;
      }
      if (/\.vfs(?:\.zst)?(?:[?#]|$)/u.test(url)) {
        if (url === selection.vfs.url && !vfsRequests.has(phase)) {
          vfsRequests.set(phase, {
            request,
            method: request.method(),
            finished: false,
          });
        } else {
          networkViolation ??=
            `unexpected or duplicate ${phase} candidate VFS request: ${boundedText(url, 8_192)}`;
        }
      }
      if (url.includes("-candidates/") && url !== selection.vfs.url) {
        if (!(operationStarted.get(phase) ?? false)) {
          preOperationLazyRequest.set(phase, boundedText(url, 8_192));
        }
        if (!expectedLazyByUrl.has(url)) {
          networkViolation ??= `unexpected candidate lazy request: ${boundedText(url, 8_192)}`;
          return;
        }
        const key = `${phase}\0${url}`;
        if (observedLazyByPhaseAndUrl.has(key)) {
          networkViolation ??=
            `duplicate ${phase} candidate lazy request: ${boundedText(url, 8_192)}`;
          return;
        }
        const observation = {
          phase,
          request,
          url,
          method: request.method(),
          finished: false,
        };
        lazyRequests.set(request, observation);
        observedLazyByPhaseAndUrl.set(key, observation);
      }
    });
    page.on("response", (response) => {
      if (response.request().resourceType() === "document") {
        documentStatusByFrame.set(response.frame(), response.status());
      }
      const lazy = lazyRequests.get(response.request());
      if (lazy !== undefined) {
        lazy.status = response.status();
        const length = response.headers()["content-length"];
        if (length !== undefined) lazy.bytes = Number(length);
      }
      for (const observed of kernelRequests.values()) {
        if (observed.request !== response.request()) continue;
        observed.status = response.status();
        const length = response.headers()["content-length"];
        if (length !== undefined) observed.bytes = Number(length);
      }
      for (const observed of vfsRequests.values()) {
        if (observed.request !== response.request()) continue;
        observed.status = response.status();
        const length = response.headers()["content-length"];
        if (length !== undefined) observed.bytes = Number(length);
      }
      for (const observed of [harnessRequest, hostRequest]) {
        if (observed?.request !== response.request()) continue;
        observed.status = response.status();
        const length = response.headers()["content-length"];
        if (length !== undefined) observed.bytes = Number(length);
      }
    });
    page.on("requestfinished", (request) => {
      const lazy = lazyRequests.get(request);
      if (lazy !== undefined) lazy.finished = true;
      for (const observed of kernelRequests.values()) {
        if (observed.request === request) observed.finished = true;
      }
      for (const observed of vfsRequests.values()) {
        if (observed.request === request) observed.finished = true;
      }
      if (harnessRequest?.request === request) harnessRequest.finished = true;
      if (hostRequest?.request === request) hostRequest.finished = true;
    });
    await page.addInitScript((input) => {
      Object.defineProperty(
        window,
        "__KANDELO_ABI_STAGING_BROWSER_EVIDENCE__",
        { configurable: false, enumerable: false, writable: false, value: input },
      );
    }, {
      schema: 1,
      kind: "kandelo-protected-browser-evidence-boot",
      boot: selection.boot,
      mounts: selection.mounts,
      runtime: {
        browserHost: selection.browserHost,
        kernelAsset: selection.kernelAsset,
      },
      vfs: selection.vfs,
    });

    await prepareGenericAdapter(page, selection.browserHarness.url);
    // Generic adapters restore the exact VFS before this boundary, so a lazy
    // layer fetched here would be eager materialization. Live products use
    // navigation/boot itself as the protected operation because their manifest
    // boot executable may intentionally be lazy (for example platform-rootfs).
    expect(preOperationLazyRequest.get("protected")).toBeUndefined();
    operationStarted.set("protected", true);
    let output = await executeProtectedBrowserOperation(
      context.definition,
      selection.surface,
      protectedBrowserAdapter(page),
    );
    await destroyProtectedAdapter(page);
    if (selection.pagesLoad !== null) {
      phase = "ui";
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        typeof window.__KANDELO_ABI_STAGING_ACTIVATE_PAGES_PRODUCT__ === "function"
      );
      if (selection.pagesLoad === "eager") {
        await expect.poll(
          () => vfsRequests.get("ui")?.finished ?? false,
          { timeout: 180_000 },
        ).toBe(true);
      } else {
        expect(vfsRequests.get("ui")).toBeUndefined();
      }
      expect(preOperationLazyRequest.get("ui")).toBeUndefined();
      operationStarted.set("ui", true);
      await page.evaluate(async () => {
        const activate = window.__KANDELO_ABI_STAGING_ACTIVATE_PAGES_PRODUCT__;
        if (activate === undefined) {
          throw new Error("candidate Pages activation boundary is absent");
        }
        await activate();
      });
      output += await executeSupplementaryUi(
        page,
        session,
        documentStatusByFrame,
      );
    }
    const phases: EvidencePhase[] = selection.pagesLoad === null
      ? ["protected"]
      : ["protected", "ui"];
    for (const expectedPhase of phases) {
      const vfsRequest = vfsRequests.get(expectedPhase);
      expect(vfsRequest?.method).toBe("GET");
      expect(vfsRequest?.status).toBe(200);
      expect(vfsRequest?.bytes).toBe(selection.vfs.bytes);
      expect(vfsRequest?.finished).toBe(true);
      const kernelRequest = kernelRequests.get(expectedPhase);
      expect(kernelRequest?.method).toBe("GET");
      expect(kernelRequest?.status).toBe(200);
      expect(kernelRequest?.bytes).toBe(selection.kernelAsset.bytes);
      expect(kernelRequest?.finished).toBe(true);
    }
    expect(harnessRequest?.method).toBe("GET");
    expect(harnessRequest?.status).toBe(200);
    expect(harnessRequest?.bytes).toBe(selection.browserHarness.bytes);
    expect(harnessRequest?.finished).toBe(true);
    expect(hostRequest?.method).toBe("GET");
    expect(hostRequest?.status).toBe(200);
    expect(hostRequest?.bytes).toBe(selection.browserHost.bytes);
    expect(hostRequest?.finished).toBe(true);
    if (selection.lazyAssets.length > 0) {
      await expect.poll(
        () => Array.from(observedLazyByPhaseAndUrl.values())
          .filter((item) => item.finished).length,
        { timeout: 180_000 },
      ).toBe(selection.lazyAssets.length * phases.length);
    }
    for (const expectedPhase of phases) {
      for (const expected of selection.lazyAssets) {
        const observed = observedLazyByPhaseAndUrl.get(
          `${expectedPhase}\0${expected.url}`,
        );
        expect(observed?.method).toBe("GET");
        expect(observed?.status).toBe(200);
        expect(observed?.bytes).toBe(expected.bytes);
        expect(observed?.finished).toBe(true);
      }
    }
    expect(networkViolation).toBeUndefined();
    if (diagnostics.pageErrors.length > 0) {
      throw new Error(`candidate page errors: ${diagnostics.pageErrors.join("\n")}`);
    }

    writeFileSync(observationPath, JSON.stringify({
      definition_id: selection.definitionId,
      kind: "kandelo-protected-browser-evidence-observation",
      product_id: selection.productId,
      schema: 1,
      stderr: boundedText(diagnostics.console.join("\n"), 64 * 1024),
      stdout: boundedText(output, 64 * 1024),
    }) + "\n", { flag: "wx", mode: 0o600 });
  });
});

async function executeSupplementaryUi(
  page: Page,
  session: EvidenceSession,
  documentStatusByFrame: WeakMap<Frame, number>,
): Promise<string> {
  const { definition } = session.context;
  const { surface } = session.selection;
  assertProtectedRepositorySuite(definition, surface);
  if (definition.runner === "interactive-terminal") {
    await waitForTerminal(page);
    const inputs = stringArray(definition.probe.input, "terminal input");
    const expected = stringArray(
      definition.probe.output_contains,
      "terminal output predicate",
    );
    let output = "";
    for (const [index, command] of inputs.entries()) {
      output += (await runParentShellProbe(page, command, expected[index], 180_000)).output;
    }
    return output;
  }
  if (definition.runner === "exec") {
    await waitForTerminal(page);
    const argv = stringArray(definition.probe.argv, "exec argv");
    const command = argv.map(shellQuote).join(" ");
    const expected = stringPredicate(definition.probe, "stdout");
    const result = await runParentShellProbe(page, command, expected.value, 180_000);
    assertPredicate(result.output, expected);
    return result.output;
  }
  if (definition.runner === "http") {
    const title = surface === "nginx" ? "nginx" : "nginx + PHP";
    const path = absoluteProbePath(definition.probe.path);
    const pathInput = page.getByRole("textbox", { name: "Preview URL path" });
    await expect(pathInput).toBeVisible({ timeout: 180_000 });
    await pathInput.fill(path);
    await pathInput.press("Enter");
    const body = String(
      definition.probe.body_contains ?? definition.probe.body_exact ?? "",
    );
    const iframe = page.locator(`iframe[title="${title}"]`);
    const frame = iframe.contentFrame();
    await expect(frame.locator("body")).toContainText(body, { timeout: 180_000 });
    const element = await iframe.elementHandle();
    const contentFrame = await element?.contentFrame();
    if (contentFrame === null || contentFrame === undefined) {
      throw new Error("candidate HTTP preview lacks its content frame");
    }
    expect(documentStatusByFrame.get(contentFrame)).toBe(
      Number(definition.probe.status),
    );
    const observedUrl = new URL(contentFrame.url());
    expect(observedUrl.pathname.endsWith(path)).toBe(true);
    return `http-${String(definition.probe.status)}:${path}:${body}\n`;
  }
  if (surface === "toolchain-shell") {
    await waitForTerminal(page);
    expect(await readProtectedLiveLedger(page)).toEqual({
      lazyDownloads: [],
      packagePrefetches: [],
    });
    const work = "/tmp/kandelo-browser-toolchain";
    const compile = [
      "set -eu",
      "export HOME=/tmp MAKEFLAGS=-j1",
      `printf '%s\\n' '#include <stdio.h>' ` +
        `'int main(void) { puts("BROWSER_C_IN_GUEST_OK"); return 0; }' ` +
        `> ${work}.c`,
      `printf '%s\\n' '#include <iostream>' ` +
        `'int main() { std::cout << "BROWSER_CXX_IN_GUEST_OK\\n"; return 0; }' ` +
        `> ${work}.cpp`,
      `cc ${work}.c -o ${work}-c.wasm`,
      `c++ ${work}.cpp -o ${work}-cxx.wasm`,
      `${work}-c.wasm`,
      `${work}-cxx.wasm`,
    ].join("\n");
    const compiled = await runTerminalCommand(
      page,
      compile,
      "BROWSER_CXX_IN_GUEST_OK",
      300_000,
    );
    expect(compiled.output).toContain("BROWSER_C_IN_GUEST_OK");
    expect(compiled.output).toContain("BROWSER_CXX_IN_GUEST_OK");
    const ledger = await readProtectedLiveLedger(page);
    expect(ledger.lazyDownloads).toHaveLength(3);
    expect(ledger.lazyDownloads.every(({ status }) => status === "complete"))
      .toBe(true);

    const reused = await runTerminalCommand(
      page,
      `${work}-c.wasm\n${work}-cxx.wasm\ncc --version`,
      "BROWSER_CXX_IN_GUEST_OK",
      300_000,
    );
    expect(reused.output).toContain("BROWSER_C_IN_GUEST_OK");
    return "BROWSER_C_IN_GUEST_OK\nBROWSER_CXX_IN_GUEST_OK\ntoolchain-reused\n";
  }
  if (surface === "c-development") {
    await waitForTerminal(page);
    const packageStatus = page.locator(".kdownload-toast-title").filter({
      hasText: /(?:Preparing C\/C\+\+ toolchain|C\/C\+\+ toolchain ready)/,
    });
    await expect(packageStatus).toBeVisible({ timeout: 180_000 });
    await expect.poll(
      () => page.locator(".kdownload-toast").count(),
      { timeout: 180_000 },
    ).toBeGreaterThan(1);
    await expect(page.getByText("C/C++ toolchain ready")).toBeVisible({
      timeout: 300_000,
    });

    const workspace = await runTerminalCommand(
      page,
      "pwd\nprintf 'CC=%s\\nCXX=%s\\nMAKEFLAGS=%s\\n' \"$CC\" \"$CXX\" \"$MAKEFLAGS\"\ncat hello.c",
      "Hello from Kandelo C!",
    );
    expect(workspace.output).toContain("/home/user/c");
    expect(workspace.output).toContain("CC=cc\nCXX=c++\nMAKEFLAGS=-j1");
    expect(workspace.output).toContain([
      "#include <stdio.h>",
      "",
      "int main(void) {",
      "  puts(\"Hello from Kandelo C!\");",
      "  return 0;",
      "}",
    ].join("\n"));

    await runTerminalCommand(
      page,
      "cc hello.c -o hello.wasm && ./hello.wasm",
      "Hello from Kandelo C!",
      300_000,
    );
    const cxx = [
      "printf '%s\\n' '#include <iostream>'",
      "'int main() { std::cout << \"BROWSER_C_DEV_CXX_OK\\n\"; return 0; }'",
      "> hello.cpp",
      "&& c++ hello.cpp -o hello-cxx.wasm",
      "&& ./hello-cxx.wasm",
    ].join(" ");
    await runTerminalCommand(page, cxx, "BROWSER_C_DEV_CXX_OK", 300_000);
    await runTerminalCommand(
      page,
      "./hello.wasm && ./hello-cxx.wasm && cc --version",
      "BROWSER_C_DEV_CXX_OK",
      300_000,
    );
    expect(await readProtectedLiveLedger(page)).toMatchObject({
      lazyDownloads: [
        { status: "complete" },
        { status: "complete" },
        { status: "complete" },
      ],
      packagePrefetches: [{
        id: "c-development-toolchain",
        status: "ready",
        roots: ["kandelo-dev/tap-core/kandelo-sdk"],
        packages: [
          "kandelo-dev/tap-core/libcxx",
          "kandelo-dev/tap-core/clang",
          "kandelo-dev/tap-core/kandelo-sdk",
        ],
      }],
    });
    return "c-development-ready\nHello from Kandelo C!\nBROWSER_C_DEV_CXX_OK\ntoolchain-reused\n";
  }
  if (surface === "wordpress-sqlite" || surface === "wordpress-mariadb") {
    const title = surface === "wordpress-sqlite"
      ? "WordPress SQLite"
      : "WordPress MariaDB";
    const frame = page.frameLocator(`iframe[title="${title}"]`);
    await expect(frame.locator("body")).toContainText(
      /WordPress on Kandelo|Hello world/i,
      { timeout: 240_000 },
    );
    await page.getByRole("button", { name: /Log in as admin/i }).click();
    await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first())
      .toBeVisible({ timeout: 180_000 });
    return `${surface}-login-ready\n`;
  }
  if (surface === "doom") {
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => canvasHasColor(canvas), { timeout: 180_000 }).toBe(true);
    return "fbdoom-frame-ready\n";
  }
  if (surface === "modeset") {
    const controls = page
      .locator(".kdemo-surface-controls")
      .filter({ has: page.locator(".kdemo-surface-title", { hasText: /MODESET/ }) })
      .first();
    await expect.poll(() => controls.innerText(), { timeout: 180_000 })
      .toMatch(/[1-9]\d*\s+flips/i);
    const screenshot = await page.locator("canvas").first().screenshot();
    expect(screenshot.byteLength).toBeGreaterThan(5_000);
    return "modeset-page-flip-ready\n";
  }
  throw new Error(`browser evidence surface has no protected operation: ${surface}`);
}

function assertProtectedRepositorySuite(
  definition: EvidenceDefinition,
  surface: string,
): void {
  const expected: Readonly<Record<string, string>> = {
    "toolchain-shell": "main-shell-toolchain-browser",
    "c-development": "main-shell-c-development-browser",
    doom: "main-shell-fbdoom-browser",
    modeset: "main-shell-modeset-browser",
    "wordpress-sqlite": "wordpress-sqlite-browser",
    "wordpress-mariadb": "wordpress-mariadb-browser",
    "mariadb-suite": "mariadb-product-browser",
    "php-suite": "php-product-browser",
    "sqlite-suite": "sqlite-product-browser",
  };
  const suite = expected[surface];
  if (
    (definition.runner === "repository-suite") !== (suite !== undefined) ||
    (suite !== undefined && definition.probe.suite !== suite)
  ) {
    throw new Error("protected browser repository-suite adapter differs from its definition");
  }
}

async function readProtectedLiveLedger(page: Page): Promise<{
  lazyDownloads: Array<{ status: string }>;
  packagePrefetches: Array<{
    id: string;
    status: string;
    roots: string[];
    packages?: string[];
  }>;
}> {
  return page.evaluate(() => {
    const read = window.__KANDELO_ABI_STAGING_LIVE_LEDGER__;
    if (read === undefined) {
      throw new Error("protected live Kandelo ledger is unavailable");
    }
    return read();
  });
}

async function prepareGenericAdapter(page: Page, harnessUrl: string): Promise<void> {
  await page.goto(harnessUrl, {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate(async () => {
    const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
    if (adapter === undefined) throw new Error("candidate evidence adapter is absent");
    await adapter.ready;
  });
}

function absoluteProbePath(value: unknown): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 4_096 ||
    !value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("HTTP evidence path is not a bounded absolute path");
  }
  return value;
}

function protectedBrowserAdapter(page: Page): ProtectedBrowserOperationAdapter {
  return {
    startService: () => page.evaluate(async () => {
      const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
      if (adapter === undefined) throw new Error("protected evidence adapter is absent");
      await adapter.startService();
    }),
    exec: (request) => page.evaluate(async (input) => {
      const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
      if (adapter === undefined) throw new Error("protected evidence adapter is absent");
      return adapter.exec(input.argv, input.env, input.stdin);
    }, request),
    pty: (input) => page.evaluate(async (commands) => {
      const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
      if (adapter === undefined) throw new Error("protected evidence adapter is absent");
      return adapter.pty(commands);
    }, input),
    fetchHttp: (path) => page.evaluate(async (value) => {
      const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
      if (adapter === undefined) throw new Error("protected evidence adapter is absent");
      return adapter.fetchHttp(value);
    }, path),
    verifyWordPressLogin: () => page.evaluate(async () => {
      const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
      if (adapter === undefined) throw new Error("protected evidence adapter is absent");
      return adapter.verifyWordPressLogin();
    }),
    queryMySql: (statement) => page.evaluate(async (value) => {
      const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
      if (adapter === undefined) throw new Error("protected evidence adapter is absent");
      return adapter.queryMySql(value);
    }, statement),
    queryRedis: (request) => page.evaluate(async (value) => {
      const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
      if (adapter === undefined) throw new Error("protected evidence adapter is absent");
      return adapter.queryRedis(value);
    }, request),
    observeFramebuffer: (programPath) => page.evaluate(async (value) => {
      const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
      if (adapter === undefined) throw new Error("protected evidence adapter is absent");
      return adapter.observeFramebuffer(value);
    }, programPath),
    observeModeset: (programPath) => page.evaluate(async (value) => {
      const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
      if (adapter === undefined) throw new Error("protected evidence adapter is absent");
      return adapter.observeModeset(value);
    }, programPath),
  };
}

async function destroyProtectedAdapter(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const adapter = window.__KANDELO_ABI_STAGING_PRODUCT_EVIDENCE__;
    if (adapter === undefined) throw new Error("protected evidence adapter is absent");
    await adapter.destroy();
  });
}

async function waitForTerminal(page: Page): Promise<void> {
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  await expect.poll(
    () => page.locator(".xterm-rows").first().textContent(),
    { timeout: 180_000 },
  ).toMatch(/[$#] ?/u);
}

async function canvasHasColor(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  return locator.evaluate((canvas: HTMLCanvasElement) => {
    if (canvas.width === 0 || canvas.height === 0) return false;
    const context = canvas.getContext("2d");
    if (context === null) return false;
    const data = context.getImageData(
      0,
      0,
      Math.min(canvas.width, 64),
      Math.min(canvas.height, 64),
    ).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) {
        return true;
      }
    }
    return false;
  });
}

function boundedDiagnostics(page: Page): {
  console: string[];
  pageErrors: string[];
} {
  const console: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => appendBounded(console, message.text()));
  page.on("pageerror", (error) => appendBounded(pageErrors, error.message));
  return { console, pageErrors };
}

function appendBounded(values: string[], value: string): void {
  if (values.length >= 256) return;
  const remaining = 64 * 1024 - new TextEncoder().encode(values.join("\n")).byteLength;
  if (remaining <= 0) return;
  values.push(boundedText(value, remaining));
}

function boundedText(value: string, maximum: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximum) return value;
  return new TextDecoder().decode(bytes.subarray(0, maximum));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error(`${label} is outside its bound`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length === 0 || item.includes("\0")) {
      throw new Error(`${label} contains invalid text`);
    }
    return item;
  });
}

function stringPredicate(
  probe: Record<string, unknown>,
  prefix: "stdout" | "body",
): { kind: "exact" | "contains" | "regex"; value: string } {
  for (const kind of ["exact", "contains", "regex"] as const) {
    const value = probe[`${prefix}_${kind}`];
    if (typeof value === "string") return { kind, value };
  }
  throw new Error(`protected ${prefix} predicate is absent`);
}

function assertPredicate(
  actual: string,
  predicate: { kind: "exact" | "contains" | "regex"; value: string },
): void {
  if (predicate.kind === "exact") expect(actual).toBe(predicate.value);
  if (predicate.kind === "contains") expect(actual).toContain(predicate.value);
  if (predicate.kind === "regex") expect(actual).toMatch(new RegExp(predicate.value, "u"));
}
