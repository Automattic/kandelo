import { createRequire } from 'node:module';
import type { Page } from '../../playwright-test';

// Use the PNG reader bundled with the declared Playwright installation.
const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');

export interface DesktopCompositionSample {
  nonBlackFraction: number;
  capturedAt: number;
}

export class DesktopCompositionError extends Error {
  constructor(readonly samples: readonly DesktopCompositionSample[]) {
    super(`Desktop did not reach stable composition: ${JSON.stringify(samples)}`);
  }
}

/** Observe the browser's composited output, including overlays. Reading the
 * source canvas can return valid pixels while its visible surface is black. */
export async function waitForDesktopComposition(
  page: Page,
  selector: string,
  timeoutMs = 10_000,
): Promise<DesktopCompositionSample[]> {
  const deadline = performance.now() + timeoutMs;
  const samples: DesktopCompositionSample[] = [];
  let consecutive = 0;
  while (performance.now() < deadline) {
    // Capture first. Canvas readback or locator scrolling must not force a
    // rendering update before the observation being qualified.
    const png = PNG.sync.read(await page.screenshot());
    const rect = await page.locator(selector).boundingBox();
    const viewport = page.viewportSize();
    if (!rect || !viewport) throw Error('Desktop composition needs a visible viewport rectangle');
    const scaleX = png.width / viewport.width;
    const scaleY = png.height / viewport.height;
    let nonBlack = 0, total = 0;
    for (let y = Math.max(0, Math.floor(rect.y * scaleY)); y < Math.min(png.height, (rect.y + rect.height) * scaleY); y += 4) {
      for (let x = Math.max(0, Math.floor(rect.x * scaleX)); x < Math.min(png.width, (rect.x + rect.width) * scaleX); x += 4) {
        const i = (y * png.width + x) * 4;
        total++;
        if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) > 16) nonBlack++;
      }
    }
    if (!total) throw Error('Desktop composition rectangle is outside the screenshot');
    const sample = { nonBlackFraction: nonBlack / total, capturedAt: Date.now() };
    samples.push(sample);
    if (samples.length > 128) samples.shift();
    // The shipped Foot background covers the mapped desktop. A title bar or
    // pointer on an otherwise black surface cannot satisfy this condition.
    consecutive = sample.nonBlackFraction > 0.25 ? consecutive + 1 : 0;
    if (consecutive === 3) return samples;
  }
  throw new DesktopCompositionError(samples);
}
