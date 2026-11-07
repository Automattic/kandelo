import { expect, test } from "@playwright/test";

test("Internals preserves the user's choice as boot metadata is enriched", async ({ page, baseURL }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(new URL("/test/fixtures/internals-boot-ui.html", baseURL).href);
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  await expect(internals).toBeEnabled();
  await internals.click();
  await expect(internals).toHaveAttribute("aria-expanded", "true");

  const enrich = async (id: string, title: string, running: boolean) => {
    await page.evaluate(({ id, title, running }) => {
      (window as unknown as {
        __internalsBootTest: { enrich(id: string, title: string, running: boolean): void };
      }).__internalsBootTest.enrich(id, title, running);
    }, { id, title, running });
  };
  // Composition may enrich the descriptor while status is still booting.
  await enrich("resolved-image", "Resolved image", false);
  await expect(internals).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".kdock-internals-popover")).toBeVisible();

  await enrich("running-profile", "Running profile", true);
  await expect(internals).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".kdock-internals-popover")).toBeVisible();

  await internals.click();
  await expect(internals).toHaveAttribute("aria-expanded", "false");
  await enrich("final-profile", "Final profile", true);
  await expect(internals).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".kdock-internals-popover")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
