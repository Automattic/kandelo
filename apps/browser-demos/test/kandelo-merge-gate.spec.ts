import { expect, test, type FrameLocator, type Page } from "@playwright/test";

type BrowserDiagnostics = {
  console: string[];
  pageErrors: string[];
  requestFailures: string[];
};

const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();
const MAX_LOG_LINES = 160;

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test.beforeEach(({ page }) => {
  const diagnostics: BrowserDiagnostics = {
    console: [],
    pageErrors: [],
    requestFailures: [],
  };
  diagnosticsByPage.set(page, diagnostics);

  page.on("console", (msg) => {
    diagnostics.console.push(`[${msg.type()}] ${msg.text()}`);
    trimLog(diagnostics.console);
  });
  page.on("pageerror", (err) => {
    diagnostics.pageErrors.push(err.stack || err.message);
    trimLog(diagnostics.pageErrors);
  });
  page.on("requestfailed", (request) => {
    diagnostics.requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "failed"}`);
    trimLog(diagnostics.requestFailures);
  });
});

function trimLog(lines: string[]) {
  if (lines.length > MAX_LOG_LINES) {
    lines.splice(0, lines.length - MAX_LOG_LINES);
  }
}

async function gotoOrSkip(page: Page, path: string) {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }
}

async function waitForReady(page: Page, timeout = 180_000) {
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout })
    .toContain("Ready");
}

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function waitForTerminalContent(
  page: Page,
  expected: string | RegExp,
  timeout = 120_000,
) {
  const assertion = expect.poll(() => terminalText(page), { timeout });
  if (typeof expected === "string") {
    await assertion.toContain(expected);
  } else {
    await assertion.toMatch(expected);
  }
}

async function runTerminalCommand(
  page: Page,
  command: string,
  expected: string | RegExp,
  timeout = 120_000,
) {
  await page.locator(".kshell-host").first().click();
  const terminalInput = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await terminalInput.count()) {
    await terminalInput.focus();
  }
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForTerminalContent(page, expected, timeout);
}

async function openTerminalDrawer(page: Page) {
  const terminalDrawer = page.locator(".kmachine-drawer-toggle").filter({ hasText: "Terminal" });
  await terminalDrawer.click();
  await expect(page.locator(".kshell-host").first()).toBeVisible({ timeout: 120_000 });
}

function webFrame(page: Page, title: string): FrameLocator {
  return page.frameLocator(`iframe[title="${title}"]`);
}

async function attachKandeloDiagnostics(page: Page, label: string) {
  const info = test.info();
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const diagnostics = diagnosticsByPage.get(page);

  await attachText(
    `${safeLabel}-browser-events.txt`,
    [
      "Console",
      ...(diagnostics?.console.length ? diagnostics.console : ["<none>"]),
      "",
      "Page errors",
      ...(diagnostics?.pageErrors.length ? diagnostics.pageErrors : ["<none>"]),
      "",
      "Request failures",
      ...(diagnostics?.requestFailures.length ? diagnostics.requestFailures : ["<none>"]),
    ].join("\n"),
  );

  const snapshot = await page.evaluate(() => {
    const text = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: document.body.innerText,
      machineCurrent: text(document.querySelector(".kmachine-current")),
      surfaceButtons: Array.from(document.querySelectorAll(".kmachine-switch-btn")).map((button) => ({
        text: text(button),
        disabled: (button as HTMLButtonElement).disabled,
        ariaCurrent: button.getAttribute("aria-current"),
      })),
      drawers: Array.from(document.querySelectorAll(".kmachine-drawer-toggle")).map((button) => ({
        text: text(button),
        expanded: button.getAttribute("aria-expanded"),
      })),
      webPreviewMessages: Array.from(document.querySelectorAll(".kpane-body")).map(text)
        .filter((value) => /waiting|starting|ready|error|bridge|service|http/i.test(value)),
      iframes: Array.from(document.querySelectorAll("iframe")).map((iframe) => {
        const rect = iframe.getBoundingClientRect();
        return {
          title: iframe.title,
          src: iframe.src,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0,
        };
      }),
      syslog: Array.from(document.querySelectorAll(".ksys-line"))
        .slice(-120)
        .map((line) => line.textContent ?? ""),
    };
  }).catch((err) => ({
    error: err instanceof Error ? err.stack || err.message : String(err),
  }));

  await attachText(`${safeLabel}-page-state.json`, JSON.stringify(snapshot, null, 2));
  await page.screenshot({ fullPage: true })
    .then((body) => info.attach(`${safeLabel}-screenshot.png`, { body, contentType: "image/png" }))
    .catch(() => undefined);
}

async function attachText(name: string, body: string) {
  await test.info().attach(name, {
    body,
    contentType: "text/plain",
  }).catch(() => undefined);
}

async function runWordPressPreinstalledLogin(page: Page, demo: string, title: string) {
  test.setTimeout(420_000);

  try {
    await gotoOrSkip(page, `/?demo=${demo}`);
    await page.waitForSelector(`iframe[title="${title}"]`, { timeout: 240_000 });
    const frame = webFrame(page, title);

    await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, {
      timeout: 240_000,
    });
    await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);

    await page.getByRole("button", { name: /Log in as admin/i }).click();

    await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first()).toBeVisible({
      timeout: 180_000,
    });
    await expect(frame.locator("body")).toContainText(/Dashboard|WordPress/i, {
      timeout: 60_000,
    });
  } catch (err) {
    await attachKandeloDiagnostics(page, `${demo}-${title}`);
    throw err;
  }
}

test.describe.configure({ mode: "serial" });

test("Kandelo shell demo runs bash, vim, and NetHack", async ({ page }) => {
  test.setTimeout(360_000);

  await gotoOrSkip(page, "/?demo=shell");
  await waitForReady(page);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  // Input typed before bash's first prompt is legitimately discarded by the
  // boot chain's startup typeahead flush (tcflush), so wait for the prompt
  // like the other terminal tests do.
  await waitForTerminalContent(page, /kandelo\$ ?/, 120_000);

  await runTerminalCommand(
    page,
    "vals=(alpha beta); [[ ${vals[1]} == beta ]] && export PS1=\"KANDELO_\"'BASH_OK'\":$BASH_VERSION:$(pwd) $ \"",
    /KANDELO_BASH_OK:[0-9][^\r\n]*:\/home\/user/,
  );
  await runTerminalCommand(
    page,
    "if vim --version | head -1 | grep -q 'VIM - Vi IMproved'; then export PS1='KANDELO_''VIM_OK $ '; else export PS1='KANDELO_''VIM_FAIL $ '; fi",
    "KANDELO_VIM_OK",
  );
  await runTerminalCommand(
    page,
    "touch /home/.nethack/record; nethack -s all >/tmp/kandelo-nethack.out 2>&1; status=$?; if grep -q 'Cannot open record file' /tmp/kandelo-nethack.out; then export PS1=\"KANDELO_\"\"NETHACK_BAD:$status $ \"; else export PS1=\"KANDELO_\"\"NETHACK_OK:$status $ \"; fi",
    "KANDELO_NETHACK_OK:0",
    180_000,
  );
});

test("Kandelo Node.js demo evaluates JavaScript in the terminal", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=node");
  await waitForReady(page);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(
    page,
    /spidermonkey-node\$ ?/,
  );
  expect(await terminalText(page)).not.toContain("Segmentation fault");

  await runTerminalCommand(
    page,
    "node -e \"console.log('KANDELO_NODE_OK:' + (6 * 7))\"",
    "KANDELO_NODE_OK:42",
    180_000,
  );
  expect(await terminalText(page)).not.toContain("Segmentation fault");
});

test("Kandelo nginx demo serves its web preview", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=nginx");
  await page.waitForSelector('iframe[title="nginx"]', { timeout: 180_000 });

  await expect(webFrame(page, "nginx").locator("body")).toContainText(
    "Hello from nginx on WebAssembly!",
    { timeout: 120_000 },
  );

  await openTerminalDrawer(page);
  await waitForTerminalContent(page, /kandelo\$ ?/, 120_000);
  await runTerminalCommand(
    page,
    "if [ \"$(id -u):$HOME:$(pwd)\" = '1000:/home/user:/home/user' ]; then export PS1=\"KANDELO_\"\"NGINX_TERMINAL_OK $ \"; else export PS1=\"KANDELO_\"\"NGINX_TERMINAL_BAD:$(id -u):$HOME:$(pwd) $ \"; fi",
    "KANDELO_NGINX_TERMINAL_OK",
  );
  await runTerminalCommand(
    page,
    "printf '%s\\n' '<!doctype html><title>Kandelo nginx</title><h1>KANDELO_EDIT_OK</h1>' > /var/www/html/index.html && export PS1=\"KANDELO_\"\"NGINX_EDIT_OK $ \" || export PS1=\"KANDELO_\"\"NGINX_EDIT_BAD:$? $ \"",
    "KANDELO_NGINX_EDIT_OK",
  );
  await webFrame(page, "nginx").locator("body").evaluate(() => {
    window.location.reload();
  });
  await expect(webFrame(page, "nginx").locator("body")).toContainText("KANDELO_EDIT_OK", {
    timeout: 120_000,
  });
});

test("Kandelo nginx + PHP demo serves dynamic PHP through the web preview", async ({ page }) => {
  test.setTimeout(300_000);

  await gotoOrSkip(page, "/?demo=nginx-php");
  await page.waitForSelector('iframe[title="nginx + PHP"]', { timeout: 180_000 });

  await expect(webFrame(page, "nginx + PHP").locator("body")).toContainText(
    "PHP-FPM on WebAssembly",
    { timeout: 180_000 },
  );

  await openTerminalDrawer(page);
  await waitForTerminalContent(page, /kandelo\$ ?/, 120_000);
  await runTerminalCommand(
    page,
    "if [ \"$(id -u):$HOME:$(pwd)\" = '1000:/home/user:/home/user' ]; then export PS1=\"KANDELO_\"\"NGINX_PHP_TERMINAL_OK $ \"; else export PS1=\"KANDELO_\"\"NGINX_PHP_TERMINAL_BAD:$(id -u):$HOME:$(pwd) $ \"; fi",
    "KANDELO_NGINX_PHP_TERMINAL_OK",
  );
});

test("Kandelo WordPress SQLite demo is preinstalled and logs into wp-admin", async ({ page }) => {
  await runWordPressPreinstalledLogin(page, "wordpress-sqlite", "WordPress SQLite");
});

test("Kandelo WordPress MariaDB demo is preinstalled and logs into wp-admin", async ({ page }) => {
  await runWordPressPreinstalledLogin(page, "wordpress-mariadb", "WordPress MariaDB");
});

test("Kandelo fbDOOM demo renders to the framebuffer", async ({ page }) => {
  test.setTimeout(240_000);

  await gotoOrSkip(page, "/?demo=doom");
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 180_000 });

  await expect
    .poll(async () => {
      return page.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) => {
        if (canvas.width === 0 || canvas.height === 0) return false;
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;
        const sample = ctx.getImageData(0, 0, Math.min(canvas.width, 64), Math.min(canvas.height, 64)).data;
        for (let i = 0; i < sample.length; i += 4) {
          if (sample[i] !== 0 || sample[i + 1] !== 0 || sample[i + 2] !== 0) return true;
        }
        return false;
      });
    }, { timeout: 180_000 })
    .toBe(true);
});
