// Opt-in measurement-method integration, using a normally built desktop image
// and the diagnostic kperf host. No native timing is inferred from headless PNGs.
import { expect, test, type Page, type Worker } from '../../apps/browser-demos/node_modules/@playwright/test/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gotoMachine } from '../../apps/browser-demos/test/support/kandelo-machine';
import { typePhysicalText } from '../../apps/browser-demos/test/support/physical-typing';
import { painted, isLauncher } from '../../apps/browser-demos/test/support/scummvm-paint';
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from '../../apps/browser-demos/test/support/browser-memory-boundary';
import { desktopCursorSource } from './desktop-cursor-source';
import { measureCursorExperiment, type CursorSource } from './cursor-experiment';
import { NativeWindowObserver, ownedProcessFamily, type WindowObserver } from './native-observer-client';
import { HeadlessWindowObserver } from './headless-window-observer';

if (process.env.KPERF_DESKTOP_PIXEL_METHOD !== '1') throw new Error('Desktop pixel method requires its explicit diagnostic run configuration');
const native = process.env.KPERF_DESKTOP_PIXEL_NATIVE === '1';
const viewportText = process.env.KPERF_DESKTOP_PIXEL_VIEWPORT ?? '1280x720';
const viewportMatch = /^(\d+)x(\d+)$/.exec(viewportText);
if (!viewportMatch) throw new Error('Fixed desktop probe viewport must be WIDTHxHEIGHT');
const viewport = { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) };
test.use({ headless: !native, viewport, deviceScaleFactor: 1 });
const canvas = (page: Page) => page.locator('.kmachine-primary-slot:not(.is-hidden) canvas.kmodeset-canvas').first();
type Process = { pid: number; comm: string; state: string; cmdline: string };
const processes = (worker: Worker): Promise<Process[]> => worker.evaluate(() => (globalThis as any).__kperf.procs());

