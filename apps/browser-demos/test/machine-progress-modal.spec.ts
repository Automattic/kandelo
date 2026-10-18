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

  // toBeVisible() does not consider occlusion: an overlay painted UNDER the
  // dock still "passes" while being invisible to the user. Hit-test instead.
  const occluded = await page.evaluate(() => {
    const card = document.querySelector(".kmprogress-card");
    if (!card) return "no card";
    // The app marks its main content `inert` while a switch is in flight
    // (see the assertion just below), and Chromium's hit-testing excludes
    // inert subtrees entirely -- elementFromPoint "sees through" an inert
    // node straight to whatever is behind it, even one that fully covers the
    // point on screen. Lift inertness for this synchronous check only:
    // nothing repaints and nothing becomes interactively reachable in
    // between removing and restoring the attribute, so this never changes
    // what a real user could do. See machine-switch-progress.spec.ts, where
    // this exact interaction let a fully gallery-covered overlay hit-test as
    // "on top" while a screenshot showed it was completely invisible.
    const inertHosts = Array.from(document.querySelectorAll("[inert]"));
    for (const host of inertHosts) host.removeAttribute("inert");
    try {
      const r = card.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit && card.contains(hit) ? null : (hit?.className ?? "unknown");
    } finally {
      for (const host of inertHosts) host.setAttribute("inert", "");
    }
  });
  expect(occluded, "something is painted over the progress card").toBeNull();

  await expect(page.locator("[data-machine-content][inert]")).toHaveCount(1);

  // And it must be released once the machine is up.
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });
  await expect(page.locator(".kmprogress-card")).toHaveCount(0);
  await expect(page.locator("[data-machine-content][inert]")).toHaveCount(0);
  await expect(page.locator("[data-machine-content]")).toHaveCount(1);
});
