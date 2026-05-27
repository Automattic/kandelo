import { expect, test } from "@playwright/test";

async function gotoOrSkip(page: import("@playwright/test").Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built — Vite import error");
  }
}

test("@slow Kandelo Node demo reports npm version without crashing", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" || /Maximum call stack|Segmentation fault/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await gotoOrSkip(page, "/pages/kandelo/?demo=node");
  await page.waitForSelector("aside.kdemo", { timeout: 120_000 });
  await page.getByRole("button", { name: "npm" }).click();

  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout: 60_000 })
    .toContain("10.9.2");

  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain("Segmentation fault");
  expect(runtimeErrors).toEqual([]);
});
