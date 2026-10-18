import { expect, test, type Page } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

// ELinks is a lazy /usr/bin binary in the shell image. These tests drive it
// the way a person does: type into the terminal, read the screen.

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function waitForPrompt(page: Page, timeout = 180_000) {
  await expect.poll(() => terminalText(page), { timeout }).toContain("kandelo$");
}

async function focusTerminal(page: Page) {
  // An open dock popover raises a full-screen dismiss layer that swallows
  // pointer events; close it so the click reaches the terminal surface.
  const layer = page.locator(".kdock-popover-dismiss-layer");
  if (await layer.count()) {
    await layer.first().click({ force: true }).catch(() => {});
  }
  await page.locator(".kshell-host").first().click();
  const terminalInput = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await terminalInput.count()) await terminalInput.focus();
}

async function runTerminalLine(page: Page, command: string) {
  await focusTerminal(page);
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
}

async function bootShell(page: Page) {
  await gotoMachineOrSkip(page, "shell");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 180_000 });
  await waitForPrompt(page);
}

test("ELinks renders a page interactively and runs its JavaScript", async ({ page }) => {
  test.setTimeout(420_000);

  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/RuntimeError|fatal kernel instance failure|Kernel worker failed/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await bootShell(page);

  // The page's visible result exists only if its script ran: the static HTML
  // says the opposite. No -eval flag is passed, so this also proves that the
  // image's /etc/elinks/elinks.conf turns JavaScript on (upstream's default
  // is off). The success text is assembled by the script, so the command
  // echoed on the terminal can never satisfy the expectation below.
  await runTerminalLine(
    page,
    `printf '%s\\n' '<h1>ELinks on Kandelo</h1>' ` +
      `'<table border="1"><tr><td>alpha</td><td>beta</td></tr></table>' ` +
      `'<p>script did not run</p>' ` +
      `'<script>document.write("<p>squares " + [1,2,3].map(function (n) { return n * n; }).join("-") + "</p>");</script>' ` +
      `> /tmp/elinks-demo.html && clear && elinks /tmp/elinks-demo.html`,
  );

  await expect
    .poll(() => terminalText(page), { timeout: 240_000 })
    .toContain("ELinks on Kandelo");
  await expect
    .poll(() => terminalText(page), { timeout: 60_000 })
    .toContain("squares 1-4-9");
  // Table cells are laid out side by side inside drawn borders.
  await expect
    .poll(() => terminalText(page), { timeout: 30_000 })
    .toMatch(/│ alpha\s*│ beta\s*│/);

  // Leave the way a user does. Enter first dismisses the first-run welcome
  // box when it is showing (it is harmless otherwise: the page has no link
  // to follow); `q` then opens the exit confirmation, whose default is Yes.
  await focusTerminal(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.keyboard.press("q");
  await expect
    .poll(() => terminalText(page), { timeout: 30_000 })
    .toContain("Do you really want to exit ELinks?");
  await page.keyboard.press("Enter");

  // The terminal is handed back to the shell in a usable state.
  await runTerminalLine(page, "printf 'ELINKS_%s\\n' 'EXITED_CLEANLY'");
  await expect
    .poll(() => terminalText(page), { timeout: 60_000 })
    .toContain("ELINKS_EXITED_CLEANLY");

  expect(runtimeErrors).toEqual([]);
});

// Guest HTTPS in the browser is not a raw socket: the kernel terminates the
// guest's TLS locally and re-issues the request with fetch() through the CORS
// proxy (docs/browser-support.md). This checks that ELinks's own HTTP client
// works across that bridge. It needs the public internet, so it skips rather
// than fails when example.com is unreachable -- the same policy the DOOM and
// Quake demos use for their data files.
let exampleReachable = false;

test.beforeAll(async () => {
  try {
    const response = await fetch("https://example.com/", { method: "HEAD" });
    exampleReachable = response.ok;
  } catch {
    exampleReachable = false;
  }
});

test("ELinks fetches an HTTPS page through the browser network bridge", async ({ page }) => {
  test.setTimeout(420_000);
  test.skip(!exampleReachable, "example.com unreachable (offline)");

  await bootShell(page);

  // The output goes to a file and only a count reaches the terminal, so the
  // typed command cannot satisfy the expectation on its own.
  await runTerminalLine(
    page,
    "elinks -dump https://example.com/ > /tmp/example.txt 2>&1; " +
      "printf 'ELINKS_FETCH:%s:%s\\n' \"$?\" \"$(grep -c 'documentation examples' /tmp/example.txt)\"",
  );
  await expect
    .poll(() => terminalText(page), { timeout: 240_000 })
    .toMatch(/ELINKS_FETCH:0:[1-9]/);
});
