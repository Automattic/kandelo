// The dock's More menu opens the credits list, rendered from the same shared
// data as the docs site's Credits page.

import { expect, test } from "@playwright/test";
import { CREDITS, CREDITS_DEVELOPER } from "../../../web-libs/kandelo-session/src/credits";
import { gotoApp } from "./support/kandelo-machine";

test("the More menu opens and closes the credits dialog", async ({ page }) => {
  await gotoApp(page, "/");

  await page.getByTitle("More tools and help").click();
  await page.getByTestId("open-credits").click();
  const dialog = page.getByTestId("credits-dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: CREDITS_DEVELOPER.name, exact: true }),
  ).toHaveAttribute("href", CREDITS_DEVELOPER.url);

  for (const section of CREDITS) {
    await expect(dialog.getByText(section.title, { exact: true })).toBeVisible();
    for (const entry of section.entries) {
      const link = dialog.getByRole("link", { name: entry.name, exact: true });
      await expect(link).toHaveAttribute("href", entry.url);
    }
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
