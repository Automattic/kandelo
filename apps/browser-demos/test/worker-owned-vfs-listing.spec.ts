import { setInternalsOpen } from "./support/dock";
import { expect, test, type Page } from "@playwright/test";
import { gotoApp } from "./support/kandelo-machine";


async function openInternals(page: Page) {
  await setInternalsOpen(page, true);
}

test("the VFS inspector lists a worker-owned root filesystem", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoApp(page, "/?demo=shell");
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
