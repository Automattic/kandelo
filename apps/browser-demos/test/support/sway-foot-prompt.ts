import { createRequire } from 'node:module';
import { expect, type Locator, type Page } from '../../playwright-test';
import { swayFootPromptRows } from '../fixtures/sway-foot-prompt';

interface Pixels { width: number; height: number; data: Uint8Array }
const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as {
  PNG: { sync: { read(bytes: Buffer): Pixels } };
};
const width = 97, height = 13;
const template = swayFootPromptRows.flatMap(row => Array.from({ length: width }, (_, x) =>
  (parseInt(row[x >> 2], 16) & (8 >> (x & 3))) !== 0));
if (template.length !== width * height || !template.some(Boolean)) throw Error('Invalid Sway Foot prompt mask');

export function matchesSwayFootPrompt(pixels: Pixels, left: number, top: number, focused = true): boolean {
  if (left < 0 || top < 30 || left + width > pixels.width || top + height > pixels.height) return false;
  if (focused) {
    const at = ((top - 30) * pixels.width + left + 5) * 4;
    // An inactive terminal's retained prompt cannot authorize typing into a new window.
    if (!(pixels.data[at + 2] > pixels.data[at] + 30 && pixels.data[at + 1] > pixels.data[at] + 15)) return false;
  }
  return template.every((white, index) => {
    const at = ((top + Math.floor(index / width)) * pixels.width + left + index % width) * 4;
    return (Math.min(pixels.data[at], pixels.data[at + 1], pixels.data[at + 2]) > 150) === white;
  });
}

/** Observe the actual focused tile in Sway's initial horizontal layout. */
export async function waitForSwayFootPrompt(page: Page, canvas: Locator, windows: number) {
  if (!Number.isInteger(windows) || windows < 1 || windows > 12) throw Error('Unsupported Sway prompt geometry');
  await expect.poll(async () => {
    const pixels = PNG.sync.read(await page.screenshot({ timeout: 5000 }));
    const box = await canvas.boundingBox(), viewport = page.viewportSize();
    if (!box || !viewport || pixels.width !== viewport.width) throw Error('Sway prompt requires a visible 1x desktop');
    // Process creation does not prove Bash reached its first input prompt.
    // Sway also follows the pointer when Internals closes, so the active
    // title, rather than an assumed rightmost position, selects the target.
    for (let tile = 0; tile < windows; tile++) {
      const left = box.x + box.width * tile / windows;
      for (let y = Math.round(box.y) + 30; y <= Math.round(box.y) + 36; y++) {
        for (let x = Math.floor(left); x <= Math.ceil(left) + 5; x++) {
          if (matchesSwayFootPrompt(pixels, x, y)) return true;
        }
      }
    }
    return false;
  }, { timeout: 30_000, message: 'Focused Foot must render its Bash prompt before shell input' }).toBe(true);
}
