import { expect, test } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

test("Enter submits Composer's character-by-character choice prompt", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoMachine(page, "shell");
  await expect.poll(
    () => page.locator(".xterm-rows").first().textContent(),
    { timeout: 120_000 },
  ).toContain("kandelo$");
  await runTerminalCommand(page, "composer --version --no-ansi", "Composer version 2.10.3", 120_000);

  // Exercise the exact Symfony ChoiceQuestion used by `composer require`
  // without depending on Packagist searches or changing package versions.
  const input = page.getByRole("textbox", { name: "Terminal input" }).first();
  await input.focus();
  await page.keyboard.insertText(`php -d extension=/usr/lib/composer/phar.so -r 'require "phar:///usr/share/composer/composer.phar/vendor/autoload.php"; $helper = new Symfony\\Component\\Console\\Helper\\QuestionHelper; $question = new Symfony\\Component\\Console\\Question\\ChoiceQuestion("Pick a fixture:", ["first", "second"]); $answer = $helper->ask(new Symfony\\Component\\Console\\Input\\ArgvInput, new Symfony\\Component\\Console\\Output\\ConsoleOutput, $question); echo "CHOICE=", $answer, PHP_EOL;'`);
  await page.keyboard.press("Enter");
  const text = () => page.locator(".xterm-rows").first().textContent();
  await expect.poll(text, { timeout: 30_000 }).toContain("[1] second");
  // The prompt is printed before Symfony runs `stty -icanon -echo`.
  // Type separately after that transition: a prequeued full line would be
  // translated in canonical mode and fail to exercise the regression.
  await page.waitForTimeout(1000);
  await page.keyboard.insertText("1");
  await expect.poll(text).toMatch(/> 1\s*$/);
  await page.keyboard.press("Enter");
  await expect.poll(text, { timeout: 15_000 }).toContain("CHOICE=second");
});

test("shell loads Composer on first use and generates a working autoloader", async ({ page }) => {
  test.setTimeout(300_000);
  const downloads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["fetch", "xhr"].includes(request.resourceType()) &&
        !url.searchParams.has("import") && !url.searchParams.has("url") &&
        /\/(?:composer(?:-[^/]*)?\.zip|php(?:-[^/]*)?\.wasm)$/.test(url.pathname)) {
      downloads.push(request.url());
    }
  });
  await gotoMachine(page, "shell");
  await expect.poll(
    () => page.locator(".xterm-rows").first().textContent(),
    { timeout: 120_000 },
  ).toContain("kandelo$");
  expect(downloads).toEqual([]);

  const version = await runTerminalCommand(
    page, "composer --version --no-ansi", "Composer version 2.10.3", 120_000,
  );
  expect(version.exitCode, version.output).toBe(0);
  expect(downloads.some((url) => new URL(url).pathname.includes("composer"))).toBe(true);
  expect(downloads.some((url) => new URL(url).pathname.includes("php"))).toBe(true);
  const firstDownloads = [...downloads];

  const alias = await runTerminalCommand(
    page, "/bin/composer --version --no-ansi", "Composer version 2.10.3", 120_000,
  );
  expect(alias.exitCode, alias.output).toBe(0);
  expect(downloads).toEqual(firstDownloads);

  // A path containing spaces exercises the launcher's argument forwarding.
  // No remote repository is needed: Composer must generate and use real PHP
  // autoload files in the guest filesystem.
  const autoload = await runTerminalCommand(page, `
    mkdir -p "$HOME/composer smoke/src" &&
    cd "$HOME/composer smoke" &&
    printf '%s' '{"name":"kandelo/smoke","autoload":{"classmap":["src/"]}}' > composer.json &&
    printf '%s' '<?php class Smoke { public static function answer() { return 42; } }' > src/Smoke.php &&
    composer --working-dir "$HOME/composer smoke" dump-autoload --no-interaction --no-plugins --no-scripts &&
    php -r 'require "vendor/autoload.php"; echo "AUTOLOAD=", Smoke::answer(), PHP_EOL;'
  `, "AUTOLOAD=42", 120_000);
  expect(autoload.exitCode, autoload.output).toBe(0);
  expect(downloads).toEqual(firstDownloads);
});
