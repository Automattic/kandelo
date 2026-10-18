import { expect, test } from "@playwright/test";

/**
 * The names two people give themselves in a shared pair, and the one badge
 * that shows a name: the watching computer's, naming who it watches.
 *
 * Chromium only, for the same reason as `kandelo-network-share.spec.ts`:
 * only headless Chromium forms a loopback ICE pair.
 */

import {
  appUrl,
  closeDockPopovers,
  connectPeers,
  openNetworkPanel,
} from "./support/peer-pair";

test("names the person a watcher watches on its badge, and only there", async ({
  browser,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "only headless Chromium can form a loopback ICE pair",
  );
  test.setTimeout(300_000);
  expect(baseURL).toBeTruthy();

  const sharerContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const sharer = await sharerContext.newPage();
  const viewer = await viewerContext.newPage();
  try {
    await sharer.goto(appUrl("/?profile=shell"), { waitUntil: "domcontentloaded" });
    await connectPeers(sharer, viewer, (reason) => test.skip(true, reason));

    // Named after the link opened: a change crosses the wire as it is made.
    for (const [page, name] of [[sharer, "garply"], [viewer, "waldo"]] as const) {
      await openNetworkPanel(page);
      await page.getByLabel("Your nickname — how the other person sees you").fill(name);
    }
    await closeDockPopovers([sharer, viewer]);

    // The distinct viewer nickname proves the badge picks the watched
    // person's name, not any name in the pair.
    await expect(viewer.locator(".kdock-role")).toHaveText("garply", { timeout: 30_000 });
    await expect(sharer.locator(".kdock-role")).toHaveText("Sharing", { timeout: 30_000 });
  } finally {
    await viewerContext.close();
    await sharerContext.close();
  }
});
