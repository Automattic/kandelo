import { expect, test, type Page } from "@playwright/test";

type PageSetup = (page: Page) => void;

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

const absoluteAppUrl = (path: string): string => {
  const baseUrl =
    process.env.KANDELO_TEST_BASE_URL ??
    `http://127.0.0.1:${process.env.KANDELO_PLAYWRIGHT_PORT ?? "5401"}`;
  return new URL(path, baseUrl).href;
};

async function warmAppRoute(path: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(absoluteAppUrl(path), {
      signal: controller.signal,
      headers: { "User-Agent": "kandelo-playwright-webkit-warmup" },
    });
    await response.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }
}

function isWebKitInternalNavigationError(err: unknown): boolean {
  return String(err).includes("WebKit encountered an internal error");
}

async function gotoOrSkip(initialPage: Page, path: string, setupPage?: PageSetup): Promise<Page> {
  await warmAppRoute(path);
  const context = initialPage.context();
  let page = initialPage;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    setupPage?.(page);
    try {
      await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2_000);
      if (await page.locator("vite-error-overlay").count()) {
        test.skip(true, "Required binary not built - Vite import error");
      }
      return page;
    } catch (err) {
      if (!isWebKitInternalNavigationError(err) || attempt === 3) {
        throw err;
      }
      await page.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      page = await context.newPage();
    }
  }

  throw new Error("unreachable WebKit navigation retry state");
}

function recordRuntimeErrors(page: Page, runtimeErrors: string[]) {
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Out of Memory|RangeError|RuntimeError|Kernel worker error|TAR_ENTRY_ERROR|EACCES/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    if (!isWebKitInternalNavigationError(err)) {
      runtimeErrors.push(`pageerror: ${err.message}`);
    }
  });
}

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function waitForReady(page: Page, timeout = 180_000) {
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout })
    .toContain("Ready");
}

async function waitForPrompt(page: Page, timeout = 120_000) {
  await expect
    .poll(() => terminalText(page), { timeout })
    .toContain("kandelo$");
}

async function runTerminalLine(page: Page, command: string) {
  await page.locator(".kshell-host").first().click();
  const terminalInput = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await terminalInput.count()) {
    await terminalInput.focus();
  }
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
}

test("Kandelo shell demo boots and accepts terminal input in WebKit", async ({
  browserName,
  page: initialPage,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(240_000);

  const page = await gotoOrSkip(initialPage, "/?demo=shell");
  await waitForReady(page);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForPrompt(page);

  await runTerminalLine(
    page,
    "printf 'KANDELO_%s\\n' 'WEBKIT_OK'; export PS1='KANDELO_''WEBKIT_OK $ '",
  );

  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("KANDELO_WEBKIT_OK");
});

test("Kandelo WebKit tears down Node before launching another demo", async ({
  browserName,
  page: initialPage,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(420_000);

  const runtimeErrors: string[] = [];
  const page = await gotoOrSkip(initialPage, "/?demo=node", (candidate) =>
    recordRuntimeErrors(candidate, runtimeErrors),
  );
  await waitForReady(page, 240_000);
  await page.getByRole("button", { name: "Runtime check" }).click();
  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("worker 7");
  await page.getByRole("button", { name: "Install cowsay" }).click();
  await expect
    .poll(() => terminalText(page), { timeout: 300_000 })
    .toContain("< Kandelo >");

  await page.getByRole("button", { name: "Gallery" }).click();
  await page.locator(".kgal-card").filter({ hasText: "Bare shell" }).first().click();
  await waitForReady(page, 180_000);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForPrompt(page);

  await runTerminalLine(
    page,
    "printf 'KANDELO_%s\\n' 'WEBKIT_SWITCH_OK'; export PS1='KANDELO_''WEBKIT_SWITCH_OK $ '",
  );

  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("KANDELO_WEBKIT_SWITCH_OK");
  expect(runtimeErrors).toEqual([]);
});

test("Kandelo WordPress SQLite renders in WebKit without COEP redirect failures", async ({
  browserName,
  page: initialPage,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(300_000);

  const isolationErrors: string[] = [];
  const recordIsolationErrors = (candidate: Page) => {
    candidate.on("console", (msg) => {
      const text = msg.text();
      if (/Cross-Origin-Embedder-Policy|Redirection was blocked|CORS/i.test(text)) {
        isolationErrors.push(`${msg.type()}: ${text}`);
      }
    });
    candidate.on("pageerror", (err) => {
      if (/Cross-Origin-Embedder-Policy|Redirection was blocked|CORS/i.test(err.message)) {
        isolationErrors.push(`pageerror: ${err.message}`);
      }
    });
    candidate.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "";
      if (/Cross-Origin-Embedder-Policy|Redirection was blocked|CORS/i.test(errorText)) {
        isolationErrors.push(`requestfailed: ${request.url()} ${errorText}`);
      }
    });
  };

  const page = await gotoOrSkip(initialPage, "/?demo=wordpress-sqlite", recordIsolationErrors);
  await page.waitForSelector('iframe[title="WordPress SQLite"]', { timeout: 240_000 });
  const frame = page.frameLocator('iframe[title="WordPress SQLite"]');
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, {
    timeout: 240_000,
  });
  await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);
  expect(isolationErrors).toEqual([]);
});
