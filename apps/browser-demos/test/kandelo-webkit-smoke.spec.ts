import { expect, test, type Page } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function ensureGuideOpen(page: Page) {
  // The demo guide no longer auto-opens; open it from the dock on first use.
  if (await page.locator("aside.kdemo").count()) return;
  await page.getByRole("button", { name: "Demo guide" }).click({ timeout: 120_000 });
  await page.waitForSelector("aside.kdemo", { timeout: 30_000 });
}

async function waitForReady(page: Page, timeout = 180_000) {
  // "Ready" renders inside the demo guide panel, which no longer auto-opens.
  await ensureGuideOpen(page);
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout })
    .toContain("Ready");
}

async function waitForPrompt(page: Page, timeout = 120_000) {
  await expect
    .poll(() => terminalText(page), { timeout })
    .toContain("kandelo$");
}

async function dismissDockPopover(page: Page) {
  // Opening the demo guide raises a full-screen dismiss layer that swallows
  // pointer events (a real user's next click merely closes the popover).
  // Close it so the click below reaches the terminal surface.
  const layer = page.locator(".kdock-popover-dismiss-layer");
  if (await layer.count()) {
    await layer.first().click({ force: true }).catch(() => {});
  }
}

async function runTerminalLine(page: Page, command: string) {
  // WHY: this smoke intentionally tests raw WebKit input plus a persistent
  // parent-shell prompt; callers split success tokens so echo cannot match.
  await dismissDockPopover(page);
  await page.locator(".kshell-host").first().click();
  const terminalInput = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await terminalInput.count()) {
    await terminalInput.focus();
  }
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
}

test("Kandelo shell demo boots and accepts terminal input in WebKit", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(240_000);

  await gotoMachineOrSkip(page, "shell");
  await waitForReady(page);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForPrompt(page);

  await runTerminalLine(
    page,
    "printf 'KANDELO_%s\\n' 'WEBKIT_OK'; export PS1='KANDELO_''WEBKIT_OK $ '",
  );

  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("KANDELO_WEBKIT_OK");
});

test("Kandelo WebKit tears down Node before launching another demo", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(420_000);

  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Out of Memory|RangeError|RuntimeError|Kernel worker error|TAR_ENTRY_ERROR|EACCES/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await gotoMachineOrSkip(page, "node");
  await waitForReady(page, 240_000);
  await page.getByRole("button", { name: "Runtime check" }).click();
  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("worker 7");
  await page.getByRole("button", { name: "Install cowsay" }).click();
  await expect
    .poll(() => terminalText(page), { timeout: 300_000 })
    .toContain("< Kandelo >");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await page
    .locator(".kgal-row", {
      has: page.locator(".kgal-machine-title", { hasText: /^Bare shell$/ }),
    })
    .getByRole("button", { name: "Launch" })
    .click();
  await waitForReady(page, 180_000);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForPrompt(page);

  await runTerminalLine(
    page,
    "printf 'KANDELO_%s\\n' 'WEBKIT_SWITCH_OK'; export PS1='KANDELO_''WEBKIT_SWITCH_OK $ '",
  );

  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("KANDELO_WEBKIT_SWITCH_OK");
  expect(runtimeErrors).toEqual([]);
});

test("Kandelo WordPress SQLite renders in WebKit without COEP redirect failures", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only Safari compatibility smoke");
  test.setTimeout(300_000);

  const isolationErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Cross-Origin-Embedder-Policy|Redirection was blocked|CORS/i.test(text)) {
      isolationErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    if (/Cross-Origin-Embedder-Policy|Redirection was blocked|CORS/i.test(err.message)) {
      isolationErrors.push(`pageerror: ${err.message}`);
    }
  });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "";
    if (/Cross-Origin-Embedder-Policy|Redirection was blocked|CORS/i.test(errorText)) {
      isolationErrors.push(`requestfailed: ${request.url()} ${errorText}`);
    }
  });

  await gotoMachineOrSkip(page, "wordpress-sqlite");
  await page.waitForSelector('iframe[title="WordPress SQLite"]', { timeout: 240_000 });
  const frame = page.frameLocator('iframe[title="WordPress SQLite"]');
  await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, {
    timeout: 240_000,
  });
  await expect(frame.locator("form#setup, form#language-chooser")).toHaveCount(0);
  expect(isolationErrors).toEqual([]);
});
