import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  gotoMachine,
  machineAppPrefix,
  machinePreviewDocument,
  previewFrameSelector,
} from "./support/kandelo-machine";
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
    // The page renders on the preview origin, so it is read through the
    // frame itself; the app's document cannot reach into it. The frame is
    // taken from page.frames(), not a FrameLocator: nginx-php's Adminer page
    // embeds a COEP-blocked iframe that stops Playwright's Firefox backend
    // from resolving any FrameLocator (see machinePreviewDocument).
    const previewDocument = await machinePreviewDocument(page, title);
    const previewBody = previewDocument.locator("body");
    await expect(previewBody).toContainText(pageText, { timeout: 240_000 });
    const appPrefix = await machineAppPrefix(page, title);
    // Marks this document, so the end of the test can tell it was kept, not
    // reloaded, while the terminal was selected.
    await previewDocument.evaluate(() => {
      (window as { kandeloSurfaceProbe?: boolean }).kandeloSurfaceProbe = true;
    });
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
    // Check the live FPM response while the terminal stays selected. The
    // machine is reachable only from its own preview origin, so the fetch
    // runs inside the preview frame and goes through the same preview
    // bridge as the page.
    await expect(preview).toBeHidden();
    const response = await previewDocument.evaluate(async (url) => {
      const result = await fetch(url, { cache: "no-store" });
      return { status: result.status, body: await result.text() };
    }, appPrefix);
    expect(response.status).toBe(200);
    expect(response.body).toMatch(pageText);
    // Switching surfaces must preserve the live document and its navigation.
    await page.getByRole("button", { name: "Demo", exact: true }).click();
    await expect(preview).toBeVisible();
    expect(previewDocument.isDetached()).toBe(false);
    expect(await previewDocument.evaluate(() =>
      (window as { kandeloSurfaceProbe?: boolean }).kandeloSurfaceProbe === true)).toBe(true);
    await expect(previewBody).toContainText(pageText, { timeout: 30_000 });
  });
}
