import { test } from './support/persistent-page';
import { expect, type Page } from '../playwright-test';
import { gotoMachine, waitForMachineBootInput } from './support/kandelo-machine';
import { setInternalsOpen } from './support/dock';
import { typePhysicalText } from './support/physical-typing';
import { waitForSwayFootPrompt } from './support/sway-foot-prompt';

// Exercise the same shell image and profile selection as the normal gallery.
test.use({ headless: true, viewport: { width: 1499, height: 1000 }, deviceScaleFactor: 1 });
const canvas = (page: Page) => page.locator('.kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas').first();
async function surface(page: Page, internals: boolean) {
  if (internals) await waitForMachineBootInput(page);
  await setInternalsOpen(page, internals);
  if (!internals) {
    const button = page.getByLabel('Computer views').getByRole('button', { name: 'Graphics', exact: true });
    if (await button.getAttribute('aria-current') !== 'true') await button.click();
    await canvas(page).focus();
    await expect(canvas(page)).toBeFocused();
  }
}

async function footPids(page: Page, count: number, samples: unknown[]) {
  await surface(page, true);
  await page.getByRole('tab', { name: 'Procs', exact: true }).click();
  let snapshot: Array<{ pid: number; ppid: number; command: string }> = [];
  // Read one initialized render: Loading and a live Foot without its Bash
  // child must not satisfy the process-lifetime assertion.
  await expect.poll(async () => {
    snapshot = await page.locator('.ktable tbody tr').evaluateAll(rows => rows.flatMap(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length !== 5) return [];
      return [{ pid: Number(cells[0].textContent?.match(/\d+/)?.[0]),
        ppid: Number(cells[1].textContent), command: cells[4].textContent ?? '' }];
    }));
    const feet = snapshot.filter(row => /^(?:\/\S*\/)?foot(?:\s|$)/.test(row.command));
    const shells = snapshot.filter(row => feet.some(foot => foot.pid === row.ppid)
      && /^(?:-?(?:\/\S*\/)?(?:bash|sh))(?:\s|$)/.test(row.command));
    return { initialized: snapshot.some(row => row.pid === 1), feet: feet.length, shells: shells.length };
  }, { timeout: 90_000 }).toEqual({ initialized: true, feet: count, shells: count });
  const pids = snapshot.filter(row => /^(?:\/\S*\/)?foot(?:\s|$)/.test(row.command)).map(row => row.pid);
  samples.push({ count, pids, processes: snapshot });
  if (count > 0) await surface(page, false);
  return pids;
}

test('trusted desktop keeps twelve terminals usable and reuses closed capacity', async ({ page }, info) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const samples: unknown[] = [];
  try {
    await gotoMachine(page, 'sway');
    await surface(page, true);
    await expect.poll(async () => (await page.locator('.ksys-line').allInnerTexts()).join('\n'),
      { timeout: 180_000 }).toMatch(/running .*\/usr\/bin\/sway/);

    await footPids(page, 1, samples);
    await expect.poll(async () => (await page.locator('.kdemo-surface-controls').allInnerTexts()).join(' '),
      { timeout: 120_000 }).toMatch(/webgl2-gl/i);
    let twelve: number[] = [];
    for (let count = 2; count <= 12; count++) {
      await page.keyboard.press('Alt+Enter');
      twelve = await footPids(page, count, samples);
    }
    await waitForSwayFootPrompt(page, canvas(page), 12);
    await info.attach('twelve-terminals.png', { body: await canvas(page).screenshot(), contentType: 'image/png' });
    // Input must reach a live shell: Ctrl+D really exits the focused terminal.
    await page.keyboard.press('Control+d');
    const eleven = await footPids(page, 11, samples);
    expect(twelve.filter(pid => !eleven.includes(pid))).toHaveLength(1);
    await page.keyboard.press('Alt+Enter');
    const reopened = await footPids(page, 12, samples);
    expect(reopened.filter(pid => !twelve.includes(pid))).toHaveLength(1);
    for (const pid of eleven) expect(reopened).toContain(pid);

    await waitForSwayFootPrompt(page, canvas(page), 12);
    // A real guest IPC command must still be able to start at this occupancy.
    await typePhysicalText(page, 'swaymsg exit\n', { delay: 40 });
    await expect.poll(async () => Number(await page.locator('.kmachine-primary .kmodeset-surface')
      .getAttribute('data-kms-owner-pid')), { timeout: 60_000 }).toBe(0);
    await footPids(page, 0, samples);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('terminal-capacity.json', { body: JSON.stringify({ samples, errors }, null, 2), contentType: 'application/json' });
  }
});

