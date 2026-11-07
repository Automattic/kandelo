import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance as clock } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { loadavg } from 'node:os';
import assert from 'node:assert/strict';
import { clockBounds, nativeVisibleLatencyBounds, qualifyInjectedDelayBounds, quantile, type ClockSample } from './clock-bounds.js';
import { holdObservation } from './observer-promises.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = process.env.KPERF_NATIVE_METHOD_OUT;
assert(out, 'KPERF_NATIVE_METHOD_OUT must name a private output directory');
const native = join(resolve(out), 'window-capture');
const modules = join(root, 'apps/browser-demos/node_modules');
const pw = await import(pathToFileURL(join(modules, '@playwright/test/index.mjs')).href);
const mode = process.env.KPERF_NATIVE_MODE ?? 'dom';
assert(['dom', 'offscreen'].includes(mode));
assert((process.env.KPERF_NATIVE_ENGINES ?? 'chromium,firefox,webkit').split(',').every(e => ['chromium', 'firefox', 'webkit'].includes(e)), 'Unknown browser engine');
mkdirSync(out, { recursive: true });
let failed = false;
for (const engine of (process.env.KPERF_NATIVE_ENGINES ?? 'chromium,firefox,webkit').split(',') as ('chromium' | 'firefox' | 'webkit')[]) {
  const dir = join(out, engine);
  mkdirSync(dir, { recursive: true });
  let browser: any, server: any, child: ReturnType<typeof spawn> | undefined, stopping = false;
  const rows: any[] = [], waiters: any[] = [];
  let terminalError: Error | undefined;
  let observing = false;
  const receive = (row: any) => {
    row.receivedN = clock.now();
    rows.push(row);
    if (rows.length > 25000)
      throw new Error('Observer capacity exceeded');
    if (row.kind === 'error')
      terminalError = new Error(row.error);
    if (observing && !stopping && ((row.kind === 'sample-status' && [2, 3].includes(row.status)) ||
        (row.kind === 'frame' && row.active !== true))) {
      terminalError = new Error('Display became blank, suspended or inactive; visible measurement is invalid');
    }
    for (const w of waiters.slice())
      if (terminalError || w.predicate(row)) {
        clearTimeout(w.timer);
        waiters.splice(waiters.indexOf(w), 1);
        terminalError ? w.reject(terminalError) : w.resolve(row);
      }
  };
  const wait = (predicate: (row: any) => boolean, after = 0) => {
    if (terminalError)
      return holdObservation(Promise.reject(terminalError));
    const ready = rows.slice(after).find(predicate);
    if (ready)
      return Promise.resolve(ready);
    return holdObservation(new Promise<any>((resolve, reject) => { const w: any = { predicate, resolve, reject }; w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0)
      waiters.splice(i, 1); reject(new Error('Native frame/control timeout')); }, 10000); waiters.push(w); }));
  };
  try {
    const profile = mkdtempSync(join(out, `${engine}-profile-`));
    const env = engine === 'firefox' ? { ...process.env, CFFIXED_USER_HOME: profile } : undefined;
    server = await pw[engine].launchServer({ headless: false, ...(env ? { env } : {}) });
    browser = await pw[engine].connect(server.wsEndpoint());
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const title = `KandeloNativeLatency-${engine}-${randomUUID()}`;
    await page.goto('data:text/html,' + encodeURIComponent(`<title>${title}</title><style>html,body{margin:0;width:100%;height:100%;background:#222222}</style>`));
    await page.bringToFront();
    await page.screenshot({ path: join(dir, 'startup.png') });
    writeFileSync(join(dir, 'page-before.json'), JSON.stringify(await page.evaluate(() => ({ title: document.title, visible: document.visibilityState, hasFocus: document.hasFocus(), width: innerWidth, height: innerHeight, screenX, screenY, outerWidth, outerHeight }))) + '\n');
    if (mode === 'offscreen') {
      const workerSource = `let gl;onmessage=e=>{const m=e.data;if(m.kind==='init'){
  gl=m.canvas.getContext('webgl2',{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true});
  if(!gl)throw new Error('Missing worker WebGL2 context');
  const ext=gl.getExtension('WEBGL_debug_renderer_info');postMessage({kind:'ready',attributes:gl.getContextAttributes(),renderer:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER)});return;}
  if(m.kind==='color'){gl.clearColor(m.rgb[0]/255,m.rgb[1]/255,m.rgb[2]/255,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.flush();
  postMessage({kind:'applied',id:m.id,at:performance.timeOrigin+performance.now()});}};`;
      await page.evaluate(async (source: string) => {
        const g = globalThis as any;
        const canvas = document.createElement('canvas');
        canvas.width = innerWidth;
        canvas.height = innerHeight;
        canvas.style.cssText = 'display:block;width:100vw;height:100vh';
        document.body.appendChild(canvas);
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        let serial = 0;
        const callbacks = new Map<number, (at: number) => void>();
        const ready = new Promise<void>((resolve, reject) => {
          worker.onerror = e => reject(new Error(e.message));
          worker.onmessage = e => { if (e.data.kind === 'ready') {
            g.workerInfo = e.data;
            resolve();
          }
          else {
            const cb = callbacks.get(e.data.id);
            if (cb) {
              callbacks.delete(e.data.id);
              cb(e.data.at - performance.timeOrigin);
            }
          } };
        });
        const offscreen = canvas.transferControlToOffscreen();
        worker.postMessage({ kind: 'init', canvas: offscreen }, [offscreen]);
        await ready;
        g.setControlColor = (rgb: number[]) => new Promise<number>(resolve => { const id = ++serial; callbacks.set(id, resolve); worker.postMessage({ kind: 'color', id, rgb }); });
        await g.setControlColor([34, 34, 34]);
      }, workerSource);
    }
    else
      await page.evaluate(`globalThis.setControlColor=async rgb=>{document.documentElement.style.background='rgb('+rgb.join(',')+')';document.body.style.background='rgb('+rgb.join(',')+')';return performance.now()}`);
    await page.evaluate(`(()=>{const g=globalThis;g.sample=0;g.red=false;g.skip=false;g.delay=0;g.inputs=[];g.frames=[];
   addEventListener('keydown',e=>{if(e.code!=='KeyA')return;const row={seq:++g.sample,eventAt:e.timeStamp,handlerAt:performance.now(),skip:g.skip,delay:g.delay};g.inputs.push(row);
  const until=performance.now()+g.delay;while(performance.now()<until){}if(g.skip)return;
  g.red=!g.red;g.setControlColor(g.red?[255,34,0]:[0,34,255]).then(t=>row.appliedAt=t);});
   function tick(t){g.frames.push(t);requestAnimationFrame(tick)}requestAnimationFrame(tick);})()`);
    const pageCalibrate = async () => { const samples: ClockSample[] = []; for (let i = 0; i < 9; i++) {
      const n0 = clock.now(), b = await page.evaluate(() => performance.now()), n1 = clock.now();
      samples.push({ n0, n1, b });
    } return samples; };
    const pageBefore = await pageCalibrate(), load0 = loadavg();
    const tree = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const owners = new Set<number>([server.process().pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of tree)
        if (owners.has(ppid) && !owners.has(pid)) {
          owners.add(pid);
          changed = true;
        }
    }
    writeFileSync(join(dir, 'owned-browser-pids.json'), JSON.stringify([...owners]) + '\n');
    child = spawn(native, [title, [...owners].join(',')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', b => { stderr += b; if (stderr.length > 1000000)
      child!.kill('SIGTERM'); });
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => { try {
      receive(JSON.parse(line));
    }
    catch (error) {
      terminalError = error as Error;
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(error);
      }
    } });
    const closed = new Promise<number | null>(resolve => child!.once('close', code => { if (!stopping)
      receive({ kind: 'error', error: `Native recorder exited ${code}: ${stderr}` }); resolve(code); }));
    const ready = await wait(r => r.kind === 'ready');
    await page.evaluate(() => (globalThis as any).setControlColor([0, 34, 255]));
    let id = 0;
    const nativeCalibrate = async () => { const samples: ClockSample[] = []; for (let i = 0; i < 9; i++) {
      const key = String(++id), after = rows.length, n0 = clock.now();
      child!.stdin!.write(`ping ${key}\n`);
      const row = await wait(r => r.kind === 'pong' && r.id === key, after);
      samples.push({ n0, n1: row.receivedN, b: row.nativeMs });
    } return samples; };
    const nativeBefore = await nativeCalibrate();
    const color = (r: any) => r.kind === 'frame' ? (r.rgb[0] > 180 && r.rgb[2] < 80 ? 'red' : r.rgb[2] > 180 && r.rgb[0] < 80 ? 'blue' : 'other') : undefined;
    await wait(r => color(r) === 'blue');
    await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    let at = rows.length;
    let response = wait(r => color(r) === 'red', at);
    await page.keyboard.down('a');
    await response;
    await page.keyboard.up('a');
    // The first observed transition warms capture. Suspension before this
    // point is startup evidence; the no-op and timed inputs are guarded.
    observing = true;
    await page.evaluate(() => { (globalThis as any).skip = true; });
    at = rows.length;
    await page.keyboard.down('a');
    await page.keyboard.up('a');
    await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert(!rows.slice(at).some(r => color(r) === 'blue'), 'No-op input fabricated pixel response');
    await page.evaluate(() => { (globalThis as any).skip = false; });
    let red = false;
    const samples: any[] = [];
    for (let index = 0; index < 61; index++) {
      await new Promise(resolve => setTimeout(resolve, [0, 3, 7, 11][index % 4]));
      const delayed = index === 60;
      if (delayed)
        await page.evaluate(() => { (globalThis as any).delay = 50; });
      at = rows.length;
      response = wait(r => color(r) === (red ? 'red' : 'blue'), at);
      await page.keyboard.down('a');
      const visible = await response;
      await page.keyboard.up('a');
      samples.push({ seq: index + 3, delayed, visible });
      red = !red;
    }
    const nativeAfter = await nativeCalibrate(), pageAfter = await pageCalibrate();
    const data = await page.evaluate(() => { const g = globalThis as any; return { inputs: g.inputs, raf: g.frames, timeOrigin: performance.timeOrigin, workerInfo: g.workerInfo ?? null }; });
    assert.equal(data.inputs.length, 63, 'Unexpected input invalidates the controlled sequence');
    stopping = true;
    child.stdin!.write('stop\n');
    const exit = await closed;
    assert.equal(exit, 0, stderr);
    assert(!terminalError, String(terminalError));
    const nc = clockBounds([...nativeBefore, ...nativeAfter], .25), pc = clockBounds([...pageBefore, ...pageAfter], 2);
    const nativeToPage = { lo: pc.lo - nc.hi, hi: pc.hi - nc.lo };
    for (const s of samples) {
      s.input = data.inputs.find((x: any) => x.seq === s.seq);
      assert(s.input);
      const previous = rows.filter(r => r.kind === 'frame' && r.index < s.visible.index
        && color(r) !== color(s.visible)).at(-1);
      s.previousNonResponse = previous ?? null;
      s.displayBounds = nativeVisibleLatencyBounds(s.input.eventAt, previous?.displayMs,
        s.visible.displayMs, nativeToPage);
      s.deliveryUpper = s.visible.receivedMs + nativeToPage.hi - s.input.eventAt;
      assert(s.displayBounds.hi >= 0, 'Frame display time precedes triggering input');
      assert(s.visible.receivedMs >= s.visible.displayMs, 'Frame callback predates display metadata');
    }
    const delayed = samples.at(-1);
    assert(delayed.input.appliedAt - delayed.input.eventAt >= 49);
    assert(delayed.displayBounds.hi >= 49, 'Observer hid delayed input');
    const delayQualification=qualifyInjectedDelayBounds(delayed.displayBounds,50,pc.guardMs+nc.guardMs);
    writeFileSync(join(dir,'delay-calibration.json'),JSON.stringify({qualification:delayQualification,
      originalInput:delayed.input,previousNonResponse:delayed.previousNonResponse,response:delayed.visible,pc,nc},null,2));
    // Sparse/coalesced capture can be correct yet unable to prove this delay.
    // Refuse qualification rather than substitute worker or callback timing.
    assert.equal(delayQualification.status,'qualified','Native delay calibration uncertain: no informative lower visibility bound');
    const regular = samples.filter(s => !s.delayed), frames = rows.filter(r => r.kind === 'frame');
    for (let index = 1; index < frames.length; index++) {
      assert(frames[index].displayMs >= frames[index - 1].displayMs,
        'Out-of-order native frames invalidate color-response correlation');
      assert(frames[index].index > frames[index - 1].index,
        'Duplicate or reordered native frame identity');
    }
    const summary = { engine, mode, version: browser.version(), method: 'Owned window only; native ScreenCaptureKit display metadata and conservative first-visibility intervals allowing capture coalescing; standalone render control', ready, nativeToPage,
      frames: frames.length, samples: regular.length, displayP50: { lo: quantile(regular.map(s => s.displayBounds.lo), .5), hi: quantile(regular.map(s => s.displayBounds.hi), .5) },
      displayP95: { lo: quantile(regular.map(s => s.displayBounds.lo), .95), hi: quantile(regular.map(s => s.displayBounds.hi), .95) },
      deliveryUpperP50: quantile(regular.map(s => s.deliveryUpper), .5), deliveryUpperP95: quantile(regular.map(s => s.deliveryUpper), .95),
      callbackDelayP50: quantile(frames.map(r => r.receivedMs - r.displayMs), .5), callbackDelayP95: quantile(frames.map(r => r.receivedMs - r.displayMs), .95),
      delayedControl: delayed.displayBounds, load0, load1: loadavg() };
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ summary, pageBefore, pageAfter, nativeBefore, nativeAfter, pc, nc, ...data, rows, samples }, null, 2) + '\n');
    writeFileSync(join(dir, 'native-stderr.log'), stderr);
    console.log(JSON.stringify(summary));
    await context.close();
  }
  catch (error) {
    failed = true;
    writeFileSync(join(dir, 'error.txt'), String((error as Error).stack ?? error) + '\n');
    console.log(engine, String(error));
  }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      stopping = true;
      child.stdin!.write('stop\n');
      await new Promise(resolve => child!.once('close', resolve));
    }
    if (browser)
      await browser.close();
    if (server)
      await server.close();
    for (const w of waiters.splice(0))
      clearTimeout(w.timer);
    writeFileSync(join(dir, 'native-rows.json'), JSON.stringify(rows, null, 2) + '\n');
  }
}
if (failed)
  process.exitCode = 1;
