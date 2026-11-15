import { test, expect } from '../../tests/playwright-test';
import { serve } from './server.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import os from 'node:os';

test('common-memory mechanism and translation costs', async ({ page, browser }, testInfo) => {
  const artifacts = resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
  const server = await serve(artifacts);
  const before = { time: new Date().toISOString(), load: os.loadavg(), freeMemory: os.freemem() };
  try {
    await page.goto(server.url);
    await page.waitForFunction(() => typeof (window as any).run === 'function');
    const result = await page.evaluate(checksOnly => (window as any).run(checksOnly),
      process.env.KANDELO_COMMON_MEMORY_CHECKS_ONLY === '1');
    expect(result.correctness.passed).toHaveLength(6);
    expect(result.crossOriginIsolated).toBe(true);
    const after = { time: new Date().toISOString(), load: os.loadavg(), freeMemory: os.freemem() };
    await writeFile(`${artifacts}/${testInfo.project.name}.json`, JSON.stringify({
      ...result, browserVersion: browser.version(), before, after,
      host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0].model, logicalCpus: os.availableParallelism() },
    }, null, 2) + '\n');
  } finally { await server.close(); }
});
