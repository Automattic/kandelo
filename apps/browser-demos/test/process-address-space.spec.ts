import { expect, test } from '../playwright-test';
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from './support/browser-memory-boundary';

test('explicit process access preserves aliases, protection and exact native waits in a Worker', async ({ page }) => {
  await installBrowserMemoryBoundaryProbe(page);
  const response = await page.goto('/test/fixtures/process-address-space.html');
  expect(response?.status()).toBe(200);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const outcome = await page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker('/test/fixtures/process-address-space-worker.ts', { type: 'module' });
    worker.onerror = event => reject(Error(event.message));
    worker.onmessage = event => event.data.error ? reject(Error(event.data.error)) : resolve(event.data.result);
    worker.postMessage('run');
  }));
  expect(outcome).toEqual({ crossPage: true, alias: true, byteOrder: true, protectedWrite: true,
    capturedExtent: true, revokedWaitSettled: true, finalPins: 0 });
  expect(await memoryBoundaryFailures(page)).toEqual([]);
});
