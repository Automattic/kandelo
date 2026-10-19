import { expect, test } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

test("base shell fetches PHP CLI only on first use", async ({ page }) => {
  test.setTimeout(240_000);
  const downloads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["fetch", "xhr"].includes(request.resourceType()) &&
        !url.searchParams.has("import") && !url.searchParams.has("url") &&
        /\/php(?:-[^/]*)?\.wasm$/.test(url.pathname)) downloads.push(request.url());
  });
  await gotoMachine(page, "shell");
  await expect.poll(
    () => page.locator(".xterm-rows").first().textContent(),
    { timeout: 120_000 },
  ).toContain("kandelo$");
  expect(downloads).toEqual([]);
  const first = await runTerminalCommand(
    page, "php -r 'echo 6 * 7, PHP_EOL;'", "42", 120_000,
  );
  expect(first.exitCode).toBe(0);
  expect(downloads).toHaveLength(1);
  const alias = await runTerminalCommand(
    page, "/bin/php -r 'echo PHP_SAPI, PHP_EOL;'", "cli", 120_000,
  );
  expect(alias.exitCode).toBe(0);
  expect(downloads).toHaveLength(1);
});
