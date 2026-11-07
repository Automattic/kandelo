import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { learnPixelTemplate, type WindowRaster, type PixelTemplate } from './pixel-template.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = process.env.KPERF_PIXEL_CONTROL_OUT;
assert(out, 'A private KPERF_PIXEL_CONTROL_OUT directory is required');
const binary = join(resolve(out), 'pixel-matcher-offline');
const pw = await import(pathToFileURL(join(root, 'apps/browser-demos/node_modules/@playwright/test/index.mjs')).href);
const positions = [{ x: 40, y: 50 }, { x: 90, y: 50 }, { x: 140, y: 50 },
  { x: 40, y: 120 }, { x: 90, y: 120 }, { x: 140, y: 120 }];
const workerSource = `let gl,program,location;onmessage=e=>{try{const m=e.data;if(m.kind==='init'){
 gl=m.canvas.getContext('webgl2',{antialias:false,premultipliedAlpha:false,preserveDrawingBuffer:true});
 if(!gl)throw Error('WebGL2 unavailable in offline pixel control');
 const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader};
 program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,'#version 300 es\\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}'));
 gl.attachShader(program,compile(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float;uniform vec4 poses;uniform bool twin;uniform bool wrong;out vec4 color;bool arrow(vec2 p){return p.x>=0.0&&p.y>=0.0&&p.x<12.0&&p.y<18.0&&p.x<=floor(p.y*0.65)&&!(p.y>12.0&&p.x<4.0);}void main(){vec2 p=vec2(gl_FragCoord.x,240.0-gl_FragCoord.y);bool a=arrow(floor(p-poses.xy))||(twin&&arrow(floor(p-poses.zw)));color=a?(wrong?vec4(0.0,1.0,0.0,1.0):vec4(1.0,0.1,0.05,1.0)):vec4(34.0/255.0,51.0/255.0,68.0/255.0,1.0);}'));
 gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
 location=gl.getUniformLocation(program,'poses');postMessage({kind:'ready'});return;}
 gl.uniform4f(location,m.x,m.y,m.x2??0,m.y2??0);gl.uniform1i(gl.getUniformLocation(program,'twin'),m.twin?1:0);gl.uniform1i(gl.getUniformLocation(program,'wrong'),m.wrong?1:0);gl.drawArrays(gl.TRIANGLES,0,3);gl.flush();postMessage({kind:'applied',id:m.id});}catch(e){postMessage({kind:'error',error:String(e)})}};`;

