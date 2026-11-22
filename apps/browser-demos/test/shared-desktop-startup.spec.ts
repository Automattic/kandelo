import { expect } from '../playwright-test';
import { test } from './support/persistent-page';
import { gotoMachine, waitForMachineBootInput, vfsImageUrlForProduct } from './support/kandelo-machine';
import { setInternalsOpen } from './support/dock';
import { waitForSwayFootPrompt } from './support/sway-foot-prompt';
import { typePhysicalText } from './support/physical-typing';

test.use({ headless: true, deviceScaleFactor: 1, viewport: { width: 1440, height: 1000 } });

// Requires the canonical product and the ordinary app's gallery policy, with
// the older global trusted-preview environment flag unset. Existing Sway,
// Cage and SFWBar suites own deeper rendering, input and lifecycle checks.
test('shared-desktop-browser-startup: the normal gallery runs a shared desktop from the shell image', async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors: string[] = [], images: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfinished', request => {
    const path = new URL(request.url()).pathname;
    if (/\.vfs(?:\.zst)?$/.test(path)) images.push(request.url());
  });
  await gotoMachine(page, 'sway');
  await waitForMachineBootInput(page);
  const canvas = page.locator('.kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas').first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  // Initial boot includes cold lazy program delivery and worker module loading.
  // The rendered prompt, followed by real typing, is the readiness contract.
  await waitForSwayFootPrompt(page, canvas, 1, 180_000);
  // The shell desktop follows the ordinary computer-library storage policy.
  expect(new URL(page.url()).searchParams.get('computer')).not.toBeNull();
  await expect(page.getByRole('button', { name: 'Library', exact: true })).toBeEnabled();
  const expectedImage = await vfsImageUrlForProduct(page, 'browser-main-shell');
  expect(images).toContain(new URL(expectedImage, page.url()).href);

  await canvas.focus();
  await expect(canvas).toBeFocused();
  await typePhysicalText(page,
    "printf 'shared-desktop-browser-startup' > /tmp/desktop-startup-proof\n", { delay: 30 });
  await setInternalsOpen(page, true);
  await page.getByRole('tab', { name: 'VFS', exact: true }).click();
  const row = (name: string) => page.locator('.ktable tbody tr').filter({
    has: page.locator('td:first-child', { hasText: new RegExp(`^${name}$`) }),
  }).first();
  await row('tmp/').click();
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'refresh', exact: true }).click();
    return row('desktop-startup-proof').count();
  }, { timeout: 30_000 }).toBe(1);
  await row('desktop-startup-proof').click();
  await expect(page.locator('pre').filter({ hasText: 'shared-desktop-browser-startup' })).toBeVisible();
  expect(errors).toEqual([]);
  await setInternalsOpen(page, false);
  await info.attach('canonical-shared-desktop', { body: await canvas.screenshot(), contentType: 'image/png' });
});