test('desktop cursor pixel method on real Foot and ScummVM', async ({ page, browser }, testInfo) => {
  test.setTimeout(600_000);
  const out = process.env.KPERF_DESKTOP_PIXEL_OUT, matcher = process.env.KPERF_PIXEL_MATCHER_BIN;
  expect(out && matcher && (!native || process.env.KPERF_NATIVE_CAPTURE_BIN), 'Private output and compiled shared matcher are required').toBeTruthy();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await installBrowserMemoryBoundaryProbe(page);
  await gotoMachine(page, 'sway');
  let worker: Worker | undefined;
  await expect.poll(async () => {
    for (const w of page.workers().filter(w => w.url().includes('browser-kernel-worker-entry'))) {
      if (await w.evaluate(() => typeof (globalThis as any).__kperf === 'object').catch(() => false)) { worker = w; return true; }
    }
    return false;
  }, { timeout: 120_000 }).toBe(true);
  const kw = worker!;
  await expect.poll(async () => {
    const p = (await processes(kw)).filter(p => !['Z', 'T'].includes(p.state));
    return ['sway', 'foot', 'sfwbar'].every(name => p.some(p => p.comm === name));
  }, { timeout: 240_000 }).toBe(true);
  const internals = page.getByRole('button', { name: 'Internals', exact: true });
  if ((await internals.getAttribute('aria-pressed')) === 'true') await internals.click();
  const demo = page.getByLabel('Computer views').getByRole('button', { name: 'Demo', exact: true });
  if ((await demo.getAttribute('aria-current')) !== 'true') await demo.click();
  await expect(canvas(page)).toBeVisible();
  await expect.poll(async () => (await page.locator('.kdemo-surface-controls').allInnerTexts()).join(' '), { timeout: 180_000 }).toMatch(/webgl2-gl/i);
  await expect.poll(async () => { const p = await painted(page); return p.footPixels / (p.width * p.height); }, { timeout: 180_000 }).toBeGreaterThan(.5);
  const box = (await canvas(page).boundingBox())!;
  const footPositions = (): CursorSource['positions'] => ({
    a: { x: box.x + box.width * .13, y: box.y + box.height * .68 },
    b: { x: box.x + box.width * .33, y: box.y + box.height * .68 },
    c: { x: box.x + box.width * .33, y: box.y + box.height * .84 },
  });
  const run = async (label: string, positions: CursorSource['positions']) => {
    const dir = join(out!, testInfo.project.name, label); mkdirSync(dir, { recursive: true });
    const source = await desktopCursorSource(page, positions, undefined, { requireRedCursor: label === 'scummvm' });
    let observer: WindowObserver;
    if (native) {
      await page.bringToFront();
      const owners = ownedProcessFamily(process.pid);
      writeFileSync(join(dir, 'owned-processes.json'), JSON.stringify(owners));
      observer = new NativeWindowObserver(process.env.KPERF_NATIVE_CAPTURE_BIN!, await page.title(), owners, 'points');
    } else observer = new HeadlessWindowObserver(page, matcher!);
    const before = await processes(kw);
    writeFileSync(join(dir, 'processes-before.json'), JSON.stringify(before));
    let stopped = false, closed = false;
    try {
      await kw.evaluate(label => (globalThis as any).__kperf.start(label), label);
      const result = await measureCursorExperiment({ page, observer, source, out: dir,
        count: Number(process.env.KPERF_DESKTOP_PIXEL_SAMPLES ?? '8'), native, injectStall: false, label });
      const counters = await kw.evaluate(() => { const k = (globalThis as any).__kperf; k.stop(); return k.snapshot(); }); stopped = true;
      const after = await processes(kw);
      const scumm = after.find(p => p.comm === 'scummvm' && !['Z', 'T'].includes(p.state));
      if (label !== 'foot-alone') expect(scumm, 'Concurrent engine remains a real live process').toBeDefined();
      result.summary.version = browser.version();
      result.summary.scope = native ? 'Native real guest pointer observation; full workload matrix and total instrumentation overhead remain required' : 'Real guest pointer pipeline and captured-pixel METHOD only; synthetic headless window clock, NOT native timing/FPS/overhead';
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ ...result, counters, processesBefore: before, processesAfter: after }, null, 2));
      await observer.close(); closed = true;
    } catch (error) {
      const counters = await kw.evaluate(() => { const k = (globalThis as any).__kperf; k.stop(); return k.snapshot(); }); stopped = true;
      writeFileSync(join(dir, 'failure-counters.json'), JSON.stringify(counters));
      writeFileSync(join(dir, 'failure.json'), JSON.stringify({ error: String((error as Error).stack ?? error), source: await source.data() }, null, 2));
      throw error;
    } finally {
      if (!stopped) await kw.evaluate(() => (globalThis as any).__kperf.stop());
      try { if (!closed) await observer.close(); } catch { /* The primary failure and rows remain evidence. */ }
      writeFileSync(join(dir, 'observer-rows.json'), JSON.stringify(observer.stream.rows));
    }
  };
  await run('foot-alone', footPositions());
  await canvas(page).click({ position: { x: 100, y: 140 } });
  await typePhysicalText(page, '/usr/local/bin/scummvm &\n', { delay: 30 });
  await expect.poll(async () => isLauncher(await painted(page)), { timeout: 180_000, intervals: [1000] }).toBe(true);
  await expect.poll(async () => (await processes(kw)).some(p => p.comm === 'scummvm' && !['Z', 'T'].includes(p.state))).toBe(true);
  await run('foot-with-scummvm', footPositions());
  const image = await painted(page);
  const list = image.pale.filter(r => r.width >= 120 && r.height >= 100).sort((a, b) => b.pixels - a.pixels)[0];
  expect(list, 'A real painted game-list pane supplies the cursor calibration region').toBeDefined();
  const point = (x: number, y: number) => ({ x: box.x + (list.x + list.width * x) * box.width / image.width,
    y: box.y + (list.y + list.height * y) * box.height / image.height });
  await run('scummvm', { a: point(.25, .4), b: point(.7, .4), c: point(.7, .75) });
  await expect(canvas(page)).toBeVisible();
  expect(errors).toEqual([]); expect(await memoryBoundaryFailures(page)).toEqual([]);
});
