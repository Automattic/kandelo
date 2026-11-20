import { test } from './support/persistent-page';
import { expect } from '../playwright-test';
import { gotoMachine } from './support/kandelo-machine';
import { configureNewComputer } from './support/computer-library';

test.use({ headless: true, actionTimeout: 10_000 });

test('computer Library configures another machine after a real display click', async ({ page, browserName }, info) => {
  test.setTimeout(300_000);
  await gotoMachine(page, 'cage');
  const canvas = page.locator('.kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas').first();
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => page.locator('.kdemo-surface-controls').allTextContents()
    .then(text => text.join(' ')), { timeout: 120_000 }).toMatch(/webgl2-gl/i);
  // Exercise the real browser capture and the normal Library helper. A forced
  // click or navigation would hide the same stall in the memory-switch gate.
  await canvas.click({ position: { x: 30, y: 30 } });
  const captureOutcome = async () => {
    if (await canvas.evaluate(node => document.pointerLockElement === node)) return 'captured';
    if (await page.getByRole('alert').filter({ hasText: 'Pointer lock was denied by the browser.' }).isVisible()) return 'denied';
    return 'pending';
  };
  // This headless WebKit reports a native denial. Observe that visible path;
  // Chromium/Firefox must exercise real capture, which exposes the regression.
  await expect.poll(captureOutcome).toMatch(browserName === 'webkit' ? /^(captured|denied)$/ : /^captured$/);
  info.annotations.push({ type: 'pointer-lock-outcome', description: await captureOutcome() });
  await configureNewComputer(page, 'cage');
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Boot profile', exact: true })).toHaveValue('cage');
  await expect(page.getByRole('button', { name: 'Create and boot', exact: true })).toBeEnabled();
});
