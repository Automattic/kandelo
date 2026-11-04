import assert from 'node:assert/strict';
import { viewportMarkers } from './viewport-calibration.js';
import type { CursorPose, CursorSource } from './cursor-experiment.js';

/** Passive browser event observation and ordinary pointer moves. This adapter
 * never paints a cursor, changes guest pixels or shortcuts guest input. */
export async function desktopCursorSource(page: any, positions: CursorSource['positions'],
  canvasSelector = '.kmachine-primary-slot:not(.is-hidden) canvas.kmodeset-canvas',
  options: { requireRedCursor?: boolean } = {}): Promise<CursorSource> {
  positions = Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { x: Math.round(p.x), y: Math.round(p.y) }])) as CursorSource['positions'];
  const canvas = page.locator(canvasSelector).first();
  assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), { x: 0, y: 0 }, 'Viewport coordinates require an unscrolled page');
  const before = { viewport: page.viewportSize(), box: await canvas.boundingBox(),
    mode: await page.locator('.kdemo-surface-controls').filter({ hasText: 'flips' }).innerText() };
  assert(before.viewport && before.box);
  for (const point of Object.values(positions)) assert(point.x > before.box.x + 32 && point.x < before.box.x + before.box.width - 32 &&
    point.y > before.box.y + 32 && point.y < before.box.y + before.box.height - 32, 'Cursor calibration must stay inside guest output');
  // The marker and event code is deliberately self-contained in the browser.
  await page.evaluate(`(()=>{const g=globalThis,key='__kandeloDesktopPixelProbe';g[key]?.dispose();
    const p=g[key]={inputs:[],collect:false,errors:[]},positions=${JSON.stringify(positions)},selector=${JSON.stringify(canvasSelector)};
    const observed=document.querySelector(selector);if(!observed)throw Error('Missing guest input canvas');
    p.listener=e=>{if(!p.collect||e.target!==observed)return;const target=Object.keys(positions).find(id=>Math.abs(positions[id].x-e.clientX)<0.6&&Math.abs(positions[id].y-e.clientY)<0.6)??null;
      p.inputs.push({seq:p.inputs.length+1,target,eventAt:e.timeStamp,handlerAt:performance.now(),clientX:e.clientX,clientY:e.clientY,trusted:e.isTrusted,skip:false});};
    addEventListener('pointermove',p.listener,{capture:true,passive:true});
    p.markers=visible=>{for(const e of document.querySelectorAll('[data-desktop-pixel-marker]'))e.remove();if(visible)for(const m of ${JSON.stringify(viewportMarkers(before.viewport.width, before.viewport.height))}){const e=document.createElement('div');e.dataset.desktopPixelMarker='1';e.style.cssText='position:fixed;width:12px;height:12px;z-index:99999;pointer-events:none;left:'+(m.x-6)+'px;top:'+(m.y-6)+'px;background:rgb('+m.rgb.join(',')+')';document.body.append(e);}};
    let serial=0;const pulse=document.createElement('div');pulse.style.cssText='position:fixed;left:4px;top:4px;width:2px;height:2px;z-index:99999;pointer-events:none';document.body.append(pulse);
    p.pulse=()=>{pulse.style.background=++serial%2?'#ac5317':'#1753ac';};
    p.dispose=()=>{removeEventListener('pointermove',p.listener,true);p.markers(false);pulse.remove();};
  })()`);
  // Follow the normal uncaptured absolute-input contract. No Escape reaches
  // the guest. Releasing a lock does not inject or manufacture guest motion.
  await page.evaluate(() => { if (document.pointerLockElement) document.exitPointerLock(); });
  await page.waitForFunction(() => document.pointerLockElement === null);
  const templateEvidence: Record<string, { samples: number; red: number }> = {};
  const source: CursorSource = {
    templateReady: (id, template) => {
      const red = template.points.filter(p => p.rgb[0] >= 180 && p.rgb[1] <= 80 && p.rgb[2] <= 80).length;
      templateEvidence[id] = { samples: template.points.length, red };
      return !options.requireRedCursor || red >= 6;
    },
    positions, patch: { dx: -24, dy: -24, width: 63, height: 63 },
    markers: (visible: boolean) => page.evaluate((v: boolean) => (globalThis as any).__kandeloDesktopPixelProbe.markers(v), visible),
    pulse: () => page.evaluate(() => (globalThis as any).__kandeloDesktopPixelProbe.pulse()),
    pose: async (id: CursorPose) => { await page.mouse.move(positions[id].x, positions[id].y); },
    reset: () => page.evaluate(() => { const p = (globalThis as any).__kandeloDesktopPixelProbe; p.inputs = []; p.collect = true; }),
    trigger: async (id, options) => {
      assert.equal(options.delayMs, 0, 'Guest sources do not implement synthetic stalls');
      const target = options.noOp ? positions.a : positions[id];
      await page.mouse.move(target.x, target.y);
    },
    data: async () => ({ ...await page.evaluate(() => { const p = (globalThis as any).__kandeloDesktopPixelProbe; return { inputs: p.inputs, errors: p.errors }; }), positions, layoutBefore: before, templateEvidence }),
    verify: async () => {
      assert.deepEqual(page.viewportSize(), before.viewport);
      assert.deepEqual(await canvas.boundingBox(), before.box, 'Guest output moved during pointer measurement');
      const chip = await page.locator('.kdemo-surface-controls').filter({ hasText: 'flips' }).innerText();
      assert.equal(chip.match(/\d+×\d+/)?.[0], before.mode.match(/\d+×\d+/)?.[0], 'Guest output mode changed');
      const cursor = await canvas.evaluate((e: HTMLCanvasElement) => getComputedStyle(e).cursor);
      assert.equal(cursor, 'none', 'OS pointer is not a guest-rendered response');
    },
  };
  return source;
}
