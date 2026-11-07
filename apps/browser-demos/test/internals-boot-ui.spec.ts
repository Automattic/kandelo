import { expect, test } from "../playwright-test";
import { dockTool, setInternalsOpen } from "./support/dock";

test("Internals preserves the user's choice as boot metadata is enriched", async ({ page, baseURL }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(new URL("/test/fixtures/internals-boot-ui.html", baseURL).href);
  await dockTool(page, "Internals");
  // More closes after selection; its hidden menu still publishes the real
  // toggle state while the independently mounted Internals dialog stays open.
  const internals = page.getByRole("dialog", { name: "More tools and help", exact: true, includeHidden: true })
    .getByRole("button", { name: "Internals", exact: true, includeHidden: true });
  await expect(internals).toBeEnabled();
  await internals.click();
  await expect(internals).toHaveAttribute("aria-pressed", "true");

  const enrich = async (id: string, title: string, running: boolean) => {
    await page.evaluate(({ id, title, running }) => {
      (window as unknown as {
        __internalsBootTest: { enrich(id: string, title: string, running: boolean): void };
      }).__internalsBootTest.enrich(id, title, running);
    }, { id, title, running });
  };
  // Composition may enrich the descriptor while status is still booting.
  await enrich("resolved-image", "Resolved image", false);
  await expect(internals).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".kdock-internals-popover")).toBeVisible();

  await enrich("running-profile", "Running profile", true);
  await expect(internals).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".kdock-internals-popover")).toBeVisible();

  await setInternalsOpen(page, false);
  await expect(internals).toHaveAttribute("aria-pressed", "false");
  await enrich("final-profile", "Final profile", true);
  await expect(internals).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".kdock-internals-popover")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
