import { expect, test } from "@playwright/test";
import { gotoInPreview } from "./support/kandelo-machine";

test("preview navigation waits for the destination document to commit", async ({ page, baseURL }) => {
  let releaseResponse!: () => void;
  let observeRequest!: () => void;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  const requestObserved = new Promise<void>(resolve => { observeRequest = resolve; });
  const origin = new URL("/navigation-contract/", baseURL);
  await page.route(new URL("host.html", origin).href, route => route.fulfill({
    contentType: "text/html", body: '<iframe title="navigation target" src="source.html"></iframe>',
  }));
  await page.route(new URL("source.html", origin).href, route => route.fulfill({
    contentType: "text/html", body: "<body>Original document</body>",
  }));
  await page.route(new URL("destination.html", origin).href, async route => {
    observeRequest();
    await responseGate;
    await route.fulfill({ contentType: "text/html", body: '<form id="destination-form">Destination document</form>' });
  });
  await page.goto(new URL("host.html", origin).href);
  const frame = page.frameLocator('iframe[title="navigation target"]');
  await expect(frame.locator("body")).toContainText("Original document");
  let navigationResolved = false;
  const navigation = gotoInPreview(frame, origin.pathname, "destination.html").then(() => { navigationResolved = true; });
  try {
    await requestObserved;
    await page.evaluate(() => document.readyState);
    expect(navigationResolved).toBe(false);
  } finally {
    releaseResponse();
    await navigation;
  }
  await expect(frame.locator("#destination-form")).toBeVisible();
  expect(page.frames().some(child => child.url() === new URL("destination.html", origin).href)).toBe(true);
});
