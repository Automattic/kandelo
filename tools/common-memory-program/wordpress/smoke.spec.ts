import { expect } from '../../../apps/browser-demos/playwright-test';
import { test } from '../../../apps/browser-demos/test/support/persistent-page';
import { machineAppPrefix, previewFrame } from '../../../apps/browser-demos/test/support/kandelo-machine';
import { loginToWordPress } from '../../../apps/browser-demos/test/support/wordpress-login';
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from '../../../apps/browser-demos/test/support/browser-memory-boundary';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

for (const backend of ['sqlite', 'mariadb']) {
  test(`WordPress ${backend} with virtualized FPM and shared OPcache`, async ({ page }, info) => {
    const base = process.env.KANDELO_WORDPRESS_BASE_URL;
    if (!base) throw Error('set KANDELO_WORDPRESS_BASE_URL to the opt-in server');
    const title = `WordPress ${backend === 'sqlite' ? 'SQLite' : 'MariaDB'} (experimental)`;
    const output = resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
    await mkdir(output, { recursive: true });
    const result: Record<string, unknown> = { backend, engine: info.project.name, pageErrors: [], consoleErrors: [] };
    page.on('pageerror', e => (result.pageErrors as string[]).push(e.message));
    page.on('console', e => { if (e.type() === 'error') (result.consoleErrors as string[]).push(e.text()); });
    try {
      await installBrowserMemoryBoundaryProbe(page);
      const url = new URL('/kandelo/', base);
      url.searchParams.set('vfs', '/__common-memory/wordpress.vfs.zst');
      url.searchParams.set('profile', `wordpress-${backend}`);
      await page.goto(url.href);
      const frame = previewFrame(page, title);
      await Promise.race([
        expect(frame.locator('body')).toContainText(/Hello world/i, { timeout: 240000 }),
        page.locator('body').filter({ hasText: /Failed to boot|LiveKernelHost setup failed/ })
          .waitFor({ timeout: 240000 }).then(async () => { throw Error(await page.locator('body').innerText()); }),
      ]);
      result.homepage = true;
      const prefix = await machineAppPrefix(page, title);
      result.statuses = await page.evaluate(async prefix => Promise.all(Array.from({ length: 8 }, async (_, n) => {
        const response = await fetch(`${prefix}common-memory-status.php?probe=${n}`, { cache: 'no-store' });
        if (!response.ok) throw Error(`status endpoint: ${response.status} ${await response.text()}`);
        return response.json();
      })), prefix);
      const statuses = result.statuses as any[];
      for (const s of statuses) {
        expect(s.opcache_enabled).toBe(true);
        expect(s.file_cache_only).toBe('0');
        expect(s.file_cache).toBe('');
        expect(s.statistics.num_cached_scripts).toBeGreaterThan(50);
      }
      expect(new Set(statuses.map(s => s.pid)).size).toBe(2);
      expect(new Set(statuses.map(s => s.statistics.start_time)).size).toBe(1);
      await loginToWordPress(frame, prefix);
      result.adminLogin = true;
      await expect(frame.locator('#adminmenu')).toBeVisible();
      expect(result.pageErrors).toEqual([]);
      result.memoryBoundaryFailures = await memoryBoundaryFailures(page);
      expect(result.memoryBoundaryFailures).toEqual([]);
      result.passed = true;
      await page.screenshot({ path: resolve('.context', `common-memory-wordpress-${info.project.name}-${backend}.png`), fullPage: true });
    } catch (error) {
      result.passed = false;
      result.error = String(error);
      result.pageText = await page.locator('body').innerText().catch(() => 'unavailable');
      await page.screenshot({ path: resolve('.context', `common-memory-wordpress-${info.project.name}-${backend}-failed.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await writeFile(resolve(output, `${info.project.name}-${backend}.json`), JSON.stringify(result, null, 2) + '\n');
    }
  });
}
