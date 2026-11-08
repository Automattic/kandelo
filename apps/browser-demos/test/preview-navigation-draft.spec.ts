import { expect, test } from "../playwright-test";

test("a late preview load preserves an address being edited", async ({ page }) => {
  await page.route("**/navigation-contract/*.html", route => route.fulfill({
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    contentType: "text/html", body: `<body>${new URL(route.request().url()).pathname}</body>`,
  }));
  await page.goto("/test/fixtures/preview-navigation-fixture.html");
  await page.evaluate(async () => {
    const { mountPreviewNavigationFixture } = await import("/test/fixtures/preview-navigation-fixture.tsx");
    const container = document.createElement("div");
    document.body.replaceChildren(container);
    mountPreviewNavigationFixture(container);
  });
  const frame = page.frameLocator('iframe[title="Navigation target"]');
  const address = page.getByRole("textbox", { name: "Preview URL path" });
  await expect(frame.locator("body")).toContainText("source.html");
  await expect(address).toHaveValue("/source.html");
  await address.fill("/destination.html");
  // A delayed document load/redirect can finish while the user edits the
  // dock. Exercise the real frame's onLoad and location synchronization.
  await frame.locator("body").evaluate(() => { location.href = "late.html"; });
  await expect(frame.locator("body")).toContainText("late.html");
  await expect(address).toHaveValue("/destination.html");
  await expect(address).toBeFocused();
  await address.press("Enter");
  await expect(frame.locator("body")).toContainText("destination.html");
  await expect(address).toHaveValue("/destination.html");
  // Completing the edit must resume tracking ordinary in-frame navigation.
  await frame.locator("body").evaluate(() => { location.href = "settled.html"; });
  await expect(frame.locator("body")).toContainText("settled.html");
  await expect(address).toHaveValue("/settled.html");
});
