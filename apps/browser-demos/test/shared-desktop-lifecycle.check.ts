import { CageSession } from './support/trusted-cage';
import { test } from './support/persistent-page';
import { expect, type Page } from '../playwright-test';
import { gotoMachine, waitForMachineBootInput } from './support/kandelo-machine';
import { configureNewComputer, currentComputerMetadata } from './support/computer-library';
import { setInternalsOpen } from './support/dock';
import { typePhysicalText } from './support/physical-typing';
import { matchesSwayFootPrompt } from './support/sway-foot-prompt';
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures, memoryBoundaryRealmId } from './support/browser-memory-boundary';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { PNG } = createRequire(new URL('../package.json', import.meta.url))('playwright-core/lib/utilsBundle');

const canvas = (page: Page) => page.locator('.kmachine-primary-slot:not(.is-hidden) .kmodeset-canvas').first();
async function graphics(page: Page) {
  await setInternalsOpen(page, false);
  const button = page.getByLabel('Computer views').getByRole('button', { name: 'Graphics', exact: true });
  if (await button.getAttribute('aria-current') !== 'true') await button.click();
  await canvas(page).focus(); await expect(canvas(page)).toBeFocused();
  const box = await canvas(page).boundingBox(); if (!box) throw Error('No desktop bounds');
  await page.mouse.move(box.x + box.width - 40, box.y + 100);
}
// Observe the intended new tile, not an older prompt whose focus is about
// to move when the new Foot window maps. Otherwise typing can straddle shells.
async function rightmostPrompt(page: Page, windows: number, timeout = 120_000) {
  await expect.poll(async () => {
    const pixels = PNG.sync.read(await page.screenshot({ timeout: 5000 }));
    const box = await canvas(page).boundingBox(); if (!box) return false;
    const left = box.x + box.width * (windows - 1) / windows;
    for (let y = Math.round(box.y) + 30; y <= Math.round(box.y) + 36; y++)
      for (let x = Math.floor(left); x <= Math.ceil(left) + 5; x++)
        if (matchesSwayFootPrompt(pixels, x, y)) return true;
    return false;
  }, { timeout, message: 'The rightmost Foot tile must visibly own focus and render its prompt' }).toBe(true);
}
async function group(page: Page) {
  await setInternalsOpen(page, true);
  // Config is a one-shot snapshot. Remount it to observe each new kernel reply.
  await page.getByRole('tab', { name: 'Procs', exact: true }).click();
  await page.getByRole('tab', { name: 'Config', exact: true }).click();
  const read = () => page.locator('.ktable tbody tr').evaluateAll(rows => Object.fromEntries(rows.flatMap(row => {
    const cells = row.querySelectorAll('td'), name = cells[0]?.textContent ?? '';
    return cells.length === 2 && name.startsWith('kandelo.memory_group.') ? [[name.slice(21), cells[1].textContent ?? '']] : [];
  })));
  await expect.poll(async () => Number((await read())['backing.maximumPages']), { timeout: 30_000 }).toBe(8192);
  return read();
}
async function footCount(page: Page, count: number) {
  await setInternalsOpen(page, true); await page.getByRole('tab', { name: 'Procs', exact: true }).click();
  await expect.poll(async () => page.locator('.ktable tbody tr').evaluateAll(rows => {
    const items = rows.flatMap(row => { const cells = row.querySelectorAll('td'); return cells.length === 5 ? [{ pid: Number(cells[0].textContent?.match(/\d+/)?.[0]), command: cells[4].textContent ?? '' }] : []; });
    return { init: items.some(x => x.pid === 1), foot: items.filter(x => /^(?:\/\S*\/)?foot(?:\s|$)/.test(x.command)).length };
  }), { timeout: 60_000 }).toEqual({ init: true, foot: count });
  if (count) await graphics(page);
}
async function proof(page: Page, value: string, prefix = '') {
  await typePhysicalText(page, `${prefix}echo ${value} > /tmp/lifecycle-proof\n`, { delay: 15 });
  await setInternalsOpen(page, true); await page.getByRole('tab', { name: 'VFS', exact: true }).click();
  await page.getByRole('button', { name: '/', exact: true }).click();
  const row = (text: string) => page.locator('.ktable tbody tr').filter({ has: page.getByRole('cell', { name: text, exact: true }) }).first();
  await row('tmp/').click();
  await expect.poll(async () => {
    const close = page.getByRole('button', { name: 'close', exact: true }); if (await close.isVisible()) await close.click();
    await page.getByRole('button', { name: 'refresh', exact: true }).click();
    if (!await row('lifecycle-proof').isVisible()) return null;
    await row('lifecycle-proof').click(); await expect(page.locator('pre')).toBeVisible();
    return page.locator('pre').textContent();
  }, { timeout: 30_000 }).toBe(value + '\n');
  await graphics(page);
}