let assertions = 0;
for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
  // Match the browser gate's macOS test-profile isolation. This is test
  // launcher setup, as documented in apps/browser-demos/playwright.config.ts.
  const profile = engine === 'firefox' && process.platform === 'darwin'
    ? mkdtempSync(join(out, 'firefox-home-')) : undefined;
  const browser = await pw[engine].launch({ headless: true,
    ...(engine === 'chromium' ? { channel: 'chromium' } : {}),
    ...(profile ? { env: { ...process.env, CFFIXED_USER_HOME: profile } } : {}) });
  try {
    for (const mode of ['dom', 'offscreen']) {
      const dir = join(out, engine, mode);
      mkdirSync(dir, { recursive: true });
      const context = await browser.newContext({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (e: Error) => pageErrors.push(e.message));
        await page.goto('data:text/html,' + encodeURIComponent('<title>Offline pixel matcher control</title><style>html,body{margin:0;background:rgb(34,51,68);overflow:hidden}.cursor{position:absolute;width:12px;height:18px;clip-path:polygon(0 0,12px 18px,4px 18px,4px 12px,0 12px);background:rgb(255,26,13)}</style>'));
        if (mode === 'dom') {
          await page.evaluate(() => {
            const first = document.createElement('div'), second = document.createElement('div');
            first.className = second.className = 'cursor';
            document.body.append(first, second);
            (globalThis as any).pose = async (p: any) => {
              first.style.left = `${p.x}px`; first.style.top = `${p.y}px`;
              first.style.background = p.wrong ? 'rgb(0,255,0)' : 'rgb(255,26,13)';
              second.style.left = `${p.x2}px`; second.style.top = `${p.y2}px`;
              second.style.display = p.twin ? 'block' : 'none';
            };
          });
        } else {
          await page.evaluate(async (source: string) => {
            const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
            document.body.append(canvas);
            const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
            let readyResolve!: () => void, readyReject!: (e: Error) => void, serial = 0;
            const ready = new Promise<void>((r, j) => { readyResolve = r; readyReject = j; });
            const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
            const callbacks = { fail(e: Error) { readyReject(e); for (const p of pending.values()) p.reject(e); pending.clear(); } };
            worker.onerror = e => callbacks.fail(new Error(e.message));
            worker.onmessage = e => {
              if (e.data.kind === 'error') { callbacks.fail(new Error(e.data.error)); return; }
              if (e.data.kind === 'ready') { readyResolve(); return; }
              pending.get(e.data.id)?.resolve(); pending.delete(e.data.id);
            };
            const offscreen = canvas.transferControlToOffscreen();
            worker.postMessage({ kind: 'init', canvas: offscreen }, [offscreen]); await ready;
            (globalThis as any).pose = (p: any) => new Promise<void>((resolve, reject) => {
              const id = ++serial; pending.set(id, { resolve, reject }); worker.postMessage({ kind: 'pose', id, ...p });
            });
          }, workerSource);
        }
        const raster = async (name: string, pose: any): Promise<WindowRaster> => {
          await page.evaluate((p: any) => (globalThis as any).pose(p), pose);
          // A worker acknowledgement is not a displayed-frame endpoint. This
          // is untimed calibration setup; advance compositor frames before
          // capturing it. Native timing must still wait for matching pixels.
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const png = await page.screenshot({ path: join(dir, `${name}.png`) });
          // Decode the captured PNG, rather than reading the live drawing canvas.
          const decoded = await page.evaluate(async (bytes: number[]) => {
            const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); image.close();
            const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < rgba.length; i += 4) { const r = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = r; }
            return { width: canvas.width, height: canvas.height, stride: canvas.width * 4, bgra: Array.from(rgba) };
          }, Array.from(png));
          return { ...decoded, bgra: new Uint8Array(decoded.bgra) };
        };
        const background = await raster('background', { x: 240, y: 180 });
        const frames: WindowRaster[] = [];
        for (const [i, position] of positions.entries()) frames.push(await raster(`pose-${i}`, position));
        const template = learnPixelTemplate(background, frames[0], { ...positions[0], width: 12, height: 18 });
        assert.throws(() => learnPixelTemplate(background, background, { ...positions[0], width: 12, height: 18 }), /insufficient changed pixels/); assertions++;
        assert.throws(() => learnPixelTemplate(background, { ...frames[0], bgra: frames[0].bgra.subarray(4) }, { ...positions[0], width: 12, height: 18 }), /raster/); assertions++;
        const configuration = { tag: `${engine}-${mode}`, template,
          candidates: positions.map((p, i): { id: string; x: number; y: number; template?: PixelTemplate } => ({ id: String(i), ...p })),
          searchRadius: 1, maxChannelError: 16, maxMeanError: 4 };
        const request = (frame: WindowRaster, config = configuration) => ({ configuration: config,
          ...frame, bgra: Buffer.from(frame.bgra).toString('base64') });
        // Calibration scale slightly above1 maps the63 CSS-pixel patch to65
        // raster pixels; a2x capture needs up to128. Both implementations
        // must accept those bounded regions and retain the sparse-point cap.
        const wideResults = [];
        for (const width of [65, 128]) {
          const wide = learnPixelTemplate(background, frames[0], { ...positions[0], width, height: 128 });
          assert(wide.points.length <= 256); assertions++;
          const config = { ...configuration, template: wide, candidates: [configuration.candidates[0]] };
          const result = JSON.parse(execFileSync(binary, [], {
            input: JSON.stringify(request(frames[0], config)) + '\n', encoding: 'utf8',
          }));
          assert.equal(result.state, 'matched'); assert.equal(result.matches[0].id, '0'); assertions += 2;
          wideResults.push({ width, points: wide.points.length, result });
        }
        assert.throws(() => learnPixelTemplate(background, frames[0], { ...positions[0], width: 129, height: 128 })); assertions++;
        const wrong = await raster('wrong-color', { ...positions[2], wrong: true });
        const green = learnPixelTemplate(background, wrong, { ...positions[2], width: 12, height: 18 });
        const override = { ...configuration, candidates: configuration.candidates.map(c => c.id === '2' ? { ...c, template: green } : c) };
        const twin = await raster('ambiguous', { ...positions[1], twin: true, x2: positions[4].x, y2: positions[4].y });
        const padded = { ...frames[3], stride: frames[3].stride + 16, bgra: new Uint8Array((frames[3].stride + 16) * frames[3].height).fill(0xa5) };
        for (let y = 0; y < padded.height; y++) padded.bgra.set(frames[3].bgra.subarray(y * frames[3].stride, (y + 1) * frames[3].stride), y * padded.stride);
        const requests = [request(background), ...frames.map(f => request(f)), request(wrong), request(twin), request(padded), request(frames[0]), request(wrong, override)];
        const input = requests.map(r => JSON.stringify(r)).join('\n') + '\n';
        const output = execFileSync(binary, [], { input, encoding: 'utf8', maxBuffer: 1_000_000 });
        const results = output.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(results.length, requests.length); assertions++;
        assert.equal(results[0].state, 'unmatched'); assertions++;
        for (const [i] of positions.entries()) {
          assert.equal(results[i + 1].state, 'matched');
          assert.equal(results[i + 1].matches[0].id, String(i));
          assert.equal(results[i + 1].matches[0].x, positions[i].x);
          assert.equal(results[i + 1].matches[0].y, positions[i].y);
          assertions += 4;
        }
        assert.equal(results[7].state, 'unmatched'); assertions++;
        assert.equal(results[8].state, 'ambiguous');
        assert.deepEqual(results[8].matches.map((m: any) => m.id), ['1', '4']); assertions += 2;
        assert.equal(results[9].state, 'matched'); assert.equal(results[9].matches[0].id, '3'); assertions += 2;
        // Replaying an old/no-op raster cannot claim that target 5 appeared.
        assert.equal(results[10].matches[0].id, '0'); assert(!results[10].matches.some((m: any) => m.id === '5')); assertions += 2;
        assert.equal(results[11].state, 'matched'); assert.equal(results[11].matches[0].id, '2'); assertions += 2;
        const budgetTemplate: PixelTemplate = { width: 16, height: 16, points: Array.from({ length: 256 }, (_, i) => ({ x: i % 16, y: Math.floor(i / 16), rgb: [0, 0, 0] })) };
        const negatives = [
          request(frames[0], { ...configuration, candidates: [{ id: 'bad', x: 319, y: 239 }] }),
          request(frames[0], { ...configuration, candidates: [configuration.candidates[0], configuration.candidates[0]] }),
          { ...request(frames[0]), bgra: Buffer.from(frames[0].bgra.subarray(4)).toString('base64') },
          request(frames[0], { ...configuration, searchRadius: 3 }),
          request(frames[0], { ...configuration, searchRadius: 2, candidates: Array.from({ length: 128 }, (_, i) => ({ id: String(i), x: i + 2, y: 50 })) }),
          request(frames[0], { ...configuration, candidates: [{ ...configuration.candidates[0], template: { ...template, width: 129 } }] }),
          request(frames[0], { ...configuration, template: { ...template, points: template.points.slice(0, 6) }, searchRadius: 2,
            candidates: Array.from({ length: 128 }, (_, i) => ({ id: String(i), x: i + 2, y: 50, template: budgetTemplate })) }),
        ];
        for (const [i, negative] of negatives.entries()) {
          const result = spawnSync(binary, [], { input: JSON.stringify(negative) + '\n', encoding: 'utf8' });
          writeFileSync(join(dir, `negative-${i}.json`), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
          assert.equal(result.status, 2); assert.match(result.stderr, /offline matcher failure:/); assert.equal(result.stdout, ''); assertions += 3;
        }
        assert.deepEqual(pageErrors, []); assertions++;
        writeFileSync(join(dir, 'result.json'), JSON.stringify({ engine, mode, version: browser.version(),
          scope: 'Headless rendered-pixel classification only; no native display timing or instrumentation-overhead claim',
          configuration, overrideConfiguration: override, results, wideResults, assertions, negatives: negatives.length }, null, 2));
        console.log(JSON.stringify({ engine, mode, version: browser.version(), results: results.length, negatives: negatives.length, assertions }));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
console.log(`PASS pixel matcher controls (${assertions} assertions; six engine/render-mode cohorts)`);
