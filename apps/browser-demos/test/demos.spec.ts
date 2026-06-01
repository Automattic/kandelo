/**
 * E2E browser demo tests — exercises each demo through its intended use case.
 *
 * Run all:       cd apps/browser-demos && npx playwright test
 * Fast only:     cd apps/browser-demos && npx playwright test --grep-invert @slow
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

test("simple: spawn-smoke uses non-forking SYS_SPAWN on browser host", async ({
  page,
}) => {
  // End-to-end exercise of the non-forking posix_spawn path on the
  // browser host. Mirrors host/test/centralized-spawn.test.ts on the
  // Node side. The simple page pre-stages /usr/bin/hello as a lazy file
  // pointing at hello.wasm, then spawns spawn-smoke with that path as
  // argv[1]. spawn-smoke calls posix_spawn → SYS_SPAWN, the spawned
  // child runs hello, the parent waits, prints "OK".
  //
  // Asserts:
  //   * stdout contains "OK"           — spawn-smoke's success line
  //   * stdout contains "Hello from"   — the spawned child actually ran
  //   * exit code 0
  //   * fork-count == 0                — the load-bearing claim of this
  //     work: SYS_SPAWN MUST NOT bump kernel_get_fork_count. A non-zero
  //     value would mean the path silently fell back to fork.
  await page.goto("/");
  await page.selectOption("#program", "spawn-smoke");
  await page.click("#run");
  await waitForText(page, "#output", "Exited with code 0", 30_000);

  const output = await page.locator("#output").textContent();
  expect(output, `output=${output}`).toContain("OK");
  expect(output, `output=${output}`).toContain("Hello from");

  // GUARDRAIL: fork-count published via data-fork-count after kernel.spawn
  // resolves. main.ts reads kernel.getForkCount(pid) for the parent pid
  // captured via onStarted. Any non-zero value here means SYS_SPAWN
  // silently fell back to kernel_fork_process.
  const forkCount = await page
    .locator("#fork-count-debug")
    .getAttribute("data-fork-count");
  expect(forkCount, `forkCount=${forkCount}`).toBe("0");
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

// Python demo temporarily disabled (build is slow; pages/python/ and
// the vite.config.ts entry were removed). Re-enable once the builds
// move to a separate prebuilt-package repo.
test.skip("@slow python: runs script with stdlib", async ({ page }) => {
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
  // The demo page log shows dinit's `[OK] nginx` / `[OK] php-fpm` lines
  // (lowercase service names) rather than uppercase product names.
  expect(log).toContain("nginx");
  expect(log).toContain("php-fpm");
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

// Redis demo temporarily disabled (build is slow; pages/redis/ and
// the vite.config.ts entry were removed). Re-enable once the builds
// move to a separate prebuilt-package repo.
test.skip("@slow redis: starts and accepts commands", async ({ page }) => {
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

test("@slow wordpress: captures wp_mail through local SMTP sink", async ({
  page,
}) => {
  test.setTimeout(420_000);

  const consoleMessages: string[] = [];
  page.on("console", (msg) => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    consoleMessages.push(`[pageerror] ${err.message}`);
  });

  await gotoOrSkip(page, "/pages/wordpress/?no-autoload=1");
  await page.click("#start");
  await waitForRunning(page, 180_000);
  await page.waitForFunction(() => (window as any).__wordpressDemoReady === true, {
    timeout: 30_000,
  });

  const clearResult = await page.evaluate(async () => {
    return (window as any).__wordpressDemoRunCommand(
      "rm -f /var/mail/smtp-capture/new/*.eml /var/mail/smtp-capture/tmp/*.eml",
      undefined,
      30_000,
    );
  });
  expect(clearResult.exitCode, clearResult.stdout + clearResult.stderr).toBe(0);

  const smtpTriggerPhp = `<?php
define('WP_USE_THEMES', false);
define('WP_INSTALLING', true);
require __DIR__ . '/wp-load.php';

$ok = wp_mail('playwright@example.test', 'SMTP capture Playwright', "SMTP_CAPTURE_PLAYWRIGHT\\n");
header('Content-Type: text/plain');
if (!$ok) {
    http_response_code(500);
    echo "failed\\n";
    exit;
}
echo "sent\\n";
`;

  const writeResult = await page.evaluate(async (contents) => {
    return (window as any).__wordpressDemoRunCommand(
      "cat > /var/www/html/smtp-capture-playwright.php",
      contents,
      60_000,
    );
  }, smtpTriggerPhp);
  expect(writeResult.exitCode, writeResult.stdout + writeResult.stderr).toBe(0);

  const pingResult = await page.evaluate(async () => {
    await (window as any).__wordpressDemoRunCommand(
      "cat > /var/www/html/smtp-capture-ping.php",
      `<?php
header('Content-Type: text/plain');
echo "pong\\n";
`,
      30_000,
    );
    const response = await fetch(`/app/smtp-capture-ping.php?ts=${Date.now()}`);
    return { status: response.status, text: await response.text() };
  });
  expect(pingResult.status, pingResult.text).toBe(200);
  expect(pingResult.text).toContain("pong");

  const triggerResult = await page.evaluate(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);
    try {
      const response = await fetch(`/app/smtp-capture-playwright.php?ts=${Date.now()}`, {
        signal: controller.signal,
      });
      return { status: response.status, text: await response.text(), error: "" };
    } catch (err: any) {
      return { status: 0, text: "", error: err?.message || String(err) };
    } finally {
      clearTimeout(timeout);
    }
  });
  if (triggerResult.status !== 200) {
    const logs = await page.evaluate(async () => {
      return (window as any).__wordpressDemoRunCommand(
        "cat /var/log/php-fpm.log /var/log/nginx/error.log /var/log/msmtpd.log /var/log/smtp-capture.log 2>&1 || true",
        undefined,
        30_000,
      );
    });
    console.log("=== WORDPRESS SMTP CONSOLE (last 50) ===");
    for (const msg of consoleMessages.slice(-50)) console.log(msg);
    console.log("=== WORDPRESS SMTP LOG ===");
    console.log(await page.locator("#log").textContent());
    console.log("=== WORDPRESS SERVICE LOGS ===");
    console.log(logs.stdout + logs.stderr);
  }
  expect(triggerResult.status, triggerResult.text + triggerResult.error).toBe(200);
  expect(triggerResult.text).toContain("sent");

  const waitForMailScript = `
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60; do
  for f in /var/mail/smtp-capture/new/*.eml; do
    if [ -f "$f" ]; then
      echo "captured:$f"
      cat "$f"
      grep -q 'SMTP_CAPTURE_PLAYWRIGHT' "$f" && grep -q 'playwright@example.test' "$f" && exit 0
    fi
  done
  sleep 1
done
echo 'no captured SMTP message'
echo 'new dir:'
ls -la /var/mail/smtp-capture/new 2>&1 || true
echo 'msmtpd log:'
cat /var/log/msmtpd.log 2>&1 || true
echo 'capture log:'
cat /var/log/smtp-capture.log 2>&1 || true
exit 1
`;
  const mailResult = await page.evaluate(async (script) => {
    return (window as any).__wordpressDemoRunCommand(script, undefined, 90_000);
  }, waitForMailScript);

  expect(mailResult.exitCode, mailResult.stdout + mailResult.stderr).toBe(0);
  expect(mailResult.stdout).toContain("SMTP_CAPTURE_PLAYWRIGHT");
  expect(mailResult.stdout).toContain("playwright@example.test");
  await assertNoError(page);
});

test("@slow wordpress: install, login, and load site editor from menu", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1800, height: 1100 });

  // Capture browser console for debugging
  const consoleMessages: string[] = [];
  page.on("console", (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    consoleMessages.push(text);
  });
  page.on("pageerror", (err) => {
    consoleMessages.push(`[pageerror] ${err.message}`);
  });
  let sawSiteEditorAppRedirect = false;
  page.on("response", (response) => {
    try {
      const responseUrl = new URL(response.url());
      const location = response.headers()["location"];
      if (
        response.status() === 307 &&
        responseUrl.pathname.includes("/wp-admin/site-editor.php") &&
        !responseUrl.pathname.includes("/app/") &&
        location &&
        new URL(location, response.url()).pathname.includes(
          "/app/wp-admin/site-editor.php",
        )
      ) {
        sawSiteEditorAppRedirect = true;
      }
    } catch {
      // Ignore malformed debug URLs/headers.
    }
  });

  await gotoOrSkip(page, "/pages/wordpress/");

  await page.click("#start");
  await waitForRunning(page, 180_000);

  const logText = await page.locator("#log").textContent();
  // dinit logs `[OK] <service>` lines (lowercase service names) when each
  // declared service comes up — verify the stack we expect is present.
  expect(logText).toContain("nginx");
  expect(logText).toContain("php-fpm");
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
    await passField.fill("Testpass123!Testpass123!");
  }
  const pass2Field = frame.locator("#pass2");
  if ((await pass2Field.count()) > 0 && await pass2Field.isVisible()) {
    await pass2Field.fill("Testpass123!Testpass123!");
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
  await frame.locator("#user_pass").fill("Testpass123!Testpass123!");
  await frame.locator("#wp-submit").click();

  // Wait for login to process, then navigate to the dashboard explicitly.
  // WordPress login redirects sometimes produce URLs without the /app/ prefix.
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const f = document.getElementById("frame") as HTMLIFrameElement;
    f.src = "/app/wp-admin/";
  });

  // Wait for the dashboard to load. The viewport is widened above so the
  // WordPress admin menu renders in its normal desktop layout.
  await expect(
    frame.locator("#wpadminbar, .wrap h1").first(),
  ).toBeVisible({ timeout: 120_000 });
  await expect(
    frame.locator("#adminmenu").first(),
  ).toBeAttached({ timeout: 30_000 });

  // --- Navigate to the Site Editor through the wp-admin menu ---
  const siteEditorLink = frame
    .locator("#adminmenu a[href*='site-editor.php']")
    .first();
  await expect(siteEditorLink).toBeAttached({ timeout: 60_000 });
  const appearanceMenu = frame.locator("#menu-appearance > a").first();
  if ((await appearanceMenu.count()) > 0) {
    await appearanceMenu.hover();
  }
  await siteEditorLink.click({ timeout: 60_000 });

  await page.waitForFunction(
    () => {
      const f = document.getElementById("frame") as HTMLIFrameElement | null;
      return f?.contentWindow?.location.pathname.includes("/wp-admin/site-editor.php");
    },
    { timeout: 60_000 },
  );
  expect(sawSiteEditorAppRedirect).toBe(true);
  await expect(frame.locator("body")).not.toContainText("Simple Programs");

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
  // dinit logs `[OK] <service>` lines (lowercase service names) — verify
  // every layer of the stack reported ready.
  expect(log).toContain("nginx");
  expect(log).toContain("php-fpm");
  expect(log).toContain("mariadb");
  await assertNoError(page);

  // Verify WordPress install page actually loads in the iframe
  const frame = page.frameLocator("#frame");
  await expect(
    frame.locator("form#setup, form#language-chooser, .wp-core-ui").first(),
  ).toBeVisible({ timeout: 120_000 });
});

// ─── Git HTTP Clone ──────────────────────────────────────────────────

const repoRoot = join(__dirname, "../../..");
const hasGitWasm = existsSync(join(repoRoot, "packages/registry/git/bin/git.wasm"));
const hasGitRemoteHttpWasm = existsSync(join(repoRoot, "packages/registry/git/bin/git-remote-http.wasm"));

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
    execSync(`echo "hello from kandelo" > "${workDir}/test.txt"`, gitOpts);
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
