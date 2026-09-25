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
  // 50ms is deliberately short. If it ever misses a very fast phase on a
  // faster machine, the failure direction is a false NEGATIVE (the test
  // fails because a headline is missing) -- never a false pass. Do not
  // "optimise" this interval upward; a longer interval trades a safe
  // failure mode for an unsafe one.
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

  const firstUnloading = headlines.findIndex((h) => h.startsWith("Unloading"));
  const firstLoading = headlines.findIndex((h) => h.startsWith("Loading"));

  expect(firstUnloading, `headlines seen: ${JSON.stringify(headlines)}`)
    .toBeGreaterThanOrEqual(0);
  expect(firstLoading, `headlines seen: ${JSON.stringify(headlines)}`)
    .toBeGreaterThanOrEqual(0);
  // Teardown precedes the load: the outgoing machine is destroyed before the
  // incoming image is read. Asserting only presence would pass if the two
  // phases were emitted in the wrong order.
  expect(firstUnloading, `headlines seen: ${JSON.stringify(headlines)}`)
    .toBeLessThan(firstLoading);

  // A degraded headline that kept the right prefix but lost its subject
  // (e.g. "Unloading" with nothing after it) must not pass. Do not hard-code
  // a specific machine or image name here -- the roster can change -- but
  // require a non-empty subject after the verb.
  expect(headlines[firstUnloading]).toMatch(/^Unloading \S/);
  expect(headlines[firstLoading]).toMatch(/^Loading \S/);
});
