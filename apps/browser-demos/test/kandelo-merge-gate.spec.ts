import { expect, test, type FrameLocator, type Page } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

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

async function runWordPressInstall(page: Page, demo: string, title: string) {
  test.setTimeout(600_000);

  await gotoOrSkip(page, `/?demo=${demo}`);
  await page.waitForSelector(`iframe[title="${title}"]`, { timeout: 240_000 });
  const frame = webFrame(page, title);

  await expect(
    frame.locator("form#setup, form#language-chooser, .wp-core-ui").first(),
  ).toBeVisible({ timeout: 240_000 });

  if ((await frame.locator("form#language-chooser").count()) > 0) {
    await frame.locator("form#language-chooser [type='submit']").click();
    await expect(frame.locator("form#setup")).toBeVisible({ timeout: 60_000 });
  }

  const username = "admin";
  const password = "Testpass123!Testpass123!";

  await frame.locator("#weblog_title").fill(`Kandelo ${demo} E2E`);
  await frame.locator("#user_login").fill(username);

  const passField = frame.locator("#pass1");
  if ((await passField.count()) > 0) {
    await passField.fill(password);
  }
  const pass2Field = frame.locator("#pass2");
  if ((await pass2Field.count()) > 0 && await pass2Field.isVisible()) {
    await pass2Field.fill(password);
  }

  const weakPw = frame.locator("#pw_weak, .pw-weak input[type='checkbox']");
  if ((await weakPw.count()) > 0) {
    try {
      await weakPw.check({ timeout: 5_000 });
    } catch {
      // WordPress may hide this when it accepts the generated password.
    }
  }

  await frame.locator("#admin_email").fill("admin@example.com");
  await frame.locator("#submit, [name='Submit']").click();

  await expect(
    frame.locator(".step, .install-success, h1").filter({ hasText: /success|installed|log in/i }).first(),
  ).toBeVisible({ timeout: 360_000 });

  const loginLink = frame.locator("a").filter({ hasText: /log in/i }).first();
  if ((await loginLink.count()) > 0) {
    await loginLink.click();
  } else {
    await frame.locator("body").evaluate(() => {
      window.location.href = "/app/wp-login.php";
    });
  }

  await expect(frame.locator("#loginform")).toBeVisible({ timeout: 120_000 });
  await frame.locator("#user_login").fill(username);
  await frame.locator("#user_pass").fill(password);
  await frame.locator("#wp-submit").click();

  await expect(frame.locator("#wpadminbar, #adminmenu, body.wp-admin").first()).toBeVisible({
    timeout: 180_000,
  });
  await expect(frame.locator("body")).toContainText(/Dashboard|WordPress/i, {
    timeout: 60_000,
  });
}

test.describe.configure({ mode: "serial" });

test("Kandelo shell demo runs bash, vim, and NetHack", async ({ page }) => {
  test.setTimeout(360_000);

  await gotoOrSkip(page, "/?demo=shell");
  await waitForReady(page);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });

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

test("Kandelo WordPress SQLite demo installs and logs into wp-admin", async ({ page }) => {
  await runWordPressInstall(page, "wordpress-sqlite", "WordPress SQLite");
});

test("Kandelo WordPress MariaDB demo installs and logs into wp-admin", async ({ page }) => {
  await runWordPressInstall(page, "wordpress-mariadb", "WordPress MariaDB");
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
