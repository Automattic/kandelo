import { expect } from '../../../apps/browser-demos/playwright-test';
import { test } from '../../../apps/browser-demos/test/support/persistent-page';
import { previewFrame, machineAppPrefix } from '../../../apps/browser-demos/test/support/kandelo-machine';
import { setInternalsOpen } from '../../../apps/browser-demos/test/support/dock';
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from '../../../apps/browser-demos/test/support/browser-memory-boundary';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function bytes(text: string): number {
  const match = /^(\d+(?:\.\d+)?) (B|KiB|MiB|GiB)$/.exec(text.trim());
  if (!match) throw Error(`unexpected memory cell: ${text}`);
  return Number(match[1]) * 1024 ** ['B', 'KiB', 'MiB', 'GiB'].indexOf(match[2]);
}

for (const backend of ['sqlite', 'mariadb']) {
  test(`Internals memory accounting with shared OPcache (${backend})`, async ({ page }, info) => {
    const base = process.env.KANDELO_WORDPRESS_BASE_URL;
    if (!base) throw Error('set KANDELO_WORDPRESS_BASE_URL to a current opt-in server');
    const title = `WordPress ${backend === 'sqlite' ? 'SQLite' : 'MariaDB'} (experimental)`;
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await installBrowserMemoryBoundaryProbe(page);
    const url = new URL('/kandelo/', base);
    url.searchParams.set('vfs', '/__common-memory/wordpress.vfs.zst');
    url.searchParams.set('profile', `wordpress-${backend}`);
    await page.goto(url.href);
    await expect(previewFrame(page, title).locator('body')).toContainText(/Hello world/i, { timeout: 240000 });
    const prefix = await machineAppPrefix(page, title);
    const workers = await page.evaluate(async prefix => Promise.all(Array.from({ length: 8 }, async (_, n) => {
      const response = await fetch(`${prefix}common-memory-status.php?accounting=${n}`);
      if (!response.ok) throw Error(`OPcache status HTTP ${response.status}`);
      return (await response.json()).pid;
    })), prefix);
    expect(new Set(workers).size).toBe(2);
    await setInternalsOpen(page, true);
    await page.getByRole('tab', { name: 'Procs', exact: true }).click();
    const table = page.getByRole('table', { name: 'Processes', exact: true });
    await expect(table.getByRole('columnheader')).toHaveText(['PID', 'PPID', 'USER', 'ATTRIBUTED', 'PRIVATE', 'SHARED', 'VIRTUAL', 'COMMAND']);
    const fpm = table.locator('tbody > tr').filter({ has: page.locator('td:last-child', { hasText: /php-fpm/ }) });
    await expect(fpm).toHaveCount(3);
    const cells = await fpm.evaluateAll(rows => rows.map(row => Array.from(row.querySelectorAll('td'), cell => cell.textContent ?? '')));
    for (const row of cells) {
      expect(bytes(row[5])).toBeGreaterThanOrEqual(32 * 1024 ** 2);
      expect(bytes(row[3])).toBeLessThan(bytes(row[4]) + bytes(row[5]));
    }
    // Ordinary processes are in the same report but have their own backing.
    const ordinary = table.locator('tbody > tr').filter({ has: page.locator('td:last-child', { hasText: /nginx/ }) });
    await expect(ordinary.first()).toBeVisible();
    const ordinaryCells = await ordinary.first().locator('td').allTextContents();
    expect(ordinaryCells[3]).toBe(ordinaryCells[4]);
    expect(ordinaryCells[5]).toBe('0 B');
    await page.getByText(/^Unique mapped:/).click();
    const group = page.locator('.kprocess-group').filter({ hasText: 'shared group' });
    await expect(group).toHaveCount(1);
    await expect(group.locator('summary')).toContainText('3 processes');
    const value = async (label: string) => bytes(await group.locator('dt').filter({ hasText: new RegExp(`^${label}$`) })
      .locator('xpath=following-sibling::dd[1]').innerText());
    const unique = await value('Unique mapped');
    const attributed = cells.reduce((sum, row) => sum + bytes(row[3]), 0);
    expect(Math.abs(unique - attributed)).toBeLessThan(0.025 * 1024 ** 2); // Display rounding only.
    expect(await value('Backing buffer size')).toBe(512 * 1024 ** 2);
    expect(await value('Maximum backing size')).toBe(512 * 1024 ** 2);
    expect(await value('Unaccounted allocations')).toBe(0);
    await table.locator('tbody > tr').filter({ hasText: `php-fpm` }).first().click();
    await expect(page.getByText(/^Backing group: memory-/)).toBeVisible();
    await expect(page.getByText(/memory map · pid/)).toBeVisible();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.kprocess-accounting')).toHaveAttribute('aria-busy', 'false');
    await expect(table).toBeVisible();
    await expect(page.locator('details.kprocess-groups')).toHaveAttribute('open', '');
    await expect(group.locator('dt').filter({ hasText: /^Maximum backing size$/ })
      .locator('xpath=following-sibling::dd[1]')).toHaveText('512 MiB');
    expect(pageErrors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
    const output = resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, `${info.project.name}-${backend}.json`), JSON.stringify({ workers, cells, unique, attributed, ordinaryCells, pageErrors }, null, 2));
    // Close the group breakdown to make the process columns visible in the capture.
    const breakdown = page.locator('details.kprocess-groups');
    if (await breakdown.getAttribute('open') !== null) await breakdown.locator(':scope > summary').click();
    await table.locator('tbody > tr').filter({ has: page.locator('td:last-child', { hasText: /php-fpm/ }) }).first().click();
    await page.screenshot({ path: resolve('.context', `memory-accounting-${info.project.name}-${backend}.png`), fullPage: true });
  });
}
