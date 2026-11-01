import { expect, test } from '@playwright/test';
import { nodeSyncProcessCommand, nodeSyncProcessExpected } from '../../../host/test/fixtures/node-sync-processes';
import { nodeModuleEntryCommand } from '../../../host/test/fixtures/node-module-entrypoints';
import { nodeSpawnPathCommand, nodeSpawnPathExpected } from '../../../host/test/fixtures/node-spawn-path';
import { gotoMachine } from './support/kandelo-machine';
import { runTerminalCommand } from './support/terminal-command';
for (const [name, command, expected] of [
  ['synchronous binary pipes and actual child process results', nodeSyncProcessCommand, nodeSyncProcessExpected],
  ['module entry dispatch and standalone shell control', nodeModuleEntryCommand, ['node-cjs-entry-ok','node-esm-entry-ok','node-module-entry-status-ok','node-standalone-shell-ok']],
  ['asynchronous child PATH and working directory controls', nodeSpawnPathCommand, nodeSpawnPathExpected],
] as const) test(`Node ${name}`, async ({ page }) => {
  test.setTimeout(240_000);
  await gotoMachine(page, 'shell');
  await expect.poll(() => page.locator('.xterm-rows').first().textContent(), { timeout:120_000 }).toContain('kandelo$');
  const result = await runTerminalCommand(page, command, undefined, 180_000);
  expect(result.exitCode).toBe(0);
  for (const marker of expected) expect(result.output).toContain(marker);
});
