import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gotoMachine } from './support/kandelo-machine';
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from './support/browser-memory-boundary';
const hostModule = '/@fs' + fileURLToPath(new URL('../../../web-libs/kandelo-session/src/kernel-host.ts', import.meta.url));
const canvas = (page: Page) => page.locator('.kmachine-primary-slot:not(.is-hidden) canvas.kmodeset-canvas').first();
test.use({ headless: true });
for (const density of [1, 2])
    test.describe('KMS viewport authority at density' + density, () => {
        test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: density });
        for (const scale of [null, 1.5])
            test('canvas aspect cannot resize the ' + (scale === null ? 'native' : 'bitmap') + ' monitor', async ({ page }, testInfo) => {
                await page.goto('/trap-signal-test.html');
                await page.evaluate(async ({ hostModule, scale }) => {
                    const { LiveKernelHost } = await import(/* @vite-ignore */ hostModule);
                    const viewport = document.createElement('div'), canvas = document.createElement('canvas');
                    viewport.style.cssText = 'width:1200px;height:750px;overflow:hidden';
                    canvas.style.cssText = 'width:1200px;height:750px';
                    canvas.width = 1920;
                    canvas.height = 1080;
                    viewport.append(canvas);
                    document.body.replaceChildren(viewport);
                    const sizes: any[] = [], options: any[] = [], physicalReports: any[] = [];
                    let offscreen: OffscreenCanvas;
                    // The real observer is the physical authority, including engines whose
                    // device-pixel box differs from an emulated deviceScaleFactor product.
                    const physicalObserver = new ResizeObserver(entries => { for (const entry of entries) {
                        const dp = entry.devicePixelContentBoxSize?.[0];
                        physicalReports.push({ width: dp?.inlineSize ?? entry.contentRect.width * devicePixelRatio, height: dp?.blockSize ?? entry.contentRect.height * devicePixelRatio });
                    } });
                    physicalObserver.observe(viewport);
                    const kernel = { kmsAttachCanvas: (_id: number, screen: OffscreenCanvas, _stats: unknown, opts: any) => { offscreen = screen; options.push(Object.keys(opts)); }, kmsSetDisplaySize: (id: number, width: number, height: number, mm: unknown) => sizes.push({ id, width, height, mm }) };
                    const host = new LiveKernelHost();
                    if (scale !== null)
                        host.setPresentation({ ...host.getPresentation(), displayScale: scale });
                    host.attachKernel(kernel);
                    host.setKmsDisplayMode('webgl2-scanout');
                    host.attachKmsDisplay(canvas, 1, { displayViewport: viewport } as any);
                    const resized = (element: HTMLElement, width: number, height: number) => new Promise<void>(resolve => { const ro = new ResizeObserver(rows => { if (rows.some(r => r.target === element && Math.abs(r.contentRect.width - width) < .1 && Math.abs(r.contentRect.height - height) < .1)) {
                        ro.disconnect();
                        resolve();
                    } }); ro.observe(element); element.style.width = width + 'px'; element.style.height = height + 'px'; });
                    (globalThis as any).__viewportAuthority = { host, viewport, canvas, sizes, options, physicalReports, async backingChange() { offscreen!.width = 640; offscreen!.height = 480; await resized(canvas, 640, 480); }, async viewportChange() { await resized(viewport, 1240, 760); }, close() { physicalObserver.disconnect(); host.detachKernel(); } };
                }, { hostModule, scale });
                const expected = async (width: number, height: number) => scale === null ? await page.evaluate(() => (globalThis as any).__viewportAuthority.physicalReports.at(-1)) : { width: Math.min(3840, Math.max(640, Math.round(width / scale) & ~1)), height: Math.min(2160, Math.max(480, Math.round(height / scale) & ~1)) };
                await expect.poll(() => page.evaluate(() => (globalThis as any).__viewportAuthority.physicalReports.length)).toBeGreaterThan(0);
                const initial = await expected(1200, 750);
                await expect.poll(() => page.evaluate(() => (globalThis as any).__viewportAuthority.host.getKmsDisplaySize(1))).toEqual(initial);
                await page.evaluate(() => (globalThis as any).__viewportAuthority.backingChange());
                // A separate ResizeObserver's completed canvas-size report fences this
                // assertion. A fixed sleep could miss the wrong observer's late delivery.
                expect(await page.evaluate(() => (globalThis as any).__viewportAuthority.host.getKmsDisplaySize(1))).toEqual(initial);
                await page.evaluate(() => (globalThis as any).__viewportAuthority.viewportChange());
                await expect.poll(() => page.evaluate(() => (globalThis as any).__viewportAuthority.host.getKmsDisplaySize(1))).toEqual(await expected(1240, 760));
                const evidence = await page.evaluate(() => { const f = (globalThis as any).__viewportAuthority; return { sizes: f.sizes, workerOptions: f.options, physicalReports: f.physicalReports }; });
                expect(evidence.workerOptions.flat()).not.toContain('displayViewport');
                writeFileSync(testInfo.outputPath('viewport-authority.json'), JSON.stringify({ density, scale, ...evidence }, null, 2));
                await page.evaluate(() => (globalThis as any).__viewportAuthority.close());
            });
        test('normal Freeciv first presentation, cursor fit and menu clicks survive viewport resize', async ({ page, browser }, testInfo) => {
            test.setTimeout(360000);
            const errors: string[] = [];
            page.on('pageerror', e => errors.push(e.message));
            await installBrowserMemoryBoundaryProbe(page);
            // Observe the real containing viewport from its first layout. A
            // view switch during launch must not withdraw the selected mode;
            // checking only the final box would miss a transient dock resize.
            await page.addInitScript(() => {
                const rows: Array<{width:number;height:number}> = [];
                (globalThis as any).__startupViewportReports = rows;
                const mounted = new MutationObserver(() => {
                    const viewport = document.querySelector(".kmodeset-viewport");
                    if (!viewport) return;
                    mounted.disconnect();
                    const observer = new ResizeObserver(entries => {
                        for (const entry of entries) if (rows.length < 128) {
                            rows.push({width:entry.contentRect.width,height:entry.contentRect.height});
                        }
                    });
                    observer.observe(viewport);
                });
                mounted.observe(document, {childList:true,subtree:true});
            });
            try {
                await gotoMachine(page, 'freeciv');
                await expect(page.locator('.kdock-status-text')).toHaveAttribute('data-status', 'running', { timeout: 180000 });
                const demo = page.getByLabel('Computer views').getByRole('button', { name: 'Demo', exact: true });
                if (await demo.getAttribute('aria-current') !== 'true')
                    await demo.click();
                await expect(canvas(page)).toBeVisible();
                await expect(page.getByText(/Waiting for PAGE_FLIP on CRTC/)).toBeHidden({ timeout: 120000 });
                const status = await page.getByText(/\d+×\d+ · \d+ flips/).innerText(), match = /(\d+)×(\d+)/.exec(status)!;
                const mode = { width: Number(match[1]), height: Number(match[2]) };
                const startupViewportReports = await page.evaluate(() => (globalThis as any).__startupViewportReports as Array<{width:number;height:number}>);
                expect(startupViewportReports.length).toBeGreaterThan(0);
                for (const report of startupViewportReports) expect(report).toEqual(startupViewportReports[0]);
                const samples: any[] = [];
                for (const viewport of [{ width: 1280, height: 900 }, { width: 900, height: 740 }, { width: 1440, height: 1000 }]) {
                    await page.setViewportSize(viewport);
                    const surface = canvas(page);
                    // Layout completion, not a timer: the canvas must fit the current host
                    // viewport before its box is used to map input and screenshot pixels.
                    await expect.poll(async () => { const b = await surface.boundingBox(), v = await page.getByRole('region', { name: 'Graphics viewport' }).boundingBox(); if (!b || !v)
                        return Infinity; const fit = Math.min(v.width / mode.width, v.height / mode.height); return Math.max(Math.abs(b.width - mode.width * fit), Math.abs(b.height - mode.height * fit)); }).toBeLessThan(1);
                    const box = (await surface.boundingBox())!;
                    expect(box.width).toBeGreaterThan(0);
                    expect(box.height).toBeGreaterThan(0);
                    const position = (x: number, y: number) => ({ x: x * box.width / mode.width, y: y * box.height / mode.height });
                    const target = position(mode.width * .35, mode.height * .70);
                    await page.mouse.move(box.x + target.x, box.y + target.y);
                    const cursorOrigin = async () => { const png = await page.screenshot({ clip: box, scale: 'css', style: '.kmodeset-canvas,.kdemo-toast {visibility:hidden!important}.kmodeset-canvas-slot{background:#ff00ff!important}' }); return page.evaluate(async (encoded) => { const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/png' })), ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close(); const { width, height, data } = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height); let x = width, y = height; for (let row = 2; row < height - 2; row++)
                        for (let col = 2; col < width - 2; col++) {
                            const i = (row * width + col) * 4;
                            if (data[i] < 250 || data[i + 1] > 5 || data[i + 2] < 250) {
                                x = Math.min(x, col);
                                y = Math.min(y, row);
                            }
                        } return { x, y }; }, png.toString('base64')); };
                    await expect.poll(async () => { const p = await cursorOrigin(); return Math.hypot(p.x - target.x, p.y - target.y); }).toBeLessThan(4);
                    expect(await page.getByRole('region', { name: 'Graphics viewport' }).evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
                    const title = async () => { const p = position(mode.width / 2 - 25, mode.height / 2 - 148), width = Math.min(100 * box.width / mode.width, box.width - p.x); const png = await page.screenshot({ clip: { x: box.x + p.x, y: box.y + p.y, width, height: 1 }, scale: 'css' }); return page.evaluate(async (encoded) => { const b = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/png' })), c = new OffscreenCanvas(b.width, 1).getContext('2d')!; c.drawImage(b, 0, 0); b.close(); const d = c.getImageData(0, 0, c.canvas.width, 1).data; let light = 0; for (let i = 0; i < d.length; i += 4)
                        if (d[i] > 220 && d[i + 1] > 210 && d[i + 2] > 180)
                            light++; return light / (d.length / 4) > .94; }, png.toString('base64')); };
                    await expect.poll(title).toBe(false);
                    await surface.click({ position: position(mode.width - 100, mode.height - 55) });
                    await expect.poll(title).toBe(true);
                    await page.keyboard.press('Escape');
                    await expect.poll(title).toBe(false);
                    samples.push({ viewport, box, target, cursor: await cursorOrigin() });
                    await page.screenshot({ path: testInfo.outputPath('freeciv-' + viewport.width + 'x' + viewport.height + '.png'), scale: 'css' });
                }
                expect(await memoryBoundaryFailures(page)).toEqual([]);
                expect(errors).toEqual([]);
                writeFileSync(testInfo.outputPath('freeciv-viewport-result.json'), JSON.stringify({ density, engine: testInfo.project.name, version: browser.version(), mode, startupViewportReports, samples, scope: 'Real normal SDL client presentation and fitted cursor/menu/viewport functional checks. Headless, not native latency or map/gameplay semantic validation.' }, null, 2));
            }
            catch (error) {
                writeFileSync(testInfo.outputPath('failure.json'), JSON.stringify({ error: String(error instanceof Error ? error.stack : error), errors }, null, 2));
                throw error;
            }
        });
    });
