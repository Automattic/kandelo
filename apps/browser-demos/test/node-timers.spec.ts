import { expect, test } from '@playwright/test';
import { nodeTimerCommand, nodeTimerExpected } from '../../../host/test/fixtures/node-timers';
import { gotoMachine } from './support/kandelo-machine';
import { runTerminalCommand } from './support/terminal-command';
test('Node timer references, cancellation, refresh and promise lifetimes', async ({ page }) => {
  test.setTimeout(180_000);
  await gotoMachine(page, 'shell');
  await expect.poll(() => page.locator('.xterm-rows').first().textContent(), { timeout: 120_000 }).toContain('kandelo$');
  const result = await runTerminalCommand(page, nodeTimerCommand, undefined, 120_000);
  expect(result.exitCode).toBe(0);
  for (const marker of nodeTimerExpected) expect(result.output).toContain(marker);
});
