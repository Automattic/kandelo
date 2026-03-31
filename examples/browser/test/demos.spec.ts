/**
 * E2E browser demo tests — validates each demo page starts successfully.
 *
 * Run all:       cd examples/browser && npx playwright test
 * Fast only:     cd examples/browser && npx playwright test --grep-invert @slow
 *
 * Tests that require binaries not yet built (nginx, dash, php, mariadb) will
 * skip automatically when Vite shows an import error overlay.
 */

import { test, expect, type Page } from "@playwright/test";

// Helper: navigate and skip if Vite can't resolve imports (binary not built)
async function gotoOrSkip(page: Page, path: string) {
  await page.goto(path);
  // Give Vite a moment to show error overlay if imports fail
  await page.waitForTimeout(2000);
  const hasErrorOverlay = await page.evaluate(() => {
    return !!document.querySelector("vite-error-overlay");
  });
  if (hasErrorOverlay) {
    test.skip(true, "Required binary not built — Vite import error");
  }
}

// Helper: wait for text to appear in an element
async function waitForText(
  page: Page,
  selector: string,
  text: string,
  timeout = 60_000,
) {
  await page.waitForFunction(
    ({ sel, txt }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return (el.textContent || "").includes(txt);
    },
    { sel: selector, txt: text },
    { timeout },
  );
}

// Helper: check that no error class appeared on #status
async function assertNoError(page: Page) {
  const statusEl = page.locator("#status");
  if ((await statusEl.count()) > 0) {
    const className = await statusEl.getAttribute("class");
    if (className?.includes("error")) {
      const text = await statusEl.textContent();
      throw new Error(`Status shows error: ${text}`);
    }
  }
}

// Helper: wait for status to show "running" class
async function waitForRunning(page: Page, timeout = 60_000) {
  await page.waitForFunction(
    () => {
      const s = document.getElementById("status");
      return s?.className?.includes("running");
    },
    { timeout },
  );
}

// ─── Simple C Programs ───────────────────────────────────────────────

test("simple: runs hello program", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#program", "hello");
  await page.click("#run");
  await waitForText(page, "#output", "Exited with code 0");

  const output = await page.locator("#output").textContent();
  expect(output).toContain("Hello");
});

test("simple: runs files program", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#program", "files");
  await page.click("#run");
  await waitForText(page, "#output", "Exited with code 0");
});

test("simple: runs dirs program", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#program", "dirs");
  await page.click("#run");
  await waitForText(page, "#output", "Exited with code 0");
});

// ─── Shell (batch mode) ─────────────────────────────────────────────

test("shell: runs batch script", async ({ page }) => {
  await gotoOrSkip(page, "/pages/shell/");

  await page.click("#mode-batch");
  await page.fill("#code", 'echo "E2E_TEST_OK"\n');
  await page.click("#run");

  await waitForText(page, "#batch-output", "E2E_TEST_OK", 30_000);
  const output = await page.locator("#batch-output").textContent();
  expect(output).toContain("E2E_TEST_OK");
  await assertNoError(page);
});

// ─── nginx ──────────────────────────────────────────────────────────

test("nginx: starts and serves page", async ({ page }) => {
  await gotoOrSkip(page, "/pages/nginx/");
  await page.click("#start");
  await waitForRunning(page, 60_000);

  const log = await page.locator("#log").textContent();
  expect(log).toContain("nginx");
  await assertNoError(page);
});

// ─── PHP CLI ────────────────────────────────────────────────────────

test("@slow php: runs hello world", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoOrSkip(page, "/pages/php/");

  await page.click("#run");
  await waitForText(page, "#output", "PHP version:", 90_000);

  const output = await page.locator("#output").textContent();
  expect(output).toContain("Hello from PHP");
  expect(output).toContain("PHP version:");
});

// ─── nginx + PHP-FPM ────────────────────────────────────────────────

test("@slow nginx-php: starts and shows running", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoOrSkip(page, "/pages/nginx-php/");

  await page.click("#start");
  await waitForRunning(page, 90_000);

  const log = await page.locator("#log").textContent();
  expect(log).toContain("nginx");
  expect(log).toContain("PHP-FPM");
  await assertNoError(page);
});

// ─── MariaDB ────────────────────────────────────────────────────────

test("@slow mariadb: bootstraps and accepts queries", async ({ page }) => {
  test.setTimeout(300_000);
  await gotoOrSkip(page, "/pages/mariadb/");

  await page.click("#start");

  // Wait for MariaDB to be ready (execute button enabled)
  await page.waitForFunction(
    () => {
      const btn = document.getElementById("execute") as HTMLButtonElement;
      return btn && !btn.disabled;
    },
    { timeout: 240_000 },
  );

  const result = await page.locator("#result").textContent();
  expect(result).toContain("MariaDB");
  await assertNoError(page);
});

// ─── Redis ─────────────────────────────────────────────────────

test("@slow redis: starts and accepts commands", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoOrSkip(page, "/pages/redis/");

  await page.click("#start");

  // Wait for execute button to be enabled (Redis is ready)
  await page.waitForFunction(
    () => {
      const btn = document.getElementById("execute") as HTMLButtonElement;
      return btn && !btn.disabled;
    },
    { timeout: 90_000 },
  );

  // Verify PING worked during startup
  const log = await page.locator("#log").textContent();
  expect(log).toContain("Connected!");
  expect(log).toContain("PONG");

  // Send a SET command
  await page.fill("#cmd", "SET e2e_key hello_world");
  await page.click("#execute");
  await waitForText(page, "#result", "OK", 10_000);

  // Send a GET command
  await page.fill("#cmd", "GET e2e_key");
  await page.click("#execute");
  await waitForText(page, "#result", "hello_world", 10_000);

  await assertNoError(page);
});

// ─── WordPress ──────────────────────────────────────────────────────

test("@slow wordpress: loads and shows running", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoOrSkip(page, "/pages/wordpress/");

  await page.click("#start");
  await waitForRunning(page, 120_000);

  const log = await page.locator("#log").textContent();
  expect(log).toContain("WordPress loaded");
  expect(log).toContain("nginx");
  expect(log).toContain("PHP-FPM");
  await assertNoError(page);
});

// ─── LAMP ───────────────────────────────────────────────────────────

test("@slow lamp: full stack starts", async ({ page }) => {
  test.setTimeout(360_000);
  await gotoOrSkip(page, "/pages/lamp/");

  await page.click("#start");
  await waitForRunning(page, 300_000);

  const log = await page.locator("#log").textContent();
  expect(log).toContain("LAMP stack running");
  expect(log).toContain("MariaDB");
  expect(log).toContain("PHP-FPM");
  expect(log).toContain("nginx");
  await assertNoError(page);
});
