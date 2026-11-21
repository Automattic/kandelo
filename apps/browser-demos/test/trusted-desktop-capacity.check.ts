import { test } from './support/persistent-page';
import { expect, type Page } from '../playwright-test';
import { waitForMachineBootInput } from './support/kandelo-machine';
import { setInternalsOpen } from './support/dock';
import { typePhysicalText } from './support/physical-typing';

// Selected only by the explicit trusted-preview config, never ordinary builds.
test.use({ headless: true });
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

test('trusted desktop keeps twelve terminals usable and reuses closed capacity', async ({ page }, info) => {
  test.setTimeout(420_000);
  const url = process.env.KANDELO_TEST_SWAY_PREVIEW_URL;
  if (!url) throw Error('This check requires the normal trusted preview app URL');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const samples: unknown[] = [];
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await surface(page, true);
    await expect.poll(async () => (await page.locator('.ksys-line').allInnerTexts()).join('\n'),
      { timeout: 180_000 }).toMatch(/running .*\/usr\/bin\/sway/);

    const footPids = async (count: number) => {
      await surface(page, true);
      await page.getByRole('tab', { name: 'Procs', exact: true }).click();
      let snapshot: Array<{ pid: number; ppid: number; command: string }> = [];
      // Read one actual process-table render, including each Foot's shell.
      // The table is temporarily replaced by Loading during process events.
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
        return { feet: feet.length, shells: shells.length };
      }, { timeout: 90_000 }).toEqual({ feet: count, shells: count });
      const pids = snapshot.filter(row => /^(?:\/\S*\/)?foot(?:\s|$)/.test(row.command)).map(row => row.pid);
      samples.push({ count, pids, processes: snapshot });
      if (count > 0) await surface(page, false);
      return pids;
    };
    await footPids(1);
    await expect.poll(async () => (await page.locator('.kdemo-surface-controls').allInnerTexts()).join(' '),
      { timeout: 120_000 }).toMatch(/webgl2-gl/i);
    let twelve: number[] = [];
    for (let count = 2; count <= 12; count++) {
      await page.keyboard.press('Alt+Enter');
      twelve = await footPids(count);
    }
    await info.attach('twelve-terminals.png', { body: await canvas(page).screenshot(), contentType: 'image/png' });
    // Input must reach a live shell: Ctrl+D really exits the focused terminal.
    await page.keyboard.press('Control+d');
    const eleven = await footPids(11);
    expect(twelve.filter(pid => !eleven.includes(pid))).toHaveLength(1);
    await page.keyboard.press('Alt+Enter');
    const reopened = await footPids(12);
    expect(reopened.filter(pid => !twelve.includes(pid))).toHaveLength(1);
    for (const pid of eleven) expect(reopened).toContain(pid);

    // A real guest IPC command must still be able to start at this occupancy.
    await typePhysicalText(page, 'swaymsg exit\n', { delay: 40 });
    await expect.poll(async () => Number(await page.locator('.kmachine-primary .kmodeset-surface')
      .getAttribute('data-kms-owner-pid')), { timeout: 60_000 }).toBe(0);
    await footPids(0);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('terminal-capacity.json', { body: JSON.stringify({ samples, errors }, null, 2), contentType: 'application/json' });
  }
});
