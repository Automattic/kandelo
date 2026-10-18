import { expect, test, type Page } from "@playwright/test";

/**
 * The Omarchy desktop, running on two computers at once.
 *
 * `kandelo-machine-replication.spec.ts` proves replication on a shell. This
 * spec proves it on the largest machine the gallery offers: a GL compositor,
 * one Quickshell process with its worker threads, and the clients the user
 * opens. Joining checkpoints every thread of every process, so each one must
 * idle on a stack the instrumenter covered; a thread that does not makes the
 * join time out.
 *
 * Chromium only: only headless Chromium forms a loopback ICE pair.
 */

import {
  appUrl,
  closeDockPopovers,
  connectPeers,
  expectReplica,
} from "./support/peer-pair";

async function launchOmarchy(page: Page): Promise<void> {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: /^(New|Launch new computer)$/ })
    .first()
    .click();
  await page.locator("tr.kgal-row").filter({ hasText: /Omarchy/i }).first().click();
}

async function openSurface(page: Page, label: "Demo" | "Terminal"): Promise<void> {
  const view = page
    .getByLabel("Computer views")
    .getByRole("button", { name: label, exact: true });
  if ((await view.getAttribute("aria-current")) !== "true") await view.click();
}

async function terminalText(page: Page): Promise<string> {
  if ((await page.locator(".xterm-rows").count()) === 0) return "";
  const rows = await page.locator(".xterm-rows").first().locator(":scope > div").allInnerTexts();
  return rows.join("\n");
}

async function expectTerminal(page: Page, pattern: RegExp, timeout: number): Promise<void> {
  await openSurface(page, "Terminal");
  await expect.poll(() => terminalText(page), { timeout }).toMatch(pattern);
}

async function pressCtrl(page: Page, key: string): Promise<void> {
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
}

const canvasLocator = (page: Page) =>
  page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();

test("runs the user's Omarchy desktop on the computer that joins it", async ({
  browser,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "only headless Chromium can form a loopback ICE pair");
  test.setTimeout(600_000);
  expect(baseURL).toBeTruthy();

  const userContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const user = await userContext.newPage();
  const viewer = await viewerContext.newPage();
  // A replica that falls back to serving its tasks as they come still runs,
  // so only the kernel worker's own report shows that it left the order.
  const fallbacks: string[] = [];
  viewer.on("worker", (worker) => worker.on("console", (message) => {
    if (message.text().includes("stopped following the dispatch order")) {
      fallbacks.push(message.text());
    }
  }));
  try {
    await launchOmarchy(user);
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await expectTerminal(user, /SHELL_READY/, 240_000);

    await connectPeers(user, viewer, (reason) => test.skip(true, reason));
    // The join checkpoints the whole desktop: the compositor, Quickshell and
    // its threads, and the shells. A thread idling on an uncovered stack
    // never unwinds, and the viewer never comes up running.
    await expectReplica(viewer);
    await closeDockPopovers([user, viewer]);

    // The viewer draws the desktop itself, from the restored compositor.
    await openSurface(viewer, "Demo");
    const canvas = canvasLocator(viewer);
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => (await canvas.screenshot()).byteLength, {
        timeout: 120_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toBeGreaterThan(12_000);

    // The user opens a window. The keystroke travels as a decision in the
    // log, so the replica's compositor tiles the same window.
    await pressCtrl(user, "KeyK");
    await expectTerminal(user, /TILE n=1 i=0 /, 60_000);
    await expectTerminal(viewer, /TILE n=1 i=0 /, 120_000);

    // Every task on the replica took its turns in the primary's order.
    expect(fallbacks).toEqual([]);
  } finally {
    await viewerContext.close();
    await userContext.close();
  }
});
