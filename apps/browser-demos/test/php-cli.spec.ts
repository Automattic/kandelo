import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

const declaredVersion = readFileSync(
  new URL("../../../packages/registry/php/package.toml", import.meta.url), "utf8",
).match(/^version = "([^"]+)"/m)![1];

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
  const release = await runTerminalCommand(
    page,
    `php -n -r '$value = "kandelo" |> strtoupper(...); echo PHP_VERSION, ":", $value, PHP_EOL;'`,
    `${declaredVersion}:KANDELO`, 120_000,
  );
  expect(release.exitCode).toBe(0);
  expect(downloads).toHaveLength(1);
  const alias = await runTerminalCommand(
    page, "/bin/php -r 'echo PHP_SAPI, PHP_EOL;'", "cli", 120_000,
  );
  expect(alias.exitCode).toBe(0);
  expect(downloads).toHaveLength(1);
});
