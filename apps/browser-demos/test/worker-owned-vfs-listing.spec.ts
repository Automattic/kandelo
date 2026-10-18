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

async function openInternals(page: Page) {
  const internals = page.getByRole("button", { name: "Internals" });
  if ((await internals.getAttribute("aria-pressed")) !== "true") {
    await internals.click();
  }
}

test("the VFS inspector lists a worker-owned root filesystem", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=shell");
  await openInternals(page);
  await page.getByRole("tab", { name: "VFS" }).click();

  const etc = page.getByRole("row").filter({ hasText: "etc/" }).first();
  await expect(etc).toBeVisible({ timeout: 120_000 });
  await etc.click();

  const passwd = page.getByRole("row").filter({ hasText: "passwd" }).first();
  await expect(passwd).toBeVisible({ timeout: 30_000 });
  await expect(passwd).toContainText("-rw-r--r--");
  await expect(passwd).toContainText("root");
});