test.describe('high-resolution desktop', () => {
  test.use({ viewport: { width: 3073, height: 1836 }, deviceScaleFactor: 1 });

  test('trusted desktop keeps two terminals through high-resolution workspace changes', async ({ page }, info) => {
    test.setTimeout(420_000);
    const errors: string[] = [], proofs: Array<{ cycle: number; workspace: number; content: string }> = [];
    const samples: unknown[] = [];
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    const proveInput = async (cycle: number, workspace: number) => {
      const expected = `${cycle}-${workspace}\n`;
      await typePhysicalText(page, `echo ${cycle}-${workspace} > /tmp/high-resolution-proof\n`, { delay: 8 });
      await surface(page, true);
      await page.getByRole('tab', { name: 'VFS', exact: true }).click();
      const entry = (name: string) => page.locator('.ktable tbody tr').filter({
        has: page.getByRole('cell', { name, exact: true }),
      }).first();
      await entry('tmp/').click();
      // File previews are one-shot reads. Refresh rather than accepting an
      // earlier cycle's output or a snapshot taken between truncate and write.
      await expect.poll(async () => {
        const close = page.getByRole('button', { name: 'close', exact: true });
        if (await close.isVisible()) await close.click();
        await page.getByRole('button', { name: 'refresh', exact: true }).click();
        if (!await entry('high-resolution-proof').isVisible()) return null;
        await entry('high-resolution-proof').click();
        await expect(page.locator('pre')).toBeVisible();
        return page.locator('pre').textContent();
      }, { timeout: 30_000 }).toBe(expected);
      proofs.push({ cycle, workspace, content: expected });
      await surface(page, false);
    };
    try {
      await gotoMachine(page, 'sway');
      await surface(page, true);
      await expect.poll(async () => (await page.locator('.ksys-line').allInnerTexts()).join('\n'),
        { timeout: 180_000 }).toMatch(/running .*\/usr\/bin\/sway/);
      await footPids(page, 1, samples);
      // Kernel scanout statistics establish the native mode. Placeholder
      // canvas attributes differ across engines after OffscreenCanvas transfer.
      await expect.poll(async () => (await page.locator('.kdemo-surface-controls')
        .filter({ hasText: 'flips' }).allInnerTexts()).join(' '),
      { timeout: 30_000 }).toMatch(/\b3072×1728\b/);
      await waitForSwayFootPrompt(page, canvas(page), 1);
      await page.keyboard.press('Alt+Enter');
      const tiled = await footPids(page, 2, samples);
      await waitForSwayFootPrompt(page, canvas(page), 2);
      await info.attach('high-resolution-two-terminals.png', { body: await canvas(page).screenshot(), contentType: 'image/png' });
      for (let cycle = 0; cycle < 6; cycle++) {
        // Moving the focused tile away and back resizes the actual Foot
        // buffers between full and half width, including the hidden surface.
        await page.keyboard.press('Alt+Shift+Digit2');
        await page.keyboard.press('Alt+Digit1');
        await waitForSwayFootPrompt(page, canvas(page), 1);
        await proveInput(cycle, 1);
        await page.keyboard.press('Alt+Digit2');
        await waitForSwayFootPrompt(page, canvas(page), 1);
        await proveInput(cycle, 2);
        await page.keyboard.press('Alt+Shift+Digit1');
        await page.keyboard.press('Alt+Digit1');
        await waitForSwayFootPrompt(page, canvas(page), 2);
        expect(await footPids(page, 2, samples)).toEqual(tiled);
      }
      await typePhysicalText(page, 'swaymsg exit\n', { delay: 40 });
      await expect.poll(async () => Number(await page.locator('.kmachine-primary .kmodeset-surface')
        .getAttribute('data-kms-owner-pid')), { timeout: 60_000 }).toBe(0);
      await footPids(page, 0, samples);
      expect(proofs).toHaveLength(12);
      expect(errors).toEqual([]);
    } finally {
      await info.attach('high-resolution-workspaces.json', {
        body: JSON.stringify({ samples, proofs, errors, scope: 'Actual Sway exit and zero Foots; machine remains live. No OS footprint, latency or machine-collection claim.' }, null, 2),
        contentType: 'application/json',
      });
    }
  });
});
