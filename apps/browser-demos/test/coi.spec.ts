import { expect, test } from "@playwright/test";

test("Kandelo page is cross-origin isolated for SharedArrayBuffer", async ({
  page,
}) => {
  const response = await page.goto("/pages/kandelo/?mock=1", {
    waitUntil: "domcontentloaded",
  });

  expect(response, "navigation response").not.toBeNull();
  expect(response!.ok()).toBe(true);
  expect(response!.headers()["cross-origin-opener-policy"]).toBe(
    "same-origin",
  );
  expect(response!.headers()["cross-origin-embedder-policy"]).toBe(
    "require-corp",
  );

  await expect(page.locator("#kandelo-root")).toBeVisible();

  const isolation = await page.evaluate(() => ({
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBufferType: typeof SharedArrayBuffer,
  }));

  expect(isolation).toEqual({
    crossOriginIsolated: true,
    sharedArrayBufferType: "function",
  });
});
