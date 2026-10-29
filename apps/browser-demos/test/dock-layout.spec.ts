import { expect, test } from "@playwright/test";

test("full dock keeps its layout buttons and its tool row", async ({ page }) => {
  await page.goto("/test/fixtures/dock-layout.html");
  await expect(page.getByRole("button", { name: "Hide dock tools" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use compact dock" })).toBeVisible();
  await expect(page.locator(".kdock-row")).toBeVisible();
  await expect(page.locator(".kdock-top-row").getByRole("button", { name: "Terminal" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Theme" })).toBeEnabled();
});

test("minimal dock keeps only header buttons, with Terminal and Internals", async ({ page }) => {
  await page.goto("/test/fixtures/dock-layout.html?minimal");
  await expect(page.locator(".kdock-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hide dock tools" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use compact dock" })).toHaveCount(0);
  await expect(page.locator(".kdock-shell")).toHaveClass(/kdock-full-width/);

  const terminal = page.locator(".kdock-top-row").getByRole("button", { name: "Terminal" });
  await terminal.click();
  await expect(page.getByTestId("view")).toHaveText("terminal");
  await expect(terminal).toHaveAttribute("aria-pressed", "true");
  await terminal.click();
  await expect(page.getByTestId("view")).toHaveText("demo");

  await page.locator(".kdock-top-row").getByRole("button", { name: "Internals" }).click();
  await expect(page.getByText("Internals popup")).toBeVisible();
});

test("a fixed theme disables the theme button", async ({ page }) => {
  await page.goto("/test/fixtures/dock-layout.html?theme");
  await expect(page.getByRole("button", { name: "Theme" })).toBeDisabled();
});
