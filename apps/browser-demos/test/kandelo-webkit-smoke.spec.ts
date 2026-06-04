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

test("Kandelo shell demo boots and accepts terminal input in WebKit", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=shell");
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout: 180_000 })
    .toContain("Ready");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });

  await page.locator(".kshell-host").first().click();
  await page.keyboard.insertText("printf 'KANDELO_%s\\n' 'WEBKIT_OK'; export PS1='KANDELO_''WEBKIT_OK $ '");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("KANDELO_WEBKIT_OK");
});
