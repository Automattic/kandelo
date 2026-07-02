import { expect, test, type Page } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

async function gotoOrSkip(page: Page, path: string) {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }
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
  page,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=shell");
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
  page,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(420_000);

  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Out of Memory|RangeError|RuntimeError|Kernel worker error|TAR_ENTRY_ERROR|EACCES/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await gotoOrSkip(page, "/?demo=node");
  await waitForReady(page, 240_000);
  await page.getByRole("button", { name: "Runtime check" }).click();
  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("worker 7");
  await page.getByRole("button", { name: "Install cowsay" }).click();
  await expect
    .poll(() => terminalText(page), { timeout: 300_000 })
    .toContain("< Kandelo >");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await page
    .locator(".kgal-row", {
      has: page.locator(".kgal-machine-title", { hasText: /^Bare shell$/ }),
    })
    .getByRole("button", { name: "Launch" })
    .click();
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
  page,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(300_000);

  const isolationErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Cross-Origin-Embedder-Policy|Redirection was blocked|CORS/i.test(text)) {
      isolationErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    if (/Cross-Origin-Embedder-Policy|Redirection was blocked|CORS/i.test(err.message)) {
      isolationErrors.push(`pageerror: ${err.message}`);
    }
  });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "";
    if (/Cross-Origin-Embedder-Policy|Redirection was blocked|CORS/i.test(errorText)) {
      isolationErrors.push(`requestfailed: ${request.url()} ${errorText}`);
    }
  });

  await gotoOrSkip(page, "/?demo=wordpress-sqlite");
  await page.waitForSelector('iframe[title="WordPress SQLite"]', { timeout: 240_000 });
  const frame = page.frameLocator('iframe[title="WordPress SQLite"]');
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, {
    timeout: 240_000,
  });
  await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);
  expect(isolationErrors).toEqual([]);
});
