import { test, expect } from '../../../../tests/playwright-test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadavg } from 'node:os';
import { serve } from '../../server.mjs';
test('Worker-owned guarded arena and tagged two-memory cost screen', async ({ page, browser }, info) => {
  const root = resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
  const server = await serve(root);
  const result: any = { version: browser.version(), loadBefore: loadavg(), pageErrors: [] };
  page.on('pageerror', error => result.pageErrors.push(String(error)));
  try {
    await page.goto(server.url + '/survey/breadth/index.html');
    await page.waitForFunction(() => typeof (window as any).runBreadthProbe === 'function');
    result.crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
    const before = performance.now();
    result.probe = await page.evaluate(() => (window as any).runBreadthProbe());
    result.workerWallMs = performance.now() - before;
    expect(result.crossOriginIsolated).toBe(true);
    expect(result.pageErrors).toEqual([]);
    expect(result.probe.passed, JSON.stringify(result.probe)).toBe(true);
    expect(result.probe.guardChecks).toBe(5);
    expect(result.probe.samples).toHaveLength(84);
  } finally {
    result.loadAfter = loadavg();
    await writeFile(resolve(root, info.project.name + '-result.json'), JSON.stringify(result, null, 2) + '\n');
    await server.close();
  }
});
