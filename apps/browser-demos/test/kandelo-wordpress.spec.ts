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

test("@slow Kandelo WordPress/MariaDB installer reaches success page", async ({
  page,
}) => {
  test.setTimeout(600_000);

  await gotoOrSkip(page, "/?demo=wordpress-mariadb");
  await page.waitForSelector('iframe[src*="/app/"]', { timeout: 180_000 });

  const frame = page.frameLocator('iframe[src*="/app/"]');
  await expect(
    frame.locator("form#setup, form#language-chooser, .wp-core-ui").first(),
  ).toBeVisible({ timeout: 180_000 });

  if ((await frame.locator("form#language-chooser").count()) > 0) {
    await frame.locator("form#language-chooser [type='submit']").click();
    await expect(frame.locator("form#setup")).toBeVisible({ timeout: 60_000 });
  }

  await frame.locator("#weblog_title").fill("Kandelo MariaDB E2E");
  await frame.locator("#user_login").fill("admin");

  const password = "Testpass123!Testpass123!";
  const passField = frame.locator("#pass1");
  if ((await passField.count()) > 0) {
    await passField.fill(password);
  }
  const pass2Field = frame.locator("#pass2");
  if ((await pass2Field.count()) > 0 && await pass2Field.isVisible()) {
    await pass2Field.fill(password);
  }

  const weakPw = frame.locator("#pw_weak, .pw-weak input[type='checkbox']");
  if ((await weakPw.count()) > 0) {
    try {
      await weakPw.check({ timeout: 5000 });
    } catch {
      // Hidden by WordPress JS; no confirmation needed.
    }
  }

  await frame.locator("#admin_email").fill("admin@example.com");
  await frame.locator("#submit, [name='Submit']").click();

  await expect(
    frame.locator(".step, .install-success, h1").filter({ hasText: /success|installed|log in/i }).first(),
  ).toBeVisible({ timeout: 360_000 });
});
