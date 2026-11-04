import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { clockBounds, nativeVisibleLatencyBounds, quantile, type ClockSample } from './clock-bounds.js';
import { learnPixelTemplate } from './pixel-template.js';
import { calibrateViewport, viewportMarkers, mapViewportPoint } from './viewport-calibration.js';
import { snapshotRaster } from './captured-raster.js';
import { NativeWindowObserver, type WindowObserver } from './native-observer-client.js';
import { HeadlessWindowObserver } from './headless-window-observer.js';
import { cursorControlScript, cursorPositions } from './cursor-control-page.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = process.env.KPERF_CURSOR_CONTROL_OUT;
assert(out, 'KPERF_CURSOR_CONTROL_OUT must name a private output directory');
const native = process.env.KPERF_CURSOR_OBSERVER === 'native';
assert(['native', 'headless'].includes(process.env.KPERF_CURSOR_OBSERVER ?? ''));
const engines = (process.env.KPERF_NATIVE_ENGINES ?? 'chromium,firefox,webkit').split(',');
assert(engines.length && new Set(engines).size === engines.length && engines.every(e => ['chromium', 'firefox', 'webkit'].includes(e)));
const count = Number(process.env.KPERF_CURSOR_SAMPLES ?? '60');
assert(Number.isInteger(count) && count >= 4 && count <= 120);
const pw = await import(pathToFileURL(join(root, 'apps/browser-demos/node_modules/@playwright/test/index.mjs')).href);
let failed = false;
for (const engine of engines) for (const mode of ['dom', 'offscreen'] as const) {
  const dir = join(out, engine, mode); mkdirSync(dir, { recursive: true });
  let server: any, browser: any, context: any, page: any, observer: WindowObserver | undefined, closed = false;
  const sourceErrors: string[] = [];
  try {
    const profile = mkdtempSync(join(dir, 'profile-'));
    // Match the browser gate's test-launcher profile isolation on macOS.
    server = await pw[engine].launchServer({ headless: !native,
      ...(engine === 'chromium' ? { channel: 'chromium' } : {}),
      ...(engine === 'firefox' ? { env: { ...process.env, CFFIXED_USER_HOME: profile } } : {}) });
    browser = await pw[engine].connect(server.wsEndpoint());
    context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    page = await context.newPage(); page.on('pageerror', (e: Error) => sourceErrors.push(e.message));
    const title = `KandeloCursorObserver-${randomUUID()}`;
    await page.goto('data:text/html,' + encodeURIComponent(`<title>${title}</title>`));
    await page.evaluate(cursorControlScript(mode));
    if (native) await page.bringToFront();
    await page.screenshot({ path: join(dir, 'startup.png') });
    if (native) {
      const tree = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const owners = new Set<number>([server.process().pid]);
      let changed = true;
      while (changed) { changed = false; for (const [pid, parent] of tree) if (owners.has(parent) && !owners.has(pid)) { owners.add(pid); changed = true; } }
      writeFileSync(join(dir, 'browser-owners.json'), JSON.stringify([...owners]));
      observer = new NativeWindowObserver(join(resolve(out), 'window-capture'), title, [...owners], 'points');
    } else observer = new HeadlessWindowObserver(page, join(resolve(out), 'pixel-matcher-offline'));
    const stream = observer.stream;
    const ready = await stream.wait(r => r.kind === 'ready');
    const pageCalibrate = async () => {
      const samples: ClockSample[] = [];
      for (let i = 0; i < 9; i++) { const n0 = performance.now(), b = await page.evaluate(() => performance.now()), n1 = performance.now(); samples.push({ n0, n1, b }); }
      return samples;
    };
    const pageBefore = await pageCalibrate(), nativeBefore = await observer.calibrate();
    const settle = async () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const snapshot = async (id: string) => {
      const after = stream.rows.length;
      const pending = stream.wait(r => r.kind === 'pixels' && r.id === id, after);
      observer!.command(`pixels ${id}`);
      await page.evaluate(() => (globalThis as any).pulse());
      await observer!.flush();
      return pending;
    };
    await page.evaluate(() => (globalThis as any).markers(true)); await settle();
    const markerRow = await snapshot('geometry');
    const geometry = calibrateViewport(snapshotRaster(markerRow), viewportMarkers(800, 600));
    if (!native) {
      assert(Math.abs(geometry.x.scale - .75) < .003 && Math.abs(geometry.y.scale - .75) < .003);
      assert(Math.abs(geometry.x.offset - 7) <= 1 && Math.abs(geometry.y.offset - 53) <= 1);
      assert.throws(() => calibrateViewport({ ...snapshotRaster(markerRow), bgra: new Uint8Array(markerRow.stride * markerRow.height) }, viewportMarkers(800, 600)), /marker/);
    }
    writeFileSync(join(dir, 'geometry.json'), JSON.stringify({ geometry, captureWidth: markerRow.width, captureHeight: markerRow.height }, null, 2));
    await page.evaluate(() => (globalThis as any).markers(false)); await settle();
    const rectStart = mapViewportPoint(geometry, { x: cursorPositions.a.x - 4, y: cursorPositions.a.y - 4 });
    const rect = { ...rectStart, width: Math.ceil(32 * geometry.x.scale) + 1, height: Math.ceil(40 * geometry.y.scale) + 1 };
    // Learn directly in the capture raster. Browser screenshots and native
    // composition have different edge coverage even at the same nominal scale.
    // These samples remain candidates until independent native pose checks.
    await page.evaluate(() => (globalThis as any).pose('a')); await settle();
    await page.screenshot({ path: join(dir, 'setup-a.png') });
    const nativeA = snapshotRaster(await snapshot('foreground-candidate'));
    await page.evaluate(() => (globalThis as any).pose('b')); await settle();
    await page.screenshot({ path: join(dir, 'setup-b.png') });
    const nativeB = snapshotRaster(await snapshot('background-candidate'));
    const candidates = Object.entries(cursorPositions).map(([id, p]) => ({ id, ...mapViewportPoint(geometry, { x: p.x - 4, y: p.y - 4 }) }));
    const tag = randomUUID();
    const config = { tag, template: learnPixelTemplate(nativeB, nativeA, rect), candidates,
      searchRadius: 1, maxChannelError: 48, maxMeanError: 12 };
    const configure = async () => {
      const pending = stream.wait(r => r.kind === 'matcher-configured' && r.tag === config.tag, stream.rows.length);
      observer!.command(`matcher ${JSON.stringify(config)}`); await pending;
    };
    const matched = (id: string, after: number) => stream.wait(r => r.kind === 'frame' && r.pixelMatch?.tag === config.tag &&
      r.pixelMatch.state === 'matched' && r.pixelMatch.matches[0].id === id, after);
    const pose = async (id: string) => {
      const pending = matched(id, stream.rows.length);
      await page.evaluate((id: string) => (globalThis as any).pose(id), id);
      await observer!.flush(); return pending;
    };
    await configure();
    // Prove the learned pose and two independently held-out poses. Neither
    // source labels, acknowledgement nor rAF establishes a native endpoint.
    const provenSnapshot = async (id: string, target: string) => {
      const row = await snapshot(id);
      // Native snapshots refer to the separately emitted frame identity;
      // never infer a pose from the requested label or a source ack.
      const frame = stream.rows.find(r => r.kind === 'frame' && r.index === row.index);
      assert.equal(frame?.pixelMatch?.tag, config.tag);
      assert.equal(frame.pixelMatch.state, 'matched'); assert.equal(frame.pixelMatch.matches[0].id, target);
      return snapshotRaster(row);
    };
    await pose('a'); await provenSnapshot('confirmed-a', 'a');
    await pose('b'); await provenSnapshot('held-out-b', 'b');
    await pose('c'); await provenSnapshot('held-out-c', 'c');
    console.log(JSON.stringify({ engine, mode, native, phase: 'calibration-verified' }));
    writeFileSync(join(dir, 'configuration.json'), JSON.stringify(config, null, 2));
    await pose('a'); stream.arm();
    await page.evaluate(() => { const g = globalThis as any; g.inputs = []; g.skip = true; g.nextTarget = 'b'; });
    const noopStart = stream.rows.length;
    await page.keyboard.press('a');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    const noopFrame = matched('a', stream.rows.length);
    await page.evaluate(() => (globalThis as any).pulse()); await observer.flush(); await noopFrame;
    assert(!stream.rows.slice(noopStart).some(r => r.pixelMatch?.tag === config.tag && r.pixelMatch.matches.some((m: any) => m.id === 'b')),
      'No-op input fabricated target pixels');
    await page.evaluate(() => { (globalThis as any).skip = false; });
    const samples: any[] = [];
    for (let i = 0; i <= count; i++) {
      const target = i % 2 ? 'a' : 'b', delayed = i === count;
      const phaseMs = [0, 3, 7, 11][i % 4];
      await new Promise(resolve => setTimeout(resolve, phaseMs));
      await page.evaluate(({ target, delayed }: { target: string; delayed: boolean }) => { const g = globalThis as any; g.nextTarget = target; g.delay = delayed ? 50 : 0; }, { target, delayed });
      const pending = matched(target, stream.rows.length);
      await page.keyboard.press('a'); await observer.flush();
      samples.push({ seq: i + 2, target, delayed, phaseMs, visible: await pending });
      if (!native && i % 10 === 9) console.log(JSON.stringify({ engine, mode, native, responses: i + 1 }));
    }
    const nativeAfter = await observer.calibrate(), pageAfter = await pageCalibrate();
    const data = await page.evaluate(() => { const g = globalThis as any; return { inputs: g.inputs, workerInfo: g.workerInfo ?? null, controlErrors: g.controlErrors }; });
    assert.equal(data.inputs.length, count + 2); assert.deepEqual(data.controlErrors, []); assert.deepEqual(sourceErrors, []);
    const nc = clockBounds([...nativeBefore, ...nativeAfter], .25), pc = clockBounds([...pageBefore, ...pageAfter], 2);
    const nativeToPage = { lo: pc.lo - nc.hi, hi: pc.hi - nc.lo };
    const frames = stream.rows.filter(r => r.kind === 'frame' && r.pixelMatch?.tag === config.tag);
    for (const sample of samples) {
      sample.input = data.inputs.find((r: any) => r.seq === sample.seq);
      assert(sample.input && sample.input.target === sample.target && !sample.input.skip);
      const previous = frames.filter(r => r.index < sample.visible.index && r.pixelMatch.state === 'matched' && r.pixelMatch.matches[0].id !== sample.target).at(-1);
      sample.previousNonResponse = previous ?? null;
      sample.displayBounds = nativeVisibleLatencyBounds(sample.input.eventAt, previous?.displayMs, sample.visible.displayMs, nativeToPage);
    }
    const delayed = samples.at(-1);
    assert(delayed.input.beforeDrawAt - delayed.input.eventAt >= 49, 'Control did not inject its promised stall');
    assert(delayed.displayBounds.hi >= 49, 'Pixel observer hid the known stall');
    const regular = samples.filter(s => !s.delayed);
    const summary: any = { engine, mode, version: browser.version(), native,
      scope: native ? 'Native owned-window moving-pixel CONTROL; not Kandelo desktop performance or total instrumentation overhead' : 'Headless control flow with synthetic window geometry/timestamps; NOT native timing',
      responses: regular.length, delayedResponses: 1, noOp: 'pass', geometry,
      ambiguousFrames: frames.filter(r => r.pixelMatch.state === 'ambiguous').length,
      unmatchedFrames: frames.filter(r => r.pixelMatch.state === 'unmatched').length };
    if (native) {
      summary.displayP50 = { lo: quantile(regular.map(s => s.displayBounds.lo), .5), hi: quantile(regular.map(s => s.displayBounds.hi), .5) };
      summary.displayP95 = { lo: quantile(regular.map(s => s.displayBounds.lo), .95), hi: quantile(regular.map(s => s.displayBounds.hi), .95) };
      summary.delayedControl = delayed.displayBounds;
      summary.matcherMsP95 = quantile(frames.map(r => r.matcherMs), .95);
    }
    stream.check(); await observer.close(); closed = true;
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ summary, ready, nativeBefore, nativeAfter, pageBefore, pageAfter,
      nc, pc, nativeToPage, samples, ...data }, null, 2));
    console.log(JSON.stringify({ engine, mode, native, responses: summary.responses, noOp: summary.noOp, delayed: 'pass' }));
  } catch (error) {
    failed = true;
    const inputs = page && !page.isClosed() ? await page.evaluate(() => (globalThis as any).inputs).catch(() => 'unavailable') : 'unavailable';
    writeFileSync(join(dir, 'failure.json'), JSON.stringify({ error: String((error as Error).stack ?? error), inputs, sourceErrors }, null, 2));
    console.error(engine, mode, String(error));
  } finally {
    if (observer && !closed) { try { await observer.close(); } catch (e) { writeFileSync(join(dir, 'cleanup-error.txt'), String(e)); } }
    if (observer) writeFileSync(join(dir, 'observer-rows.json'), JSON.stringify(observer.stream.rows));
    if (observer instanceof NativeWindowObserver) writeFileSync(join(dir, 'native-stderr.txt'), observer.stderr);
    if (context) await context.close(); if (browser) await browser.close(); if (server) await server.close();
  }
}
if (failed) process.exitCode = 1;
