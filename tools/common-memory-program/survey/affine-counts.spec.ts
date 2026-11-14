import { test, expect } from '../../../tests/playwright-test';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from '../server.mjs';
import { serveWordPressSurvey } from './wordpress-server.mjs';
import { renderWordPressConfig } from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import { affineDelta } from './affine-counts.mjs';
test('affine address observer mapping and fork mechanism', async ({ page, browser }, info) => {
  const out = resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
  const server = await serve(resolve(process.env.KANDELO_AFFINE_MECHANISMS!));
  const result: any = { version: browser.version(), events: [] };
  page.on('pageerror', error => result.events.push(String(error)));
  try {
    await page.goto(server.url + '/artifacts/index.html');
    await page.waitForFunction(() => typeof (window as any).run === 'function');
    result.run = await page.evaluate(() => (window as any).run());
    expect(result.run.passed, JSON.stringify(result.run)).toBe(true); expect(result.events).toEqual([]);
  } finally { await mkdir(out, { recursive: true }); await writeFile(resolve(out, info.project.name + '-mechanism.json'), JSON.stringify(result, null, 2) + '\n'); await server.close(); }
});
test('WordPress affine address coverage diagnostic', async ({ page, browser }, info) => {
  const out = resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
  const report = JSON.parse(readFileSync(process.env.KANDELO_AFFINE_REPORT!, 'utf8'));
  const server = await serveWordPressSurvey({ profile: resolve(process.env.KANDELO_COMMON_MEMORY_PROFILE!), image: resolve('.scratch/common-memory-wordpress-1/wordpress.vfs.zst'), artifact: resolve(process.env.KANDELO_AFFINE_FPM!), wpConfig: renderWordPressConfig('selectable', '/', 'http') });
  const result: any = { diagnostic: 'affine-counts', version: browser.version(), events: [] };
  page.on('pageerror', error => result.events.push(String(error)));
  try {
    await page.goto(server.url); await page.waitForFunction(() => typeof (window as any).runWordPressSurvey === 'function');
    result.run = await page.evaluate(async () => {
      const { BrowserKernel } = await import('/artifacts/browser-kernel-host.mjs');
      const original = BrowserKernel.prototype.commonMemoryPrototypeStats, snapshots: any[] = [];
      BrowserKernel.prototype.commonMemoryPrototypeStats = async function (...args: any[]) { const value = await original.apply(this, args); snapshots.push(await this.commonMemoryPrototypeAccessCounts()); return value; };
      try { return { ...await (window as any).runWordPressSurvey({ label: 'vm-shared', backend: 'sqlite', warmup: 2, rounds: 1, seed: 6197, validateTimestamps: false, checkTimestampPolicy: false, probeRequests: 0 }), diagnostic: 'affine-counts', snapshots }; }
      finally { BrowserKernel.prototype.commonMemoryPrototypeStats = original; }
    });
    expect(result.run.error).toBeUndefined(); expect(result.run.trial?.error).toBeUndefined(); expect(result.run.trial?.passed).toBe(true); expect(result.run.destroyed).toBe(true);
    expect(result.run.diagnostics).toEqual([]); expect(result.run.stderr).toEqual([]); expect(result.events).toEqual([]); expect(result.run.crossOriginIsolated).toBe(true); expect(result.run.snapshots).toHaveLength(4);
    result.delta = affineDelta(result.run.snapshots[2], result.run.snapshots[3], report);
    expect(BigInt(result.delta.totals.wrappedAttempts) > 0n).toBe(true); result.passed = true;
  } catch (error) { result.error = String(error); throw error; }
  finally { await mkdir(out, { recursive: true }); await writeFile(resolve(out, info.project.name + '-affine.json'), JSON.stringify(result, null, 2) + '\n'); await server.close(); }
});
