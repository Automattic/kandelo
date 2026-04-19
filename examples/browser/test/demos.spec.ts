/**
 * E2E browser demo tests — exercises each demo through its intended use case.
 *
 * Run all:       cd examples/browser && npx playwright test
 * Fast only:     cd examples/browser && npx playwright test --grep-invert @slow
 *
 * Tests that require binaries not yet built (nginx, dash, php, mariadb) will
 * skip automatically when Vite shows an import error overlay.
 */

import { test, expect, type Page } from "@playwright/test";
import { join, dirname } from "node:path";
import { existsSync, rmSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

test("shell: pipes between coreutils", async ({ page }) => {
  await gotoOrSkip(page, "/pages/shell/");

  await page.click("#mode-batch");
  await page.fill(
    "#code",
    'echo "hello world" | wc -c\nprintf "beta\\nalpha\\n" | sort\necho foo | cat\n',
  );
  await page.click("#run");

  // Wait for the last command's output ("foo" from echo foo | cat)
  await waitForText(page, "#batch-output", "foo", 30_000);
  const output = await page.locator("#batch-output").textContent();
  // wc -c counts 12 bytes ("hello world\n")
  expect(output).toContain("12");
  // sort should produce alpha before beta
  expect(output).toContain("alpha");
  expect(output).toContain("beta");
  // cat should pass through
  expect(output).toContain("foo");
  await assertNoError(page);
});

test("shell: file I/O and command substitution", async ({ page }) => {
  await gotoOrSkip(page, "/pages/shell/");

  await page.click("#mode-batch");
  await page.fill(
    "#code",
    [
      'echo "first line" > /tmp/test.txt',
      'echo "second line" >> /tmp/test.txt',
      "cat /tmp/test.txt",
      "wc -l < /tmp/test.txt",
      'result=$(cat /tmp/test.txt | wc -l)',
      'echo "lines: $result"',
    ].join("\n") + "\n",
  );
  await page.click("#run");

  await waitForText(page, "#batch-output", "lines: 2", 30_000);
  const output = await page.locator("#batch-output").textContent();
  expect(output).toContain("first line");
  expect(output).toContain("second line");
  await assertNoError(page);
});

// ─── nginx ──────────────────────────────────────────────────────────

test("nginx: starts and serves page", async ({ page }) => {
  await gotoOrSkip(page, "/pages/nginx/");
  await page.click("#start");
  await waitForRunning(page, 60_000);

  // Verify nginx actually serves the page in the iframe
  const frame = page.frameLocator("#frame");
  await expect(frame.locator("body")).toContainText("Hello from nginx on WebAssembly", {
    timeout: 30_000,
  });

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

// ─── Python ────────────────────────────────────────────────────────

test("@slow python: runs script with stdlib", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoOrSkip(page, "/pages/python/");

  await page.click("#mode-batch");
  await page.fill(
    "#code",
    [
      "import sys",
      "import json",
      "import math",
      'print(f"Python {sys.version_info.major}.{sys.version_info.minor}")',
      'print(f"pi = {math.pi:.4f}")',
      "data = json.dumps({'key': 'value', 'nums': [1, 2, 3]})",
      "parsed = json.loads(data)",
      'print(f"json roundtrip: {parsed[\'key\']}, len={len(parsed[\'nums\'])})")',
      "print([x**2 for x in range(5)])",
    ].join("\n") + "\n",
  );
  await page.click("#run");

  await waitForText(page, "#batch-output", "Python 3.", 90_000);
  const output = await page.locator("#batch-output").textContent();
  expect(output).toContain("pi = 3.141");
  expect(output).toContain("json roundtrip: value, len=3");
  expect(output).toContain("[0, 1, 4, 9, 16]");
  await assertNoError(page);
});

// ─── nginx + PHP-FPM ────────────────────────────────────────────────

test("@slow nginx-php: starts and serves PHP page", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoOrSkip(page, "/pages/nginx-php/");

  await page.click("#start");
  await waitForRunning(page, 90_000);

  // Verify the iframe loads PHP content via nginx + PHP-FPM
  const frame = page.frameLocator("#frame");
  await expect(frame.locator("body")).toContainText("PHP-FPM on WebAssembly", {
    timeout: 60_000,
  });

  const log = await page.locator("#log").textContent();
  expect(log).toContain("nginx");
  expect(log).toContain("PHP-FPM");
  await assertNoError(page);
});

// ─── MariaDB ────────────────────────────────────────────────────────

test("@slow mariadb: bootstraps and accepts queries", async ({ page }) => {
  test.setTimeout(300_000);

  // Capture console for diagnostics on failure
  const consoleMessages: string[] = [];
  page.on("console", (msg) => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    consoleMessages.push(`[pageerror] ${err.message}`);
  });

  await gotoOrSkip(page, "/pages/mariadb/");

  await page.click("#start");

  // Wait for MariaDB to be ready (execute button enabled)
  try {
    await page.waitForFunction(
      () => {
        const btn = document.getElementById("execute") as HTMLButtonElement;
        return btn && !btn.disabled;
      },
      { timeout: 240_000 },
    );
  } catch (e) {
    const errors = consoleMessages.filter(m => m.includes("error") || m.includes("Error") || m.includes("timeout") || m.includes("EAGAIN"));
    console.log("=== MARIADB CONSOLE ERRORS ===");
    for (const msg of errors.slice(-30)) console.log(msg);
    console.log("=== ALL CONSOLE (last 20) ===");
    for (const msg of consoleMessages.slice(-20)) console.log(msg);
    throw e;
  }

  // VERSION query auto-runs on startup
  const result = await page.locator("#result").textContent();
  expect(result).toContain("MariaDB");
  await assertNoError(page);

  // --- CRUD verification ---
  // CREATE TABLE
  await page.selectOption("#examples", "create");
  await page.click("#execute");
  await waitForText(page, "#log", "Query OK", 30_000);

  // INSERT
  await page.selectOption("#examples", "insert");
  await page.click("#execute");
  await page.waitForTimeout(5000); // allow insert to complete

  // SELECT
  await page.selectOption("#examples", "select");
  await page.click("#execute");
  await waitForText(page, "#result", "Alice", 30_000);
  const selectResult = await page.locator("#result").textContent();
  expect(selectResult).toContain("Bob");
  expect(selectResult).toContain("Charlie");
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

test("@slow wordpress: install, login, and load dashboard", async ({
  page,
}) => {
  test.setTimeout(600_000);

  // Capture browser console for debugging
  const consoleMessages: string[] = [];
  page.on("console", (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    consoleMessages.push(text);
  });
  page.on("pageerror", (err) => {
    consoleMessages.push(`[pageerror] ${err.message}`);
  });

  await gotoOrSkip(page, "/pages/wordpress/");

  await page.click("#start");
  await waitForRunning(page, 180_000);

  const logText = await page.locator("#log").textContent();
  expect(logText).toContain("WordPress loaded");
  expect(logText).toContain("nginx");
  expect(logText).toContain("PHP-FPM");
  await assertNoError(page);

  // The iframe navigates to /app/ which WordPress redirects to the install page.
  const frame = page.frameLocator("#frame");

  try {
    await expect(
      frame.locator("form#setup, form#language-chooser, .wp-core-ui").first(),
    ).toBeVisible({ timeout: 120_000 });
  } catch (e) {
    // Dump console messages on failure
    const errors = consoleMessages.filter(m => m.includes("error") || m.includes("Error") || m.includes("Maximum") || m.includes("stack") || m.includes("crash") || m.includes("502") || m.includes("fork"));
    console.log("=== BROWSER CONSOLE ERRORS ===");
    for (const msg of errors.slice(-50)) console.log(msg);
    console.log("=== ALL CONSOLE (last 30) ===");
    for (const msg of consoleMessages.slice(-30)) console.log(msg);
    throw e;
  }

  // If we land on the language chooser, skip past it
  if ((await frame.locator("form#language-chooser").count()) > 0) {
    await frame.locator("form#language-chooser [type='submit']").click();
    await expect(frame.locator("form#setup")).toBeVisible({ timeout: 60_000 });
  }

  // --- Fill in the WordPress install form ---
  await frame.locator("#weblog_title").fill("E2E Test");
  await frame.locator("#user_login").fill("admin");

  // Fill both #pass1 and #pass2 — the latter is a no-JS fallback field
  // (class="hide-if-js") that's visible when jQuery fails to load in Wasm.
  const passField = frame.locator("#pass1");
  if ((await passField.count()) > 0) {
    await passField.fill("testpass123");
  }
  const pass2Field = frame.locator("#pass2");
  if ((await pass2Field.count()) > 0) {
    await pass2Field.fill("testpass123");
  }
  // Check the "Confirm use of weak password" checkbox if visible.
  // WordPress JS may hide this element, so use a short timeout.
  const weakPw = frame.locator("#pw_weak, .pw-weak input[type='checkbox']");
  if ((await weakPw.count()) > 0) {
    try {
      await weakPw.check({ timeout: 5000 });
    } catch {
      // Checkbox hidden by WordPress JS — not needed
    }
  }

  await frame.locator("#admin_email").fill("admin@example.com");

  // Submit the install form
  await frame.locator("#submit, [name='Submit']").click();

  // Wait for install success page
  await expect(
    frame.locator(".step, .install-success, h1").filter({ hasText: /success|installed|log in/i }).first(),
  ).toBeVisible({ timeout: 300_000 });

  // --- Click "Log In" to go to the login page ---
  const loginLink = frame.locator("a").filter({ hasText: /log in/i });
  if ((await loginLink.count()) > 0) {
    await loginLink.click();
  } else {
    await page.evaluate(() => {
      const f = document.getElementById("frame") as HTMLIFrameElement;
      f.src = "/app/wp-login.php";
    });
  }

  // Wait for the login form
  await expect(frame.locator("#loginform, form[name='loginform']").first()).toBeVisible({
    timeout: 60_000,
  });

  // --- Fill in login credentials ---
  await frame.locator("#user_login").fill("admin");
  await frame.locator("#user_pass").fill("testpass123");
  await frame.locator("#wp-submit").click();

  // Wait for login to process, then navigate to the dashboard explicitly.
  // WordPress login redirects sometimes produce URLs without the /app/ prefix.
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const f = document.getElementById("frame") as HTMLIFrameElement;
    f.src = "/app/wp-admin/";
  });

  // Wait for the dashboard to load. The admin menu is hidden by responsive
  // CSS (iframe is ~450px wide, WordPress hides menu at <960px), so check
  // for DOM presence rather than visibility.
  await expect(
    frame.locator("#wpadminbar, .wrap h1").first(),
  ).toBeVisible({ timeout: 120_000 });
  await expect(
    frame.locator("#adminmenu").first(),
  ).toBeAttached({ timeout: 30_000 });

  // --- Navigate to the Site Editor ---
  await page.evaluate(() => {
    const f = document.getElementById("frame") as HTMLIFrameElement;
    f.src = "/app/wp-admin/site-editor.php";
  });

  // The site editor loads the Gutenberg block editor via heavy JS bundles.
  // Wait for the editor interface to appear — the .edit-site class on the
  // body or the editor iframe/canvas indicates it loaded.
  await expect(
    frame.locator(".edit-site, .edit-site-layout, #site-editor, .interface-interface-skeleton").first(),
  ).toBeAttached({ timeout: 300_000 });
});

