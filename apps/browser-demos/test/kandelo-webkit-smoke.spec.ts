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

  await page.locator(".kshell-host").first().click();
  await page.keyboard.insertText("printf 'KANDELO_%s\\n' 'WEBKIT_OK'; export PS1='KANDELO_''WEBKIT_OK $ '");
  await page.keyboard.press("Enter");

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
    if (/Out of Memory|RangeError|RuntimeError|Kernel worker error/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await gotoOrSkip(page, "/?demo=node");
  await waitForReady(page, 240_000);
  await page.getByRole("button", { name: "Runtime check" }).click();
  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("intl 1.234.567,89");

  await page.getByRole("button", { name: "Gallery" }).click();
  await page.locator(".kgal-card").filter({ hasText: "Bare shell" }).first().click();
  await waitForReady(page, 180_000);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForPrompt(page);

  await page.locator(".kshell-host").first().click();
  await page.keyboard.insertText("printf 'KANDELO_%s\\n' 'WEBKIT_SWITCH_OK'; export PS1='KANDELO_''WEBKIT_SWITCH_OK $ '");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("KANDELO_WEBKIT_SWITCH_OK");
  expect(runtimeErrors).toEqual([]);
});
