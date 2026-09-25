// The progress bar must appear on the surface a booting machine actually
// shows. No component test can prove this: MachineView picks the mounted pane
// from `presentation.bootPrimary`, so a bar attached to a pane that boot does
// not select passes every unit test and is never seen by a user.

import { expect, test } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

const bar = "[role=progressbar]";

test("the boot screen shows image progress during a real boot @slow", async ({
  browserName,
  context,
  page,
}) => {
  // Throttling is a Chromium DevTools capability; the assertion is about
  // placement, which is not browser-specific.
  test.skip(browserName !== "chromium", "needs CDP network emulation");
  test.setTimeout(400_000);

  // Slow the transfer so the load is observable. Delaying the response START
  // is not enough: the body would still arrive in one burst and the bar would
  // exist for a few milliseconds.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: (4 * 1024 * 1024) / 8,
    uploadThroughput: (1 * 1024 * 1024) / 8,
  });

  await page.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });

  const progressBar = page.locator(bar);
  await expect(progressBar).toBeVisible({ timeout: 60_000 });
  await expect(progressBar).toHaveAttribute("aria-label", /image/i);

  // A real percentage, and a bar with real dimensions rather than a
  // zero-height div that only looks present to a DOM query.
  const box = await progressBar.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);
  const valueNow = Number(await progressBar.getAttribute("aria-valuenow"));
  expect(valueNow).toBeGreaterThanOrEqual(0);
  expect(valueNow).toBeLessThanOrEqual(100);

  // And it clears once the machine is up.
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });
  await expect(progressBar).toHaveCount(0);
});
