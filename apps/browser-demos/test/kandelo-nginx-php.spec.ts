import { expect, test } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

// The nginx + PHP-FPM demo serves Adminer as its landing page, auto-connected
// to a SQLite database that PHP-FPM seeds on the first request. A successful
// boot lands directly on the database schema (no login form) showing the
// seeded bookstore tables. A phpinfo-style status page lives at /info.php.
test("@slow Kandelo nginx+PHP demo auto-logs Adminer into the seeded SQLite database", async ({
  page,
}) => {
  test.setTimeout(300_000);

  await gotoMachineOrSkip(page, "nginx-php");
  await page.waitForSelector('iframe[src*="/app/"]', { timeout: 180_000 });

  const frame = page.frameLocator('iframe[src*="/app/"]');

  // Auto-login drops us straight onto the schema page for the seeded database:
  // the two seeded tables must be visible, and no Adminer login form remains.
  await expect(frame.locator("body")).toContainText("authors", {
    timeout: 240_000,
  });
  await expect(frame.locator("body")).toContainText("books");
  await expect(frame.locator("body")).toContainText(/Kandelo SQLite demo/i);
  await expect(frame.locator('input[name="auth[db]"]')).toHaveCount(0);

  // The status page still renders through the same FastCGI stack.
  await frame.locator("body").evaluate(() => {
    window.location.href = "/app/info.php";
  });
  await expect(frame.locator("body")).toContainText("PHP-FPM on WebAssembly", {
    timeout: 120_000,
  });
});
