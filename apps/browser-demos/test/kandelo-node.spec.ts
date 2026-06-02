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

test("standalone Node demo starts verbose npm install before exit", async ({ page }) => {
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
  await page.keyboard.type("npm install cowsay --verbose");
  await page.keyboard.press("Enter");

  const handle = await page.waitForFunction(
    () => {
      const text = document.querySelector(".xterm-rows")?.textContent || "";
      if (
        text.includes("npm verbose argv") &&
        text.includes('"install" "cowsay"') &&
        text.includes('"--loglevel" "verbose"')
      ) {
        return { kind: "verbose", text };
      }
      const exit = text.match(/\[exit [^\]]+\]/)?.[0];
      if (exit) return { kind: "exit", exit, text };
      return false;
    },
    undefined,
    { timeout: 60_000 },
  );
  const result = await handle.jsonValue() as { kind: string; exit?: string; text: string };

  expect(result.kind, result.text).toBe("verbose");
  expect(result.text).toContain("npm info using npm@10.9.2");
  expect(runtimeErrors).toEqual([]);
});
