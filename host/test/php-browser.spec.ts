/**
 * Playwright test — runs PHP CLI in a real Chromium browser via wasm-posix-kernel.
 *
 * This verifies the browser code path: VirtualPlatformIO + MemoryFileSystem +
 * BrowserTimeProvider + SharedArrayBuffer, which differs significantly from the
 * Node.js path tested in examples/libs/php/test/php-hello.test.ts.
 *
 * Run: cd host && npx playwright test
 */

import { test, expect } from "@playwright/test";

test("PHP CLI runs Hello World, session, SQLite, fileinfo, and XML in the browser", async ({ page }) => {
  await page.goto("/");

  // Wait for the test harness to finish (up to 120s for multiple PHP runs)
  await page.waitForFunction(
    () => {
      const status = document.getElementById("status");
      return status && (status.textContent === "done" || status.textContent === "error");
    },
    { timeout: 120_000 },
  );

  const status = await page.locator("#status").textContent();
  const stderr = await page.locator("#stderr").textContent();
  const resultsText = await page.locator("#results").textContent();

  if (status === "error") {
    console.log("STDERR:", stderr);
    console.log("RESULTS:", resultsText);
  }

  expect(status).toBe("done");

  const results = JSON.parse(resultsText!);
  expect(results.hello).toContain("Hello World");
  expect(results.session).toContain("session-ok");
  expect(results.sqlite).toContain("sqlite-ok");
  expect(results.fileinfo).toContain("image/gif");
  expect(results.xml).toContain("xml-ok");
});
