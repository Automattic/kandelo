import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const imagePath = process.env.KANDELO_WORDPRESS_FRANKENPHP_VFS;

test("WordPress on FrankenPHP serves the preinstalled site and admin in Chromium", async ({ page, baseURL, browserName }) => {
  test.setTimeout(360_000);
  test.skip(browserName !== "chromium", "FrankenPHP WordPress browser gate uses Chromium");
  test.skip(!imagePath, "Build the WordPress image and set KANDELO_WORDPRESS_FRANKENPHP_VFS");
  expect(baseURL).toBeTruthy();

  const imageUrl = new URL("/__wordpress_frankenphp__.vfs.zst", baseURL!).href;
  const image = readFileSync(imagePath!);
  await page.route(imageUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/octet-stream",
    body: image,
  }));

  const url = new URL("/", baseURL!);
  url.searchParams.set("vfs", imageUrl);
  url.searchParams.set("profile", "wordpress-frankenphp");
  await page.goto(url.href, { waitUntil: "domcontentloaded" });

  const frame = page.frameLocator('iframe[title="WordPress on FrankenPHP"]');
  await expect(frame.locator("body")).toContainText("WordPress on Kandelo", { timeout: 240_000 });
  await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);

  if (!(await page.locator("aside.kdemo").count())) {
    await page.getByRole("button", { name: "Demo guide" }).click();
  }
  await page.getByRole("button", { name: /Log in as admin/i }).click();
  await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first())
    .toBeVisible({ timeout: 120_000 });
});
