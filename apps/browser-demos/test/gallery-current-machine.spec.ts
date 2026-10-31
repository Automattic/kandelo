import { expect, test } from "@playwright/test";
import { gotoApp } from "./support/kandelo-machine";
import { configureNewComputer } from "./support/computer-library";

test("exactly one saved computer is marked current, across computers sharing an image @slow", async ({ page }) => {
  test.setTimeout(400_000);
  await gotoApp(page, "/");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 240_000 });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const current = page.locator("[data-computer-id]").filter({ has: page.locator(".kcomputer-details span", { hasText: / · Current$/ }) });
  await expect(current).toHaveCount(1);
  const firstId = await current.getAttribute("data-computer-id");
  await page.getByRole("dialog", { name: "Computer Library", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await configureNewComputer(page, "node", "Node.js");
  await page.getByRole("button", { name: "Create and boot", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("computer"), { timeout: 240_000 }).not.toBe(firstId);
  await expect(page.locator(".kmprogress-card")).toHaveCount(0, { timeout: 240_000 });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(current).toHaveCount(1);
  await expect(current).not.toHaveAttribute("data-computer-id", firstId!);
});
