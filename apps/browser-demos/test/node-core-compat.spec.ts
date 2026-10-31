import { expect, test } from "@playwright/test";
import { bufferValidationSource } from "../../../host/test/fixtures/node-buffer-validation";
import { nodeFileSyncCommand } from "../../../host/test/fixtures/node-file-sync";
import { nodeProcessExitCommand, nodeProcessExitExpected } from "../../../host/test/fixtures/node-process-exit";
import { nodeSpawnPathCommand, nodeSpawnPathExpected } from "../../../host/test/fixtures/node-spawn-path";
import { nodeStdinDecodingCommand } from "../../../host/test/fixtures/node-stdin-decoding";
import { nodeAssertionCommand } from "../../../host/test/fixtures/node-assertion-semantics";
import { nodeStdinCommand } from "../../../host/test/fixtures/node-stdin";
import { nodeUrlCommand } from "../../../host/test/fixtures/node-url";
import { nodeWebStreamsCommand } from "../../../host/test/fixtures/node-web-streams";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

test("base shell implements Node filesystem, process, URL, streams and encoding contracts", async ({ page }) => {
  test.setTimeout(360_000);
  await gotoMachine(page, "shell");
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(),
    { timeout: 120_000 }).toContain("kandelo$");
  const cases: Array<[string, readonly string[]]> = [
    [`set -eu\ncat > /tmp/buffer-core.cjs <<'JS'\nconst {isUtf8,isAscii}=require('buffer');\n${bufferValidationSource}\nJS\nnode /tmp/buffer-core.cjs`, ["buffer-validation-ok"]],
    [nodeFileSyncCommand, ["node-file-sync-ok", "node-file-io-errors-ok"]],
    [nodeProcessExitCommand, nodeProcessExitExpected],
    [nodeStdinCommand, ["stdin-eof:[]", "stdin-eof:[68656c6c6f]", "stdin-pipe:[hello]", "stdin-pause-exit-ok", "stdin-unref-exit-ok", "stdin-resume-exit-ok", "stdin-ref-exit-ok"]],
    [nodeSpawnPathCommand, nodeSpawnPathExpected],
    [nodeStdinDecodingCommand, ["node-stdin-decoding-ok"]],
    [nodeAssertionCommand, ["node-assertion-semantics-ok"]],
    [nodeUrlCommand, ["node-url-ok"]],
    [nodeWebStreamsCommand, ["node-web-streams-ok"]],
  ];
  for (const [command, expected] of cases) {
    const result = await runTerminalCommand(page, command, undefined, 120_000);
    for (const marker of expected) expect(result.output).toContain(marker);
  }
});
