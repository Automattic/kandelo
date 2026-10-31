import { expect, test } from '@playwright/test';
import { nodeExitListenerCommand, nodeExitListenerExpected } from '../../../host/test/fixtures/node-exit-listeners';
import { gotoMachine } from './support/kandelo-machine';
import { runTerminalCommand } from './support/terminal-command';
test('Node exit-listener failures preserve the native status and original diagnostic', async ({ page }) => {
  test.setTimeout(180_000);
  await gotoMachine(page, 'shell');
  await expect.poll(() => page.locator('.xterm-rows').first().textContent(), { timeout: 120_000 }).toContain('kandelo$');
  const result = await runTerminalCommand(page, nodeExitListenerCommand, undefined, 120_000);
  for (const marker of nodeExitListenerExpected) expect(result.output).toContain(marker);
});
