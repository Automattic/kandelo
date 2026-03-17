/**
 * Playwright test — runs PHP CLI in a real Chromium browser via wasm-posix-kernel.
 *
 * This verifies the browser code path: VirtualPlatformIO + MemoryFileSystem +
 * BrowserTimeProvider + SharedArrayBuffer, which differs significantly from the
 * Node.js path tested in examples/libs/php/test/php-hello.test.ts.
 *
 * The browser harness runs multiple PHP tests (inline, file-based, extensions)
 * and reports all results as JSON in the #results element.
 *
 * Run: cd host && npx playwright test
 */

import { test, expect } from "@playwright/test";

test("PHP CLI runs in the browser (inline, file, session, SQLite, fileinfo, XML, extensions)", async ({ page }) => {
  await page.goto("/");

  // Wait for all tests to finish (up to 120s — multiple sequential PHP runs)
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
  const exitCode = await page.locator("#exit-code").textContent();

  if (status === "error" || exitCode !== "0") {
    console.log("STDERR:", stderr);
    console.log("RESULTS:", resultsText);
  }

  expect(status).toBe("done");

  const results = JSON.parse(resultsText!);

  // Inline
  expect(results.hello).toContain("Hello World");

  // File-based execution
  expect(results.file).toContain("Browser File OK");

  // Extensions (mbstring + ctype)
  const extData = JSON.parse(results.extensions);
  expect(extData.mb).toBe(5);
  expect(extData.ctype).toBe("yes");

  // Session
  expect(results.session).toContain("session-ok");

  // SQLite3
  expect(results.sqlite).toContain("sqlite-ok");

  // fileinfo
  expect(results.fileinfo).toContain("image/gif");

  // SimpleXML
  expect(results.xml).toContain("xml-ok");
});
