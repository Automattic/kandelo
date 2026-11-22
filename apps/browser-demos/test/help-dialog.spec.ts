import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";

test("More opens a simple introduction with file export instructions", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto("/test/fixtures/internals-boot-ui.html");
  const more = page.getByTitle("More tools and help");
  await more.click();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Welcome to Kandelo" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Get files out" })).toBeVisible();
  await expect(dialog.locator("pre")).toHaveText("kandelo-publish ./report.pdf");
  await expect(dialog.getByRole("link", { name: "Read the user guide" })).toHaveAttribute("href", "https://automattic.github.io/kandelo/guide/");
  await expect(dialog.getByRole("searchbox")).toHaveCount(0);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: fileURLToPath(new URL("../../../.context/simple-help.png", import.meta.url)) });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
});

test("the readme fits a narrow screen and scrolls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/test/fixtures/help-dialog.html");
  const dialog = page.getByRole("dialog", { name: "Welcome to Kandelo" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("link", { name: "Read the user guide" }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("link", { name: "Send feedback" })).toBeVisible();
  await dialog.evaluate(element => { element.scrollTop = 0; });
  if (testInfo.project.name === "chromium") await page.screenshot({ path: fileURLToPath(new URL("../../../.context/simple-help-mobile.png", import.meta.url)) });
});

test("Help is available when computer setup fails", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "getDirectory", { value: async () => {
      throw new DOMException("help test storage unavailable", "UnknownError");
    } });
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Opening browser computer storage");
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Welcome to Kandelo" })).toBeVisible();
});
