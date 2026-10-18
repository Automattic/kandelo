import { expect, test, type Page } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";

// A writer blocked on a full pipe whose reader exits must die by SIGPIPE
// without taking the kernel down. `grep -v zzz big.txt | head -3` used to end
// the whole machine with "fatal kernel instance failure". The Node host runs
// the same pipelines in host/test/blocked-syscall-signal-death.test.ts.

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

test("a pipe writer killed by SIGPIPE leaves the shell machine running", async ({ page }) => {
  test.setTimeout(420_000);

  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/RuntimeError|fatal kernel instance failure|Kernel worker failed|KernelTaskBindingError/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await gotoMachineOrSkip(page, "shell");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 180_000 });
  await waitForPrompt(page);

  // The success markers are assembled by printf from separate arguments, so
  // the command echoed on the terminal can never satisfy the expectations.
  await runTerminalLine(page, "seq 1 200000 > /tmp/big.txt");
  await runTerminalLine(
    page,
    "grep -v zzz /tmp/big.txt | head -3; printf 'PIPE_%s:%s\\n' 'STATUS' \"$?\"",
  );
  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("PIPE_STATUS:0");

  // 141 = 128 + SIGPIPE: the shell saw the writer die by the signal.
  await runTerminalLine(
    page,
    "{ grep -v zzz /tmp/big.txt; printf 'WRITER_%s:%s\\n' 'STATUS' \"$?\" >&2; } | head -1",
  );
  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("WRITER_STATUS:141");

  // A writer that ignores SIGPIPE sees write() fail with EPIPE instead.
  await runTerminalLine(
    page,
    "{ trap '' PIPE; seq 1 200000; printf 'IGNORED_%s:%s\\n' 'STATUS' \"$?\" >&2; } | head -1",
  );
  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("IGNORED_STATUS:1");
  expect(await terminalText(page)).toMatch(/seq: write error: Broken pipe/);

  // The kernel is still alive: a new process runs after the deaths.
  await runTerminalLine(page, "seq 4 5 | tr '\\n' ':'; printf '%s\\n' 'ALIVE'");
  await expect
    .poll(() => terminalText(page), { timeout: 60_000 })
    .toContain("4:5:ALIVE");

  expect(runtimeErrors).toEqual([]);
});
