import { expect, test, type Page } from "@playwright/test";

import {
  DEMO_LOGIN_PASSWORD,
  DEMO_LOGIN_USERNAME,
} from "../../../images/vfs/lib/demo-login";
import { runTerminalCommand } from "./support/terminal-command";

const strict = process.env.KANDELO_ROOT_LOGIN_PRODUCT_STRICT === "1";

test("the ordinary root app owns login, sudo, and the post-exit login prompt", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(!strict, "the exact root login product build configures this proof");
  test.skip(browserName !== "chromium", "the deployment proof targets Chromium");
  if (!baseURL) throw new Error("Playwright baseURL is required");
  test.setTimeout(600_000);

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  await page.goto(new URL("/", baseURL).href, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.crossOriginIsolated), {
      timeout: 120_000,
    })
    .toBe(true);
  await expect
    .poll(
      () => page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return new URL(registration.scope).pathname;
      }),
      { timeout: 120_000 },
    )
    .toBe("/");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 300_000,
  });
  await waitForTerminal(
    page,
    "Every new terminal logs in automatically.",
    300_000,
  );

  const sudo = await runTerminalCommand(
    page,
    [
      "id",
      "command -v /usr/bin/login",
      "command -v /usr/bin/sudo-lite",
      "command -v /usr/bin/sudo",
      `printf '%s\\n' '${DEMO_LOGIN_PASSWORD}' | /usr/bin/sudo -S -p '' -l`,
      `printf '%s\\n' '${DEMO_LOGIN_PASSWORD}' | /usr/bin/sudo -S -p '' id`,
    ].join(" && "),
    /uid=0(?:\(root\))?/,
    240_000,
  );
  expect(sudo.output).toContain("uid=1000");
  expect(sudo.output).toContain("/usr/bin/login");
  expect(sudo.output).toContain("/usr/bin/sudo-lite");
  expect(sudo.output).toContain("/usr/bin/sudo");

  await writeTerminalLine(page, "exit");
  await waitForTerminal(page, "login:", 120_000);
  await writeTerminalLine(page, DEMO_LOGIN_USERNAME);
  await waitForTerminal(page, "Password:", 60_000);
  await writeTerminalLine(page, "definitely-wrong");
  await waitForTerminal(page, "Login incorrect", 60_000);
  await waitForTerminalOccurrences(page, "login:", 2, 60_000);
  await writeTerminalLine(page, DEMO_LOGIN_USERNAME);
  await waitForTerminalOccurrences(page, "Password:", 2, 60_000);
  await writeTerminalLine(page, DEMO_LOGIN_PASSWORD);
  await waitForTerminal(page, "kandelo$", 120_000);

  const ordinaryLogin = await runTerminalCommand(
    page,
    "id",
    /uid=1000(?:\(maker\))?/,
  );
  expect(ordinaryLogin.exitCode).toBe(0);
  expect(runtimeErrors).toEqual([]);
});

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first()
    .evaluate((node) => node.textContent ?? "");
}

async function waitForTerminal(
  page: Page,
  expected: string,
  timeout: number,
): Promise<void> {
  await expect.poll(() => terminalText(page), { timeout }).toContain(expected);
}

async function waitForTerminalOccurrences(
  page: Page,
  expected: string,
  count: number,
  timeout: number,
): Promise<void> {
  await expect.poll(async () => {
    const text = await terminalText(page);
    return text.split(expected).length - 1;
  }, { timeout }).toBeGreaterThanOrEqual(count);
}

async function writeTerminalLine(page: Page, line: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await input.count()) await input.focus();
  else await page.locator(".kshell-host").first().click();
  await page.keyboard.insertText(line);
  await page.keyboard.press("Enter");
}