// ─── LAMP ───────────────────────────────────────────────────────────

test("@slow lamp: full stack serves WordPress", async ({ page }) => {
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

  // Verify WordPress install page actually loads in the iframe
  const frame = page.frameLocator("#frame");
  await expect(
    frame.locator("form#setup, form#language-chooser, .wp-core-ui").first(),
  ).toBeVisible({ timeout: 120_000 });
});

// ─── Git HTTP Clone ──────────────────────────────────────────────────

const repoRoot = join(__dirname, "../../..");
const hasGitWasm = existsSync(join(repoRoot, "examples/libs/git/bin/git.wasm"));
const hasGitRemoteHttpWasm = existsSync(join(repoRoot, "examples/libs/git/bin/git-remote-http.wasm"));

test.describe("Git HTTP clone (browser)", () => {
  test.skip(!hasGitWasm || !hasGitRemoteHttpWasm, "Git wasm binaries not built");

  let httpServer: Server;
  let httpPort: number;
  let tmpBase: string;

  test.beforeAll(async () => {
    tmpBase = `/tmp/git-browser-http-test-${Date.now()}`;
    const workDir = `${tmpBase}/work`;
    const bareRepoDir = `${tmpBase}/repo.git`;

    const gitOpts = {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_COMMITTER_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    };

    execSync(`git init "${workDir}"`, gitOpts);
    execSync(`echo "hello from wasm-posix-kernel" > "${workDir}/test.txt"`, gitOpts);
    execSync(`git -C "${workDir}" add test.txt`, gitOpts);
    execSync(`git -C "${workDir}" commit -m "initial commit"`, gitOpts);
    execSync(`git clone --bare "${workDir}" "${bareRepoDir}"`, gitOpts);
    execSync(`git -C "${bareRepoDir}" repack -ad`, gitOpts);
    execSync(`git -C "${bareRepoDir}" update-server-info`, gitOpts);

    // Serve the bare repo as static files (dumb HTTP protocol).
    // CORS + CORP headers are required because the browser runs with
    // Cross-Origin-Embedder-Policy: require-corp, which blocks cross-origin
    // fetches unless the server opts in.
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    };

    httpServer = createServer((req, res) => {
      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        });
        res.end();
        return;
      }

      const urlPath = (req.url || "/").split("?")[0];
      const filePath = join(bareRepoDir, urlPath);
      try {
        if (!existsSync(filePath)) {
          res.writeHead(404, corsHeaders);
          res.end("Not found\n");
          return;
        }
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          res.writeHead(404, corsHeaders);
          res.end("Not found\n");
          return;
        }
        const data = readFileSync(filePath);
        res.writeHead(200, corsHeaders);
        res.end(data);
      } catch {
        res.writeHead(404, corsHeaders);
        res.end("Not found\n");
      }
    });

    await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
    httpPort = (httpServer.address() as any).port;

    // Verify the bare repo was set up correctly
    const infoRefsPath = join(bareRepoDir, "info/refs");
    if (!existsSync(infoRefsPath)) {
      throw new Error(`info/refs not found at ${infoRefsPath}`);
    }
  });

  test.afterAll(() => {
    httpServer?.close();
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("@slow clones a repository via HTTP (dumb protocol)", async ({ page }) => {
    test.setTimeout(180_000);

    await gotoOrSkip(page, "/pages/git-test/");

    // Wait for git binaries to load
    await page.waitForFunction(() => (window as any).__gitTestReady === true, {
      timeout: 60_000,
    });

    // Run git clone via the wasm kernel
    const result = await page.evaluate(async (url: string) => {
      return (window as any).__runGitClone(url);
    }, `http://localhost:${httpPort}/`);

    if (result.exitCode !== 0) {
      console.log("Git clone stderr:", result.stderr);
    }

    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Cloning into");
  });
});
