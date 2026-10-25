import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gotoMachine, machineAppPrefix, previewFrameSelector } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

const declaredVersion = readFileSync(
  new URL("../../../packages/registry/php/package.toml", import.meta.url), "utf8",
).match(/^version = "([^"]+)"/m)![1];

for (const { profile, title, pageText } of [
  { profile: "wordpress-sqlite", title: "WordPress SQLite", pageText: /WordPress on Kandelo|Hello world/i },
  { profile: "wordpress-mariadb", title: "WordPress MariaDB", pageText: /WordPress on Kandelo|Hello world/i },
  { profile: "nginx-php", title: "nginx + PHP", pageText: /Kandelo SQLite demo/i },
]) {
  test(`${profile} runs PHP in its unprivileged terminal while FPM serves pages`, async ({ page }) => {
    test.setTimeout(300_000);
    await gotoMachine(page, profile);
    // Wait for the boot-to-web transition before selecting the terminal,
    // so the new primary surface cannot take focus during command input.
    const preview = page.locator(previewFrameSelector(title));
    await expect(preview).toBeVisible({ timeout: 240_000 });
    // Firefox's frame driver can lose the execution context after Adminer
    // creates its version-check iframe. Read the same-origin document from
    // its visible owner element, which keeps this a rendered-page check.
    const previewText = () => preview.evaluate((frame: HTMLIFrameElement) =>
      frame.contentDocument?.body?.innerText ?? "",
    );
    await expect.poll(previewText, { timeout: 240_000 }).toMatch(pageText);
    const appPrefix = await machineAppPrefix(page, title);
    await page.getByRole("button", { name: "Terminal", exact: true }).click({
      timeout: 120_000,
    });
    await expect(page.locator(".xterm-rows").first()).toContainText("kandelo$", {
      timeout: 120_000,
    });

    // PHP 8.5 checks cache-directory write access during startup. The
    // terminal user must not need write access to FPM's opcode cache.
    const version = await runTerminalCommand(page, "test \"$(id -u)\" = 1000 && php -v");
    expect(version.output).toContain(`PHP ${declaredVersion}`);
    expect(version.output).not.toContain("Fatal Error");
    const execution = await runTerminalCommand(
      page,
      `php -r 'echo PHP_VERSION, ":", ("kandelo" |> strtoupper(...)), ":cli-cache=", ini_get("opcache.enable_cli"), PHP_EOL;'`,
      `${declaredVersion}:KANDELO:cli-cache=0`,
    );
    expect(execution.exitCode).toBe(0);
    await runTerminalCommand(
      page,
      'test "$(stat -c %u:%g /var/cache/opcache)" = 65534:65534',
    );
    // Check the live FPM response while the terminal stays selected. This
    // browser fetch uses the same service-worker bridge as the preview.
    const response = await page.evaluate(async (url) => {
      const result = await fetch(url);
      return { status: result.status, body: await result.text() };
    }, appPrefix);
    expect(response.status).toBe(200);
    expect(response.body).toMatch(pageText);
    // Switching surfaces must preserve the live document and its navigation.
    await page.getByRole("button", { name: "Demo", exact: true }).click();
    await expect(preview).toBeVisible();
    await expect.poll(previewText, { timeout: 30_000 }).toMatch(pageText);
  });
}
