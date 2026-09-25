// One VFS image declares several machines, so "which row is current" cannot be
// answered from the image URL. A unit test covers the matcher; this covers the
// wiring — that the Gallery hands it the identity it needs.

import { expect, test, type Page } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

const CURRENT_ROW = 'tr.kgal-row[data-current="true"]';

async function openGallery(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /^(New|Launch new computer)$/ })
    .first()
    .click();
  await expect(page.locator("tr.kgal-row").first()).toBeVisible();
}

test("exactly one machine is marked current, across machines sharing an image @slow", async ({
  page,
}) => {
  test.setTimeout(400_000);

  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });

  await openGallery(page);
  const rows = await page.locator("tr.kgal-row").count();
  expect(rows).toBeGreaterThan(1);
  await expect(page.locator(CURRENT_ROW)).toHaveCount(1);
  const firstCurrent = await page.locator(CURRENT_ROW).textContent();

  // Launch a different machine that lives in the same image as the first.
  // browser-main-shell backs shell, node, doom, modeset, sdl2, evdev, espeak.
  const sibling = page
    .locator('tr.kgal-row:not([data-current="true"])')
    .filter({ hasText: /Node\.js/i })
    .first();
  await sibling.click();

  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });
  await openGallery(page);

  // Still exactly one — and a different row than before.
  await expect(page.locator(CURRENT_ROW)).toHaveCount(1);
  await expect(page.locator(CURRENT_ROW)).not.toHaveText(firstCurrent ?? "");
});
