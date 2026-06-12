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

test("@slow Kandelo WordPress/MariaDB mysqli transport benchmark returns", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=wordpress-mariadb");
  await page.waitForSelector('iframe[src*="/app/"]', { timeout: 180_000 });

  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), 90_000);
    try {
      const response = await fetch(
        `/app/kandelo-mysql-bench.php?connect_iters=1&query_iters=1&include_persistent=1&ts=${Date.now()}`,
        { cache: "no-store", signal: controller.signal },
      );
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        text,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  });

  expect(result.ok, result.text).toBe(true);
  const data = JSON.parse(result.text);
  expect(data.include_persistent).toBe(true);
  expect(Object.keys(data.variants).sort()).toEqual([
    "tcp",
    "tcp_persistent",
    "unix",
    "unix_persistent",
  ]);
  expect(data.variants.unix.error).toBeUndefined();
  expect(data.variants.tcp.error).toBeUndefined();
  expect(data.variants.unix_persistent.error).toBeUndefined();
  expect(data.variants.tcp_persistent.error).toBeUndefined();
});

test("@slow Kandelo WordPress/MariaDB preinstalled site logs into wp-admin", async ({
  page,
}) => {
  test.setTimeout(420_000);

  await gotoOrSkip(page, "/?demo=wordpress-mariadb");
  await page.waitForSelector('iframe[src*="/app/"]', { timeout: 180_000 });

  const frame = page.frameLocator('iframe[src*="/app/"]');
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, {
    timeout: 240_000,
  });
  await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);

  await frame.locator("body").evaluate(() => {
    window.location.href = "/app/wp-login.php";
  });

  await expect(frame.locator("#loginform")).toBeVisible({ timeout: 120_000 });
  await frame.locator("#user_login").fill("admin");
  await frame.locator("#user_pass").fill("password");
  await frame.locator("#wp-submit").click();
  await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first()).toBeVisible({
    timeout: 180_000,
  });
});
