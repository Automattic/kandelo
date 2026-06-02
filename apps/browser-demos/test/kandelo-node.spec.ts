import { expect, test } from "@playwright/test";

async function gotoOrSkip(page: import("@playwright/test").Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built — Vite import error");
  }
}

test("@slow Kandelo Node demo installs cowsay with npm", async ({ page }) => {
  test.setTimeout(240_000);
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
  await page.getByRole("button", { name: "Runtime check" }).click();

  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout: 90_000 })
    .toContain("worker 7");

  await page.getByRole("button", { name: "Install cowsay" }).click();
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout: 120_000 })
    .toContain("< Kandelo >");
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout: 30_000 })
    .toContain("npm install cowsay");

  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain("Segmentation fault");
  expect(runtimeErrors).toEqual([]);
});

test("standalone Node demo runs npm CLI", async ({ page }) => {
  test.setTimeout(90_000);
  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" || /Maximum call stack|Segmentation fault/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await gotoOrSkip(page, "/pages/node/");
  await page.waitForSelector(".xterm-rows", { timeout: 60_000 });
  await page.click("#terminal");
  await page.keyboard.type("npm --version");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => page.locator(".xterm-rows").evaluate((el) => el.textContent || ""), {
      timeout: 60_000,
    })
    .toContain("10.9.2");
  await expect
    .poll(() => page.locator(".xterm-rows").evaluate((el) => el.textContent || ""), {
      timeout: 30_000,
    })
    .toContain("[exit 0");

  expect(runtimeErrors).toEqual([]);
});

test("standalone Node demo installs cowsay before exit", async ({ page }) => {
  test.setTimeout(240_000);
  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" || /Maximum call stack|Segmentation fault/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await gotoOrSkip(page, "/pages/node/");
  await page.waitForSelector(".xterm-rows", { timeout: 60_000 });
  await page.click("#terminal");
  await page.keyboard.type("npm install cowsay && cowsay 'Hello Kandelo'");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => page.locator(".xterm-rows").evaluate((el) => el.textContent || ""), {
      timeout: 180_000,
    })
    .toContain("< Hello Kandelo >");
  await expect
    .poll(() => page.locator(".xterm-rows").evaluate((el) => el.textContent || ""), {
      timeout: 30_000,
    })
    .toContain("[exit 0");

  expect(runtimeErrors).toEqual([]);
});
