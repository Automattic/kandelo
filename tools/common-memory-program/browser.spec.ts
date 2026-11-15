import { test, expect } from '../../tests/playwright-test';
import { serve } from './server.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
test('translated compiled C in a disposable Worker', async ({ page, browser }, testInfo) => {
  const artifacts = resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
  const server = await serve(artifacts);
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => typeof (window as any).run === 'function');
    const result = await page.evaluate(() => (window as any).run());
    expect(result.passed).toBe(true);
    expect(result.crossOriginIsolated).toBe(true);
    await writeFile(resolve(artifacts, `program-${testInfo.project.name}.json`), JSON.stringify({ ...result, version: browser.version() },null,2)+'\n');
  } finally { await server.close(); }
});
