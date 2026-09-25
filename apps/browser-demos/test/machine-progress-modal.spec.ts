import { expect, test } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test("the overlay is modal while a switch is in flight @slow", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(browserName !== "chromium", "needs CDP network emulation");
  test.setTimeout(400_000);

  // Slow the image transfer so the overlay is observable; without this a
  // locally served image lands before the first assertion runs.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: (4 * 1024 * 1024) / 8,
    uploadThroughput: (1 * 1024 * 1024) / 8,
  });

  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });

  // While the overlay is up, the app content behind it must be inert, so a
  // keyboard user cannot tab into a machine that is not there.
  await expect(page.locator(".kmprogress-card")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-machine-content][inert]")).toHaveCount(1);

  // And it must be released once the machine is up.
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });
  await expect(page.locator(".kmprogress-card")).toHaveCount(0);
  await expect(page.locator("[data-machine-content][inert]")).toHaveCount(0);
  await expect(page.locator("[data-machine-content]")).toHaveCount(1);
});
