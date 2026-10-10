// The inspector's file browser reads the machine's filesystem through the
// kernel worker: the main thread holds no filesystem handle of its own, so a
// listing or a file preview only appears if the worker answered the request.
// This is the browser half of the read path that host/test covers for Node.

import { expect, test } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

test("the inspector lists directories and previews files from the kernel-owned VFS", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoMachineOrSkip(page, "shell");
  const internals = page.getByRole("button", { name: "Internals" });
  await expect(internals).toBeEnabled({ timeout: 120_000 });
  await internals.click();
  await page.getByRole("tab", { name: "VFS", exact: true }).click();

  // The root listing: directories are named with a trailing slash.
  const row = (name: RegExp) => page.locator(".ktable tbody tr").filter({
    has: page.locator("td:first-child", { hasText: name }),
  }).first();
  await expect(row(/^etc\/$/)).toBeVisible({ timeout: 60_000 });
  await expect(row(/^bin\/$/)).toBeVisible();

  // Descend into /etc. Kinds, modes and sizes come from the worker's lstat;
  // owner names come from the guest's own /etc/passwd, read the same way.
  await row(/^etc\/$/).click();
  const passwd = row(/^passwd$/);
  await expect(passwd).toBeVisible({ timeout: 60_000 });
  await expect(passwd).toContainText("-rw-r--r--");
  await expect(passwd).toContainText("root");

  // Opening a file previews its real bytes.
  await passwd.click();
  await expect(page.getByText(/root:x:0:0:/).first()).toBeVisible({ timeout: 60_000 });

  // Kernel-owned virtual entries are visible in the same browser.
  await page.getByRole("button", { name: "/", exact: true }).click();
  await row(/^proc\/$/).click();
  await expect(row(/^self$/)).toBeVisible({ timeout: 60_000 });
  await expect(row(/^1\/$/)).toBeVisible();
  await row(/^1\/$/).click();
  await row(/^fd\/$/).click();
  await expect(page.getByText("Empty directory.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "/", exact: true }).click();
  await row(/^dev\/$/).click();
  await expect(row(/^null$/)).toBeVisible({ timeout: 60_000 });
  await expect(row(/^stdin$/)).toContainText("lrwxrwxrwx");
  await row(/^pts\/$/).click();
  await expect(row(/^\d+$/)).toBeVisible({ timeout: 60_000 });

  // A path that does not exist is an error, not an empty directory.
  await expect(row(/^definitely-not-here$/)).toHaveCount(0);
});
