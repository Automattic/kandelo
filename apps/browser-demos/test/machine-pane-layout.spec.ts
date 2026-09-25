// The panes must fill the space above the dock.
//
// A wrapper div added around the app content (to carry `inert` during a
// machine switch) sat between `.kapp` (a flex container) and `.kmain`
// (`flex: 1`). That made `.kmain` size to its content instead of filling, so
// the terminal fitted to about two characters wide and the web preview
// rendered as a small box in the corner. Nothing else caught it: the panes
// were present, visible, and hit-testable -- just tiny.

import { expect, test } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test("the terminal fills the width and height above the dock @slow", async ({
  page,
}) => {
  test.setTimeout(400_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 240_000,
  });

  const measured = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    return {
      viewportWidth: window.innerWidth,
      main: box(".kmain"),
      screen: box(".xterm-screen"),
    };
  });

  // `.kmain` spans the viewport rather than collapsing to its content.
  expect(measured.main?.width).toBe(measured.viewportWidth);

  // The terminal itself is wide enough for real output. The regression left
  // this near a single character, so a generous floor still catches it while
  // staying robust to fonts and padding.
  expect(measured.screen?.width ?? 0).toBeGreaterThan(
    measured.viewportWidth * 0.8,
  );
  expect(measured.screen?.height ?? 0).toBeGreaterThan(300);
});
