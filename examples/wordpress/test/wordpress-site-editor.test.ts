/**
 * WordPress site editor E2E test — verifies that the site editor loads
 * and renders blocks through the full stack (kernel → PHP → TCP bridge → browser).
 *
 * This is a heavier test than wordpress-server.test.ts: it launches a real
 * browser via Playwright, installs WordPress, logs in, and navigates to
 * the site editor. It ensures the Gutenberg editor iframe renders blocks.
 *
 * Requires:
 *   1. PHP binary: examples/libs/php/php-src/sapi/cli/php
 *   2. WordPress files: examples/wordpress/wordpress/
 *   3. Kernel wasm: host/wasm/wasm_posix_kernel.wasm
 *   4. Playwright browsers: npx playwright install chromium
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page, type Frame } from "@playwright/test";

import { tryResolveBinary } from "../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");
const phpBinaryPath = tryResolveBinary("programs/php/php.wasm");
const kernelWasmPath = tryResolveBinary("kernel.wasm");
const wpDir = join(dirname(__dirname), "wordpress");
const dbPath = join(wpDir, "wp-content/database/wordpress.db");

const PHP_AVAILABLE = !!phpBinaryPath;
const WP_AVAILABLE = existsSync(join(wpDir, "wp-settings.php"));
const KERNEL_AVAILABLE = !!kernelWasmPath;

const SKIP_REASON = !PHP_AVAILABLE
  ? "PHP binary not built"
  : !WP_AVAILABLE
    ? "WordPress not downloaded (run examples/wordpress/setup.sh)"
    : !KERNEL_AVAILABLE
      ? "Kernel wasm not built (run bash build.sh)"
      : "";

const ADMIN_USER = "admin";
const ADMIN_PASS = "X9#kQ2!vLm@pR7$w";
const ADMIN_EMAIL = "admin@example.com";

/** Find an available port. */
async function getRandomPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Start the WordPress server subprocess and wait for it to be ready. */
async function startServer(port: number): Promise<ChildProcess> {
  const proc = spawn(
    "npx",
    ["tsx", "examples/wordpress/serve.ts", String(port)],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
      detached: process.platform !== "win32",
    },
  );

  let output = "";
  proc.stderr?.on("data", (d) => { output += d.toString(); });
  proc.stdout?.on("data", (d) => { output += d.toString(); });

  // Wait for PHP's built-in server startup message
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(
        `Server did not start within 120s.\nOutput: ${output.slice(0, 2000)}`,
      ));
    }, 120_000);

    const check = (data: Buffer) => {
      if (/Development Server.*started/i.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    };
    proc.stderr?.on("data", check);
    proc.stdout?.on("data", check);
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with code ${code}.\nOutput: ${output.slice(0, 2000)}`));
    });
  });

  // Wait for HTTP readiness
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(5000),
      });
      await resp.body?.cancel();
      return proc;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Server did not respond to HTTP within 30s");
}

function killServer(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Install WordPress by sending a POST and monitoring the database file.
 *
 * PHP's built-in server is single-threaded. The install POST blocks the
 * server while creating database tables. We can't wait for the response
 * to complete (PHP hangs after wp_install), so we monitor the DB file
 * directly and abort once install is confirmed.
 */
async function installWordPress(baseUrl: string): Promise<void> {
  const body = new URLSearchParams({
    weblog_title: "E2E Test",
    user_name: ADMIN_USER,
    admin_password: ADMIN_PASS,
    admin_password2: ADMIN_PASS,
    admin_email: ADMIN_EMAIL,
    blog_public: "1",
    Submit: "Install WordPress",
  });

  // Fire the install POST (don't wait for response — it hangs)
  const controller = new AbortController();
  fetch(`${baseUrl}/wp-admin/install.php?step=2`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: controller.signal,
  }).catch(() => {});

  // Monitor the database file until WordPress tables + admin user exist
  const requiredTables = [
    "wp_options", "wp_users", "wp_posts", "wp_comments",
    "wp_terms", "wp_term_taxonomy", "wp_term_relationships",
  ];

  const deadline = Date.now() + 600_000; // 10 minutes
  while (Date.now() < deadline) {
    if (existsSync(dbPath)) {
      try {
        const tables = execSync(
          `sqlite3 "${dbPath}" ".tables"`,
          { encoding: "utf-8", timeout: 5000 },
        );
        const hasAll = requiredTables.every((t) => tables.includes(t));
        if (hasAll) {
          const users = execSync(
            `sqlite3 "${dbPath}" "SELECT user_login FROM wp_users LIMIT 1;"`,
            { encoding: "utf-8", timeout: 5000 },
          );
          if (users.includes(ADMIN_USER)) {
            // Update siteurl/home to match current server URL
            execSync(
              `sqlite3 "${dbPath}" "UPDATE wp_options SET option_value='${baseUrl}' WHERE option_name IN ('siteurl','home');"`,
              { timeout: 5000 },
            );
            controller.abort();
            return;
          }
        }
      } catch { /* DB might be locked */ }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  controller.abort();
  throw new Error("WordPress install did not complete within 10 minutes");
}

/** Dismiss the WP 6.7+ welcome guide modal if it appears. */
async function dismissWelcomeModal(page: Page): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const dismissed = await page.evaluate(() => {
      const overlay = document.querySelector(".components-modal__screen-overlay");
      if (!overlay) return false;
      const buttons = overlay.querySelectorAll("button");
      for (const btn of buttons) {
        if (/get started/i.test(btn.textContent || "")) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (dismissed) {
      await page.waitForTimeout(500);
      return;
    }
    await page.waitForTimeout(500);
  }
}

/** Wait for the editor canvas iframe to appear and return the Frame. */
async function findEditorCanvasFrame(page: Page, timeoutMs = 120_000): Promise<Frame> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frame({ name: "editor-canvas" });
    if (frame) return frame;
    await page.waitForTimeout(200);
  }
  throw new Error("editor-canvas iframe not found");
}

describe.skipIf(!!SKIP_REASON)("WordPress Site Editor E2E", () => {
  let serverProc: ChildProcess | undefined;
  let browser: Browser | undefined;

  afterAll(async () => {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (serverProc) {
      killServer(serverProc);
    }
  });

  it("site editor loads and renders blocks", async () => {
    const port = await getRandomPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Fresh database
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }

    // Create mu-plugin to disable operations that hang in Wasm
    const muPluginsDir = join(wpDir, "wp-content/mu-plugins");
    mkdirSync(muPluginsDir, { recursive: true });
    writeFileSync(
      join(muPluginsDir, "wasm-optimizations.php"),
      "<?php\n" +
      "add_filter('pre_wp_mail', '__return_false');\n" +
      "add_filter('pre_http_request', function($pre, $args, $url) {\n" +
      "    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');\n" +
      "}, 10, 3);\n" +
      "if (!defined('DISABLE_WP_CRON')) define('DISABLE_WP_CRON', true);\n" +
      "if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);\n",
    );

    // Start server
    serverProc = await startServer(port);

    // Install WordPress (monitors DB file, then aborts the hanging POST)
    await installWordPress(baseUrl);

    // The server is still blocked on the install POST. Restart it.
    killServer(serverProc);
    await new Promise((r) => setTimeout(r, 2000));
    serverProc = await startServer(port);

    // Login via fetch to get auth cookies. We avoid using Playwright for
    // login because the browser's dashboard subrequests (CSS, JS, AJAX)
    // would block PHP's single-threaded built-in server, preventing
    // subsequent page loads until all subrequests complete.
    const loginResp = await fetch(`${baseUrl}/wp-login.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `log=${ADMIN_USER}&pwd=${encodeURIComponent(ADMIN_PASS)}&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F`,
      redirect: "manual",
    });
    const setCookies = loginResp.headers.getSetCookie?.() || [];
    expect(setCookies.length).toBeGreaterThan(0);
    await loginResp.body?.cancel();

    // Inject cookies into browser context
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    for (const sc of setCookies) {
      const [nameVal] = sc.split(";");
      const [name, ...rest] = nameVal!.split("=");
      await context.addCookies([{
        name: name!,
        value: rest.join("="),
        domain: "127.0.0.1",
        path: "/",
      }]);
    }
    const page = await context.newPage();

    // Navigate directly to template in edit mode (skip the site editor
    // hub to avoid an extra navigation step)
    const t1 = Date.now();
    await page.goto(
      `${baseUrl}/wp-admin/site-editor.php?postType=wp_template&postId=twentytwentyfive//index&canvas=edit`,
      { waitUntil: "domcontentloaded", timeout: 300_000 },
    );
    console.log(`[E2E] Template edit page loaded in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

    await dismissWelcomeModal(page);

    // Wait for the editor canvas iframe
    const t2 = Date.now();
    await page.locator('iframe[name="editor-canvas"]').waitFor({
      state: "visible",
      timeout: 300_000,
    });
    console.log(`[E2E] Editor canvas visible in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

    const frame = await findEditorCanvasFrame(page, 120_000);

    // Verify blocks are rendered inside the editor
    await frame.waitForLoadState("domcontentloaded");
    await frame.waitForSelector("[data-block]", { timeout: 120_000 });

    const blockCount = await frame.evaluate(() => {
      const blocks = document.querySelectorAll("[data-block]");
      return Array.from(blocks).filter((b) => b.clientHeight > 0).length;
    });
    console.log(`[E2E] ${blockCount} blocks rendered`);

    expect(blockCount).toBeGreaterThan(0);
  }, 900_000); // 15 minute timeout for the full E2E flow
});
