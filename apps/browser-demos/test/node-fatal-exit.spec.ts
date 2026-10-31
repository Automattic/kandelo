import { expect, test } from '@playwright/test';
import { nodeFatalExitCommand, nodeFatalExitExpected } from '../../../host/test/fixtures/node-fatal-exit';
import { gotoMachine } from './support/kandelo-machine';
import { runTerminalCommand } from './support/terminal-command';

test('Node fatal errors exit without draining outstanding work', async ({ page }) => {
  test.setTimeout(180_000);
  await gotoMachine(page, 'shell');
  await expect.poll(() => page.locator('.xterm-rows').first().textContent(),
    { timeout: 120_000 }).toContain('kandelo$');
  const result = await runTerminalCommand(page, nodeFatalExitCommand, undefined, 120_000);
  for (const marker of nodeFatalExitExpected) expect(result.output).toContain(marker);
});
