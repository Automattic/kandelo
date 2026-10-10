import { expect, test } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";

test("WordPress on FrankenPHP serves the preinstalled site and admin in Chromium", async ({ page, browserName }) => {
  test.setTimeout(360_000);
  test.skip(browserName !== "chromium", "FrankenPHP WordPress browser gate uses Chromium");
  test.skip(process.env.KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS !== "1", "Build and project WordPress, then set KANDELO_WORDPRESS_FRANKENPHP_UI_TESTS=1");
  await gotoMachine(page, "wordpress-frankenphp");

  const frame = page.frameLocator('iframe[title="WordPress on FrankenPHP"]');
  await Promise.race([
    expect(frame.locator("body")).toContainText("WordPress on Kandelo", { timeout: 240_000 }),
    page.locator('.kdock-status-text[data-status="error"]')
      .waitFor({ state: "attached", timeout: 240_000 })
      .then(async () => {
        const syslog = await page.locator(".ksys-line").allTextContents();
        throw new Error(`WordPress machine failed: ${syslog.slice(-20).join("\n")}`);
      }),
  ]);
  await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);

  if (!(await page.locator("aside.kdemo").count())) {
    await page.getByRole("button", { name: "Demo guide" }).click();
  }
  await page.getByRole("button", { name: /Log in as admin/i }).click();
  await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first())
    .toBeVisible({ timeout: 120_000 });
});