test('desktops survive twelve same-page replacements and exact guest retirement', async ({ page, browserName }, info) => {
  test.setTimeout(1_200_000);
  const failures: string[] = [], samples: unknown[] = [], cancellations: string[] = [];
  let latest: Record<string, unknown> = {};
  const cage = new CageSession(page, info);
  page.on('pageerror', e => failures.push(e.stack || e.message));
  page.on('console', m => { if (m.text().startsWith('[kernel-worker] grouped fork cancelled:') && cancellations.length < 200) cancellations.push(m.text()); if (m.type() === 'error' || /release acknowledgement timed out|retirement wake failed|incomplete graceful generation detach|graceful kernel-worker detach timed out|destroy drain timed out with woken process|force-terminating|terminated the kernel worker realm|kernel-worker realm termination failed/.test(m.text())) failures.push(m.text()); });
  await installBrowserMemoryBoundaryProbe(page);
  const save = () => writeFileSync(info.outputPath('lifecycle.json'), JSON.stringify({ engine: browserName, samples, latest, cancellations, failures, scope: 'One persistent page/context, normal shell profiles, no reload or forced GC. Alternating live-machine replacement and guest compositor exit. Not OS footprint evidence.' }, null, 2));
  try {
    await gotoMachine(page, 'cage', { search: { memoryProfile: 'constrained' } });
    const realm = await memoryBoundaryRealmId(page);
    for (let cycle = 0; cycle < 12; cycle++) {
      const profile = ['cage', 'sway', 'sway-sfwbar'][cycle % 3];
      if (cycle) {
        const previous = new URL(page.url()).searchParams.get('computer');
        await configureNewComputer(page, profile, `Desktop lifecycle ${cycle}`);
        await page.getByRole('button', { name: 'Create and boot', exact: true }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get('computer'), { timeout: 180_000 }).not.toBe(previous);
        await expect.poll(async () => (await currentComputerMetadata(page)).profileId, { timeout: 180_000 }).toBe(profile);
        await expect(page.locator('.kmprogress-card')).toHaveCount(0, { timeout: 180_000 });
      }
      await waitForMachineBootInput(page); await footCount(page, 1);
      await expect(canvas(page)).toBeVisible();
      if (profile !== 'cage') await rightmostPrompt(page, 1, 120_000);
      else await cage.waitForPrompt();
      await proof(page, `cycle-${cycle}`);
      if (profile !== 'cage') for (let reopen = 0; reopen < 3; reopen++) {
        await page.keyboard.press('Alt+Enter'); await footCount(page, 2);
        await rightmostPrompt(page, 2, 120_000);
        await proof(page, `cycle-${cycle}-reopen-${reopen}`);
        await page.keyboard.press('Control+d'); await footCount(page, 1);
        await rightmostPrompt(page, 1, 120_000);
      }
      const before = await group(page); latest = { cycle, profile, before }; save();
      expect(Number(before['backing.quarantinedReplicas'])).toBe(0);
      expect(Number(before['backing.allocatedPages'])).toBeLessThanOrEqual(Number(before['backing.maximumPages']));
      if (browserName === 'webkit') expect(Number(before['backing.physicalExtentPages'])).toBe(8192);
      let after;
      if (cycle % 2) {
        await graphics(page); await typePhysicalText(page, profile === 'cage' ? 'exit\n' : 'swaymsg exit\n', { delay: 40 });
        await expect.poll(async () => Number(await page.locator('.kmachine-primary .kmodeset-surface').getAttribute('data-kms-owner-pid')), { timeout: 60_000 }).toBe(0);
        await footCount(page, 0);
        await expect.poll(async () => { after = await group(page); latest.after = after; save(); return { objects: Number(after['backing.sharedObjects']), observers: Number(after['backing.nativeObservers']), quarantined: Number(after['backing.quarantinedReplicas']), images: Number(after['backing.images']) }; }, { timeout: 60_000 }).toEqual({ objects: 0, observers: 0, quarantined: 0, images: 2 });
      }
      expect(await memoryBoundaryRealmId(page)).toBe(realm);
      expect(await memoryBoundaryFailures(page)).toEqual([]); expect(failures).toEqual([]);
      samples.push({ cycle, profile, computer: new URL(page.url()).searchParams.get('computer'), before, after }); save();
    }
    expect(samples).toHaveLength(12);
  } finally {
    save();
    await page.screenshot({ path: info.outputPath('last.png'), timeout: 5000 }).catch(() => {});
    if (samples.length !== 12) {
      latest.processes = await cage.processes().catch(error => ({ error: String(error) }));
      await page.screenshot({ path: info.outputPath('failed-processes.png'), timeout: 5000 }).catch(() => {});
      await page.getByRole('tab', { name: 'Syslog', exact: true }).click().catch(() => {});
      latest.syslog = await page.locator('.ksys-line').allInnerTexts().catch(() => []);
      save();
    }
  }
});

