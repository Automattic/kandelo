/**
 * WordPress site editor E2E test — verifies that the site editor loads
 * and renders blocks through the full stack (kernel → PHP → TCP bridge → browser).
 *
 * This is a heavier test than wordpress-server.test.ts: it launches a real
 * browser via Playwright, installs WordPress, logs in, and navigates to
 * the site editor. It ensures the Gutenberg editor iframe renders blocks.
 *
 * Requires:
 *   0. KANDELO_WORDPRESS_SITE_EDITOR_E2E=1
 *   1. WordPress service VFS image: programs/wordpress.vfs.zst
 *   2. Kernel wasm: host/wasm/kandelo-kernel.wasm
 *   3. Playwright browsers: npx playwright install chromium
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page, type Frame } from "@playwright/test";

import { tryResolveBinary } from "../../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../..");
const kernelWasmPath = tryResolveBinary("kernel.wasm");
const wpVfsPath = tryResolveBinary("programs/wordpress.vfs.zst")
  ?? (existsSync(join(repoRoot, "apps/browser-demos/public/wordpress.vfs.zst"))
    ? join(repoRoot, "apps/browser-demos/public/wordpress.vfs.zst")
    : null);

const KERNEL_AVAILABLE = !!kernelWasmPath;
const WP_VFS_AVAILABLE = !!wpVfsPath;
const E2E_ENABLED = process.env.KANDELO_WORDPRESS_SITE_EDITOR_E2E === "1";

const SKIP_REASON = !E2E_ENABLED
  ? "set KANDELO_WORDPRESS_SITE_EDITOR_E2E=1 to run the heavyweight browser E2E"
  : !WP_VFS_AVAILABLE
    ? "WordPress VFS image not built (run ./run.sh build wp-vfs)"
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
    ["tsx", "packages/registry/wordpress/demo/serve.ts", String(port)],
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

  // Wait for the dinit/nginx/PHP-FPM service stack to be ready.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(
        `Server did not start within 120s.\nOutput: ${output.slice(0, 2000)}`,
      ));
    }, 120_000);

    const check = (data: Buffer) => {
      if (/WordPress running behind nginx \+ php-fpm/i.test(data.toString())) {
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
 * Install WordPress by sending the normal install POST. The VFS-backed
 * service demo uses nginx + PHP-FPM workers, so the request can complete
 * normally; no host-side database polling or server restart is needed.
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

  const resp = await fetch(`${baseUrl}/wp-admin/install.php?step=2`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(600_000),
  });
  const text = await resp.text();
  if (resp.status < 200 || resp.status >= 400) {
    throw new Error(`WordPress install failed with HTTP ${resp.status}: ${text.slice(0, 1000)}`);
  }
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

    // Start server
    serverProc = await startServer(port);

    // Install WordPress through the service stack.
    await installWordPress(baseUrl);

    // Login via fetch to get auth cookies. We avoid using Playwright for
    // login so the test can inject cookies and navigate straight to the
    // editor page.
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
