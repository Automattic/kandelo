import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { test, expect } from '../playwright-test';

const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
test.use({ deviceScaleFactor: 2, viewport: { width: 1499, height: 850 } });

test('retains a mapped desktop between redraws through scrolling and viewport changes', async ({ page, browser }, info) => {
  const errors: string[] = [];
  const samples: { sequence: number; nonBlackFraction: number }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/grouped-desktop.html?width=1280&height=720');
  await page.getByRole('button', { name: 'Start shared desktop', exact: true }).click();
  try {
    await page.waitForFunction(() => (window as any).groupedDesktop?.state.ready
      || document.querySelector('#status')?.getAttribute('data-error') === 'true', undefined, { timeout: 120000 });
    await expect(page.locator('#status')).not.toHaveAttribute('data-error', 'true');
    for (let sequence = 0; sequence < 100; sequence++) {
      if (sequence > 10) {
        await page.setViewportSize({ width: 1499, height: 500 + 20 * (sequence % 9) });
        await page.evaluate(n => window.scrollTo(0, (n % 2) * 60), sequence);
      }
      await page.mouse.move(300 + sequence % 50, 250 + sequence % 70);
      const box = await page.locator('#desktop-scene').boundingBox();
      if (!box) throw Error('Desktop scene is missing');
      // Observe browser composition, without reading or repainting its canvas.
      // Every frame counts: eventual nonblack recovery cannot hide blanking.
      const bytes = await page.screenshot();
      const png = PNG.sync.read(bytes);
      const scale = png.width / 1499;
      const left = Math.max(0, Math.ceil((box.x + 20) * scale));
      const right = Math.min(png.width, Math.floor((box.x + box.width - 20) * scale));
      const top = Math.max(0, Math.ceil((Math.max(0, box.y) + 40) * scale));
      const bottom = Math.min(png.height, Math.floor((box.y + box.height - 40) * scale));
      let nonBlack = 0, total = 0;
      for (let y = top; y < bottom; y += 8) for (let x = left; x < right; x += 8) {
        const i = 4 * (y * png.width + x);
        if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) > 16) nonBlack++;
        total++;
      }
      if (!total) throw Error('Desktop scene is outside the capture');
      const nonBlackFraction = nonBlack / total;
      samples.push({ sequence, nonBlackFraction });
      if (sequence === 0 || sequence === 99 || nonBlackFraction <= 0.25) {
        writeFileSync(info.outputPath(`frame-${sequence}.png`), bytes);
      }
    }
    expect(samples.filter(sample => sample.nonBlackFraction <= 0.25)).toEqual([]);
    expect(await page.evaluate(() => (window as any).groupedDesktop.state.ready)).toBe(true);
    expect(await page.evaluate(() => (window as any).groupedDesktop.state.diagnostics)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('presentation-samples', { body: JSON.stringify({ browser: browser.version(), samples, errors }, null, 2), contentType: 'application/json' });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('#status')).toContainText('Stopped.', { timeout: 30000 });
    expect(await page.evaluate(() => (window as any).groupedDesktop.kernel)).toBeUndefined();
    expect(await page.evaluate(() => (window as any).groupedDesktop.state.diagnostics)).toEqual([]);
    expect(errors).toEqual([]);
  }
});
