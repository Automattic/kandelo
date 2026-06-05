import { expect, test, type Page } from "@playwright/test";

async function gotoOrSkip(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built — Vite import error");
  }
}

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function runTerminalCommand(
  page: Page,
  command: string,
  expected: string | RegExp,
  timeout = 120_000,
) {
  await page.locator(".kshell-host").first().click();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
  const assertion = expect.poll(() => terminalText(page), { timeout });
  if (typeof expected === "string") {
    await assertion.toContain(expected);
  } else {
    await assertion.toMatch(expected);
  }
}

test("@slow Kandelo Node demo installs cowsay with npm", async ({ page }) => {
  test.setTimeout(300_000);
  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" || /Maximum call stack|Segmentation fault/i.test(text)) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await gotoOrSkip(page, "/?demo=node");
  await page.waitForSelector("aside.kdemo", { timeout: 120_000 });
  await page.getByRole("button", { name: "Runtime check" }).click();

  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout: 90_000 })
    .toContain("worker 7");

  const npmInstallCommand = [
    "rm -rf node_modules package-lock.json /tmp/.npm-cache /tmp/kandelo-npm.log /tmp/kandelo-cowsay.out",
    [
      "if npm install cowsay --verbose >/tmp/kandelo-npm.log 2>&1",
      "&& ./node_modules/.bin/cowsay Kandelo >/tmp/kandelo-cowsay.out 2>&1",
      "&& ! grep -E 'TAR_ENTRY_ERROR|EACCES' /tmp/kandelo-npm.log; then",
      "cat /tmp/kandelo-cowsay.out;",
      "export PS1=\"KANDELO_\"\"NPM_OK $ \";",
      "else",
      "cat /tmp/kandelo-npm.log;",
      "cat /tmp/kandelo-cowsay.out 2>/dev/null;",
      "export PS1=\"KANDELO_\"\"NPM_FAIL $ \";",
      "fi",
    ].join(" "),
  ].join("; ");

  await runTerminalCommand(
    page,
    npmInstallCommand,
    "KANDELO_NPM_OK",
    180_000,
  );

  const text = await page.evaluate(() => document.body.innerText);
  expect(text).toContain("< Kandelo >");
  expect(text).not.toContain("KANDELO_NPM_FAIL");
  expect(text).not.toContain("Segmentation fault");
  expect(runtimeErrors).toEqual([]);
});
