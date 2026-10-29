import { expect, test } from "@playwright/test";
import { npmLifecycleCommand } from "../../../host/test/fixtures/npm-lifecycle";
import { bunShellCommand } from "../../../host/test/fixtures/bun-shell";
import { nodeFileSyncCommand } from "../../../host/test/fixtures/node-file-sync";
import { nodeStdinCommand } from "../../../host/test/fixtures/node-stdin";
import { nodeWebStreamsCommand } from "../../../host/test/fixtures/node-web-streams";
import { nodeUrlCommand } from "../../../host/test/fixtures/node-url";
import { nodeProcessExitCommand, nodeProcessExitExpected } from "../../../host/test/fixtures/node-process-exit";
import { nodeSpawnPathCommand, nodeSpawnPathExpected } from "../../../host/test/fixtures/node-spawn-path";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

test("terminal command collection retains scrollback and real failure statuses", async ({ page }) => {
  await gotoMachine(page, "shell");
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(),
    { timeout: 120_000 }).toContain("kandelo$");
  const result = await runTerminalCommand(page,
    'for ((i=0;i<160;i++)); do printf "scrollback-line-%s\\n" "$i"; done',
    "scrollback-line-159");
  expect(result.output.match(/scrollback-line-[0-9]+/g)).toHaveLength(160);
  expect(result.output).toContain("scrollback-line-0\n");
  await expect(runTerminalCommand(page,
    'printf "before-failure\\n"; exit 23', "before-failure"))
    .rejects.toThrow("terminal command exited with status 23");
});

test("base shell installs a Bun payload and executes its JavaScript as maker", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoMachine(page, "shell");
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(),
    { timeout: 120_000 }).toContain("kandelo$");
  const result = await runTerminalCommand(page, bunShellCommand, "bun-shell-complete", 120_000);
  expect(result.output).toContain('bun-shell-ok extracted-module wasm32 ["two words","--flag"]');
  expect(result.output).toContain("buffer-validation-ok");
  expect(result.output).toContain("bun-default-platform-rejected");
  expect(result.output).toContain("bun-wrong-target-rejected");
  expect(result.output).toContain('["concurrent-one"]');
  expect(result.output).toContain('["concurrent-two"]');
  expect(result.output).toContain("bun-exit-status 23");
  expect(result.output).toContain("cache hit");
  expect(result.output).toContain("cache must be a private directory");
});

test("base shell npm runs postinstall shells and reports their failures", async ({ page }) => {
  test.setTimeout(360_000);
  await gotoMachine(page, "shell");
  await expect.poll(
    () => page.locator(".xterm-rows").first().textContent(),
    { timeout: 120_000 },
  ).toContain("kandelo$");
  const paths = await runTerminalCommand(page, nodeSpawnPathCommand, undefined, 120_000);
  for (const expected of nodeSpawnPathExpected) expect(paths.output).toContain(expected);
  const streams = await runTerminalCommand(page, nodeWebStreamsCommand, "node-web-streams-ok", 120_000);
  expect(streams.output).toContain("node-web-streams-ok");
  const url = await runTerminalCommand(page, nodeUrlCommand, "node-url-ok", 120_000);
  expect(url.output).toContain("node-url-ok");
  const exit = await runTerminalCommand(page, nodeProcessExitCommand, "node-process-exit-complete", 120_000);
  for (const marker of nodeProcessExitExpected) expect(exit.output).toContain(marker);
  const stdin = await runTerminalCommand(page, nodeStdinCommand, "stdin-ref-exit-ok", 120_000);
  for (const marker of ["stdin-eof:[]", "stdin-eof:[68656c6c6f]", "stdin-pipe:[hello]", "stdin-pause-exit-ok", "stdin-unref-exit-ok", "stdin-resume-exit-ok", "stdin-ref-exit-ok"])
    expect(stdin.output).toContain(marker);
  const sync = await runTerminalCommand(page, nodeFileSyncCommand, "node-file-sync-ok", 120_000);
  expect(sync.output).toContain("node-file-sync-ok");
  expect(sync.output).toContain("node-file-io-errors-ok");
  const result = await runTerminalCommand(page, npmLifecycleCommand, "npm-lifecycle-success", 240_000);
  expect(result.output).toContain("npm-lifecycle-child-error");
  expect(result.output).toContain("npm-lifecycle-failure-status 23");
  expect(result.output).toContain("npm-lifecycle-enospc-rejected");
  expect(result.output).toContain("npm-extraction-enospc-rejected");
});
