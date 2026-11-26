import { expect } from '../playwright-test';
import { test } from './support/persistent-page';
import { gotoMachine, waitForMachineBootInput, vfsImageUrlForProduct } from './support/kandelo-machine';
import { waitForSwayFootPrompt } from './support/sway-foot-prompt';
import { typePhysicalText } from './support/physical-typing';
import { setInternalsOpen } from './support/dock';
import { runTerminalCommand } from './support/terminal-command';
import { currentComputerMetadata } from './support/computer-library';

test.use({ headless: true, deviceScaleFactor: 1, viewport: { width: 1440, height: 1000 } });
test('normal shell image boots grouped Sway, accepts input and reloads ordinary files', async ({ page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = [], images: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfinished', request => { if (/\.vfs(?:\.zst)?$/.test(new URL(request.url()).pathname)) images.push(request.url()); });
  await gotoMachine(page, 'sway');
  await waitForMachineBootInput(page);
  const canvas = page.locator('.kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas').first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  await waitForSwayFootPrompt(page, canvas, 1, 180_000);
  await expect(page.getByRole('button', { name: 'Library', exact: true })).toBeEnabled();
  expect(new URL(page.url()).searchParams.get('computer')).not.toBeNull();
  if (!process.env.KANDELO_TEST_MACHINE_URLS) {
    const expectedImage = await vfsImageUrlForProduct(page, 'browser-main-shell');
    expect(images).toContain(new URL(expectedImage, page.url()).href);
  }
  await canvas.focus();
  await expect(canvas).toBeFocused();
  await typePhysicalText(page, "printf 'shell-desktop-persistence' > /home/maker/desktop-proof && sync && printf synced > /tmp/desktop-sync-complete\n", { delay: 30 });
  await info.attach('after-desktop-input', { body: await canvas.screenshot(), contentType: 'image/png' });
  const checkFile = async (directories: string[], name: string, expected: string) => {
    await setInternalsOpen(page, true);
    await page.getByRole('tab', { name: 'VFS', exact: true }).click();
    await page.getByRole('button', { name: '/', exact: true }).click();
    const row = (name: string) => page.locator('.ktable tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${name}$`) }) }).first();
    for (const directory of directories) await row(directory).click();
    const preview = page.locator('pre').filter({ hasText: expected });
    await expect.poll(async () => {
      await page.getByRole('button', { name: 'refresh', exact: true }).click();
      if (await row(name).count() !== 1) return false;
      await row(name).click(); return preview.isVisible();
    }, { timeout: 30_000 }).toBe(true);
    await setInternalsOpen(page, false);
  };
  // A document reload can kill workers abruptly. Observe sync completion,
  // matching the ordinary computer's filesystem durability contract.
  await checkFile(['tmp/'], 'desktop-sync-complete', 'synced');
  await checkFile(['home/', 'maker/'], 'desktop-proof', 'shell-desktop-persistence');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForMachineBootInput(page);
  await waitForSwayFootPrompt(page, canvas, 1, 180_000);
  await checkFile(['home/', 'maker/'], 'desktop-proof', 'shell-desktop-persistence');
  expect(errors).toEqual([]);
  await info.attach('shell-shared-desktop', { body: await canvas.screenshot(), contentType: 'image/png' });
});

test('ordinary shell starts grouped Sway as an activity in the same computer', async ({ page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await gotoMachine(page, 'shell');
  await waitForMachineBootInput(page);
  const terminal = page.locator('.kshell-terminal-slot:not([hidden]) .xterm-rows').first();
  await expect(terminal).toContainText(/maker@[^:\s]+:[^\r\n]*\$\s*$/, { timeout: 180_000 });
  expect((await runTerminalCommand(page, "printf 'ordinary-shell' > /home/maker/activity-proof")).exitCode).toBe(0);
  const url = page.url(), computer = await currentComputerMetadata(page);
  await page.getByRole('button', { name: 'Activities', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Installed activities' });
  await panel.getByRole('button', { name: 'Demos', exact: true }).click();
  await expect(panel.locator('[data-image-activity="sway"]')).toBeVisible({ timeout: 30_000 });
  await panel.locator('[data-image-activity="sway"]').getByRole('button', { name: 'Start', exact: true }).click();
  await expect(panel).not.toBeVisible();
  const canvas = page.locator('.kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas').first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  await waitForSwayFootPrompt(page, canvas, 1, 180_000);
  await canvas.focus();
  await expect(canvas).toBeFocused();
  await typePhysicalText(page, "printf '%s' '-grouped-desktop' >> /home/maker/activity-proof\n", { delay: 30 });
  await setInternalsOpen(page, true);
  await page.getByRole('tab', { name: 'VFS', exact: true }).click();
  const row = (name: string) => page.locator('.ktable tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${name}$`) }) }).first();
  for (const name of ['home/', 'maker/']) await row(name).click();
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'refresh', exact: true }).click();
    return row('activity-proof').locator('td').last().textContent();
  }, { timeout: 30_000 }).toMatch(/^30(?:\s*B)?$/);
  await row('activity-proof').click();
  await expect(page.locator('pre').filter({ hasText: 'ordinary-shell-grouped-desktop' })).toBeVisible({ timeout: 30_000 });
  expect(page.url()).toBe(url);
  expect(await currentComputerMetadata(page)).toEqual(computer);
  expect(errors).toEqual([]);
  await setInternalsOpen(page, false);
  await info.attach('shell-desktop-activity', { body: await canvas.screenshot(), contentType: 'image/png' });
});
