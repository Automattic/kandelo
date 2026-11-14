import { test, expect } from '../../tests/playwright-test';
import { serve } from './server.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import os from 'node:os';

test('individual and combined common-memory optimizations', async ({ page, browser }, info) => {
  const artifacts = resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
  const server = await serve(artifacts);
  const host = () => ({ time: new Date().toISOString(), load: os.loadavg(), freeMemory: os.freemem() });
  const before = host(), progress: unknown[] = [];
  page.on('console', message => {
    if (message.text().startsWith('progress ')) {
      const event = { event: message.text().slice(9), ...host() };
      progress.push(event); console.log(info.project.name, info.repeatEachIndex, event.event);
    }
  });
  try {
    await page.goto(`${server.url}/?optimizations`);
    await page.waitForFunction(() => typeof (window as any).run === 'function');
    const result = await page.evaluate(checksOnly => (window as any).run(checksOnly),
      process.env.KANDELO_COMMON_MEMORY_CHECKS_ONLY === '1');
    expect(result.correctness.scalarGroups).toHaveLength(35);
    expect(result.correctness.oracleOperations).toBe(210000);
    await writeFile(`${artifacts}/optimization-${info.project.name}-${info.repeatEachIndex + 1}.json`, JSON.stringify({
      ...result, browserVersion: browser.version(), before, after: host(), progress,
      host: { cpu: os.cpus()[0].model, logicalCpus: os.availableParallelism(), platform: os.platform(), arch: os.arch(),
        runnerPid: process.pid, workerIndex: info.workerIndex },
    }, null, 2) + '\n');
  } finally { await server.close(); }
});