test('Sway sustains 120 terminal fork/exec/resize/input/close cycles in one group', async ({ page, browserName }, info) => {
  test.setTimeout(3_600_000);
  const failures: string[] = [], samples: Array<Record<string, unknown>> = [];
  let initialSnapshot: Record<string, string> | undefined, latest: Record<string, string> | undefined;
  page.on('pageerror', e => failures.push(e.stack || e.message));
  page.on('console', m => { if (m.type() === 'error' || /release acknowledgement timed out|retirement wake failed|incomplete graceful generation detach|graceful kernel-worker detach timed out|destroy drain timed out with woken process|force-terminating|terminated the kernel worker realm|kernel-worker realm termination failed/.test(m.text())) failures.push(m.text()); });
  await installBrowserMemoryBoundaryProbe(page);
  const save = () => writeFileSync(info.outputPath('soak.json'), JSON.stringify({ engine: browserName, samples, initial: initialSnapshot, latest, failures, scope: '120 cycles, one Sway process group in one persistent page, no reload, forced GC or runtime tracing. Visible UI inspection, real guest IPC and physical input.' }, null, 2));
  try {
    await gotoMachine(page, 'sway', { search: { memoryProfile: 'constrained' } });
    await waitForMachineBootInput(page); await footCount(page, 1);
    await rightmostPrompt(page, 1, 120_000);
    const realm = await memoryBoundaryRealmId(page); const initial = await group(page); initialSnapshot = initial;
    await graphics(page);
    for (let cycle = 0; cycle < 120; cycle++) {
      await page.keyboard.press('Alt+Enter'); await footCount(page, 2);
      await rightmostPrompt(page, 2, 120_000);
      await proof(page, `cycle-${cycle}-tiled`, 'swaymsg -t get_tree > /tmp/lifecycle-tree && ');
      await page.keyboard.press('Alt+Shift+Digit2'); await page.keyboard.press('Alt+Digit2');
      await rightmostPrompt(page, 1, 120_000);
      await proof(page, `cycle-${cycle}-workspace`);
      await page.keyboard.press('Alt+Shift+Digit1'); await page.keyboard.press('Alt+Digit1');
      await rightmostPrompt(page, 2, 120_000);
      await proof(page, `cycle-${cycle}-retiled`, 'swaymsg -t get_tree > /tmp/lifecycle-tree && ');
      await page.keyboard.press('Control+d'); await footCount(page, 1);
      await rightmostPrompt(page, 1, 120_000);
      let retired: Record<string, string> = {};
      await expect.poll(async () => {
        retired = await group(page); latest = retired; save();
        return { images: retired['backing.images'], tasks: retired['admission.tasks'], quarantine: retired['backing.quarantinedReplicas'], drains: retired['backing.pendingWaitDrains'] };
      }, { timeout: 60_000 }).toEqual({ images: initial['backing.images'], tasks: initial['admission.tasks'], quarantine: '0', drains: '0' });
      expect(retired['admission.group']).toBe(initial['admission.group']);
      expect(Number(retired['backing.allocatedPages'])).toBeLessThanOrEqual(Number(initial['backing.allocatedPages']) + 64);
      expect(Number(retired['backing.sharedObjects'])).toBeLessThanOrEqual(Number(initial['backing.sharedObjects']) + 2);
      if (browserName === 'webkit') expect(Number(retired['backing.physicalExtentPages'])).toBe(8192);
      expect(await memoryBoundaryRealmId(page)).toBe(realm); expect(await memoryBoundaryFailures(page)).toEqual([]); expect(failures).toEqual([]);
      samples.push({ cycle, at: new Date().toISOString(), retired }); save(); await graphics(page);
    }
    await typePhysicalText(page, 'swaymsg exit\n', { delay: 40 });
    await expect.poll(async () => Number(await page.locator('.kmachine-primary .kmodeset-surface').getAttribute('data-kms-owner-pid')), { timeout: 60_000 }).toBe(0);
    await footCount(page, 0);
    await expect.poll(async () => { const ended = await group(page); return { objects: ended['backing.sharedObjects'], images: ended['backing.images'], observers: ended['backing.nativeObservers'] }; }, { timeout: 60_000 }).toEqual({ objects: '0', images: '2', observers: '0' });
    expect(samples).toHaveLength(120); expect(failures).toEqual([]);
  } finally { save(); await page.screenshot({ path: info.outputPath('last.png'), timeout: 5000 }).catch(() => {}); }
});
