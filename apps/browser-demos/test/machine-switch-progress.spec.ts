// A real switch between two machines that share one VFS image. Unit tests
// cannot prove this: which pane is mounted during a switch is chosen at
// runtime, so a correctly-built overlay can still be invisible.

import { expect, test } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test("a machine switch shows teardown then load progress @slow", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(browserName !== "chromium", "needs CDP network emulation");
  test.setTimeout(400_000);

  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });

  // Throttle before the second boot so the image load is observable.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: (4 * 1024 * 1024) / 8,
    uploadThroughput: (1 * 1024 * 1024) / 8,
  });

  const headlines: string[] = [];
  await page.exposeFunction("__recordHeadline", (text: string) => {
    if (text && headlines.at(-1) !== text) headlines.push(text);
  });
  await page.evaluate(() => {
    setInterval(() => {
      const el = document.querySelector(".kmprogress-headline");
      if (el) {
        (window as unknown as {
          __recordHeadline: (t: string) => void;
        }).__recordHeadline(el.textContent ?? "");
      }
    }, 50);
  });

  await page.getByRole("button", { name: /^(New|Launch new computer)$/ })
    .first().click();
  await page.locator("tr.kgal-row").first().waitFor();
  await page.locator('tr.kgal-row:not([data-current="true"])')
    .filter({ hasText: /Node\.js/i }).first().click();

  await expect(page.locator(".kmprogress-card")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });
  await expect(page.locator(".kmprogress-card")).toHaveCount(0);

  expect(headlines.some((h) => h.startsWith("Unloading"))).toBe(true);
  expect(headlines.some((h) => h.startsWith("Loading"))).toBe(true);
});
