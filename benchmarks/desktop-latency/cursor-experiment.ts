import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOriginalInputEvidence} from './original-input-evidence.js';
import {preserveInteractionEvidence,observeInteractionSource} from './interaction-evidence-custody.js';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { clockBounds, nativeVisibleLatencyBounds, qualifyInjectedDelayBounds, quantile, type ClockSample } from './clock-bounds.js';
import { learnPixelTemplate } from './pixel-template.js';
import { calibrateViewport, viewportMarkers, mapViewportPoint } from './viewport-calibration.js';
import { snapshotRaster } from './captured-raster.js';
import type { WindowObserver } from './native-observer-client.js';

export type CursorPose = 'a' | 'b' | 'c';
export interface CursorInput {
  seq: number; target: string | null; eventAt: number; skip?: boolean;
  beforeDrawAt?: number;
  [key: string]: unknown;
}
export interface CursorSource {
  positions: Record<CursorPose, { x: number; y: number }>;
  patch: { dx: number; dy: number; width: number; height: number };
  markers(visible: boolean): Promise<void>;
  pulse(): Promise<void>;
  pose(id: CursorPose): Promise<void>;
  reset(): Promise<void>;
  trigger(id: CursorPose, options: { noOp: boolean; delayMs: number }): Promise<void>;
  data(): Promise<{ inputs: CursorInput[]; errors: string[]; [key: string]: unknown }>;
  verify(): Promise<void>;
  templateReady?(id: CursorPose, template: ReturnType<typeof learnPixelTemplate>): boolean;
}
class CursorCalibrationPending extends Error {}

/** One shared calibration/correlation path for standalone controls and real
 * desktop sources. Only native observations can supply native timing. */
type CursorExperimentOptions = {
  page: any; observer: WindowObserver; source: CursorSource; out: string;
  count: number; native: boolean; injectStall: boolean; label: string;
};
export async function measureCursorExperiment(options: CursorExperimentOptions) {
  const offered=createOriginalInputEvidence({session:'offered-'+randomUUID()});
  let completedSource: Awaited<ReturnType<CursorSource['data']>> | undefined;
  let sourceAttempted=false,sourceFailure:unknown;
  const budget=options.observer.stream.defaultTimeoutMs;
  const local=()=>({clock:'node-monotonic',ledger:offered.snapshot()});
  let evidenceRecord=0;
  const persist=(record:Record<string,unknown>)=>{
    const bytes=JSON.stringify(record,null,2);
    // Never overwrite the first durable offers/source observation while
    // replacing the convenience final record. Disk failure remains fatal.
    writeFileSync(join(options.out,'original-input-evidence-'+(++evidenceRecord)+'-'+record.phase+'.json'),bytes);
    writeFileSync(join(options.out,record.phase==='local-captured'?'original-input-evidence-local.json':'original-input-evidence.json'),bytes);
  };
  const readSource=async()=>{
    persist({phase:'local-captured',operationStatus:'running',localEvidence:local(),sourceStatus:'pending',evidenceAvailable:false});
    sourceAttempted=true;
    const observation=await observeInteractionSource(()=>options.source.data(),budget);
    if(observation.status==='available')completedSource=observation.value as Awaited<ReturnType<CursorSource['data']>>;
    else sourceFailure=observation.error;
    persist({phase:'source-observed',operationStatus:'running',localEvidence:local(),sourceStatus:observation.status,
      sourceEvidence:observation.status==='available'?observation.value:undefined,evidenceAvailable:observation.status==='available'});
    if(observation.status!=='available')throw observation.error;
    return completedSource!;
  };
  return preserveInteractionEvidence(async()=>runCursorExperiment(options,id=>{
    if(!offered.offer({id,kind:'cursor-stimulus',offeredAt:performance.now()}))
      throw Error('Offered-input evidence capacity/identity failure');
  },readSource),local,()=>completedSource?Promise.resolve(completedSource):sourceAttempted?Promise.reject(sourceFailure):options.source.data(),persist,budget);
}
async function runCursorExperiment(options: CursorExperimentOptions,offer:(id:string)=>void,
  readSource:()=>Promise<Awaited<ReturnType<CursorSource['data']>>>) {
  const { page, observer, source, out, count, native, injectStall, label } = options;
  assert(Number.isInteger(count) && count >= 4 && count <= 120);
  const initialViewport = page.viewportSize(); assert(initialViewport);
  const viewport = { ...initialViewport };
  const stream = observer.stream;
  const ready = await stream.wait(r => r.kind === 'ready');
  const pageCalibrate = async () => {
    const samples: ClockSample[] = [];
    for (let i = 0; i < 9; i++) {
      const n0 = performance.now(), b = await page.evaluate(() => performance.now()), n1 = performance.now();
      samples.push({ n0, n1, b });
    }
    return samples;
  };
  const pageBefore = await pageCalibrate(), nativeBefore = await observer.calibrate();
  const settle = async () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const snapshot = async (id: string) => {
    const pending = stream.wait(r => r.kind === 'pixels' && r.id === id, stream.rows.length);
    observer.command(`pixels ${id}`); await source.pulse(); await observer.flush(); return pending;
  };
  await source.markers(true); await settle();
  const markerRow = await snapshot('geometry');
  const markers = viewportMarkers(viewport.width, viewport.height);
  writeFileSync(join(out, 'geometry-input.json'), JSON.stringify({ viewport,
    viewportAfterCapture: page.viewportSize(), markers, index: markerRow.index }, null, 2));
  assert.deepEqual(page.viewportSize(), viewport, 'Viewport changed during geometry capture');
  const geometry = calibrateViewport(snapshotRaster(markerRow), markers);
  if (!native) {
    assert(Math.abs(geometry.x.scale - .75) < .003 && Math.abs(geometry.y.scale - .75) < .003);
    assert(Math.abs(geometry.x.offset - 7) <= 1 && Math.abs(geometry.y.offset - 53) <= 1);
    assert.throws(() => calibrateViewport({ ...snapshotRaster(markerRow), bgra: new Uint8Array(markerRow.stride * markerRow.height) },
      viewportMarkers(viewport.width, viewport.height)), /marker/);
  }
  writeFileSync(join(out, 'geometry.json'), JSON.stringify({ geometry, viewport, captureWidth: markerRow.width, captureHeight: markerRow.height }, null, 2));
  await source.markers(false); await settle();
  const origin = (id: CursorPose) => mapViewportPoint(geometry, {
    x: source.positions[id].x + source.patch.dx, y: source.positions[id].y + source.patch.dy });
  const rect = { ...origin('a'), width: Math.ceil(source.patch.width * geometry.x.scale) + 1,
    height: Math.ceil(source.patch.height * geometry.y.scale) + 1 };
  // A source acknowledgement and the next complete capture can precede the
  // guest's redraw. Qualify calibration by actual changed pixels, retaining
  // every intermediate attempt. Final identities still need fresh validation.
  await source.pose('c'); await settle();
  const background = snapshotRaster(await snapshot('background-reference'));
  const captured = {} as Record<CursorPose, ReturnType<typeof snapshotRaster>>;
  const calibrationAttempts: { id: CursorPose; attempt: number; index: number; accepted: boolean; reason?: string }[] = [];
  const candidates: { id: CursorPose; x: number; y: number; template: ReturnType<typeof learnPixelTemplate> }[] = [];
  for (const id of ['a', 'b', 'c'] as const) {
    await source.pose(id); await settle();
    // Native calibration already retains WindowServer rasters. Use that
    // observation path alone, keeping extra DevTools capture activity out
    // of the visible input/presentation experiment.
    if (!native) await page.screenshot({ path: join(out, `setup-${id}.png`) });
    const reference = id === 'a' ? background : captured.a;
    let accepted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await settle();
      const row = await snapshot(`candidate-${id}-${attempt}`);
      const raster = snapshotRaster(row);
      try {
        const template = learnPixelTemplate(reference, raster, { ...rect, ...origin(id) });
        if (source.templateReady && !source.templateReady(id, template))
          throw new CursorCalibrationPending('Expected cursor appearance is not ready');
        calibrationAttempts.push({ id, attempt, index: row.index, accepted: true });
        writeFileSync(join(out, 'calibration-attempts.json'), JSON.stringify(calibrationAttempts));
        captured[id] = raster; candidates.push({ id, ...origin(id), template }); accepted = true; break;
      } catch (error) {
        calibrationAttempts.push({ id, attempt, index: row.index, accepted: false, reason: String(error) });
        writeFileSync(join(out, 'calibration-attempts.json'), JSON.stringify(calibrationAttempts));
        const notReady = error instanceof CursorCalibrationPending ||
          (error instanceof assert.AssertionError && error.message.includes('insufficient changed pixels'));
        if (!notReady) throw error;
        if (attempt === 2) throw error;
      }
    }
    assert(accepted, 'No changed cursor pixels in bounded calibration attempts');
  }
  // Each pose can have different rasterization coverage at fractional capture
  // scales. Calibrate that coverage once, then validate in independent frames.
  const config = { tag: `${label}-${Date.now()}`, template: candidates[0].template, candidates,
    searchRadius: 1, maxChannelError: 48, maxMeanError: 12 };
  const configured = stream.wait(r => r.kind === 'matcher-configured' && r.tag === config.tag, stream.rows.length);
  observer.command(`matcher ${JSON.stringify(config)}`); await configured;
  const matched = (id: CursorPose, after: number) => stream.wait(r => r.kind === 'frame' && r.pixelMatch?.tag === config.tag &&
    r.pixelMatch.state === 'matched' && r.pixelMatch.matches[0].id === id, after);
  const pose = async (id: CursorPose) => {
    const pending = matched(id, stream.rows.length);
    await source.pose(id); await observer.flush(); return pending;
  };
  for (const id of ['a', 'b', 'c'] as const) {
    await pose(id);
    const row = await snapshot(`confirmed-${id}`);
    const frame = stream.rows.find(r => r.kind === 'frame' && r.index === row.index);
    assert.equal(frame?.pixelMatch?.tag, config.tag);
    assert.equal(frame.pixelMatch.state, 'matched'); assert.equal(frame.pixelMatch.matches[0].id, id);
  }
  writeFileSync(join(out, 'configuration.json'), JSON.stringify(config, null, 2));
  console.log(JSON.stringify({ label, native, phase: 'calibration-verified' }));
  await pose('a'); stream.arm(); await source.reset();
  const noopStart = stream.rows.length;
  offer('no-op');
  await source.trigger('b', { noOp: true, delayMs: 0 });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  const noop = matched('a', stream.rows.length); await source.pulse(); await observer.flush(); await noop;
  assert(!stream.rows.slice(noopStart).some(r => r.pixelMatch?.tag === config.tag && r.pixelMatch.matches.some((m: any) => m.id === 'b')),
    'No-op input fabricated target pixels');
  const samples: any[] = [];
  const total = count + (injectStall ? 1 : 0);
  for (let i = 0; i < total; i++) {
    const target = i % 2 ? 'a' : 'b', delayed = injectStall && i === count;
    const phaseMs = [0, 3, 7, 11][i % 4];
    await new Promise(resolve => setTimeout(resolve, phaseMs));
    const pending = matched(target, stream.rows.length);
    offer('response-'+(i+2));
    await source.trigger(target, { noOp: false, delayMs: delayed ? 50 : 0 }); await observer.flush();
    samples.push({ seq: i + 2, target, delayed, phaseMs, visible: await pending });
    if (!native && i % 10 === 9) console.log(JSON.stringify({ label, native, responses: i + 1 }));
  }
  const nativeAfter = await observer.calibrate(), pageAfter = await pageCalibrate();
  const data = await readSource();
  assert.equal(data.inputs.length, total + 1, 'Unplanned or missing source input'); assert.deepEqual(data.errors, []);
  await source.verify();
  const nc = clockBounds([...nativeBefore, ...nativeAfter], .25), pc = clockBounds([...pageBefore, ...pageAfter], 2);
  const nativeToPage = { lo: pc.lo - nc.hi, hi: pc.hi - nc.lo };
  const frames = stream.rows.filter(r => r.kind === 'frame' && r.pixelMatch?.tag === config.tag);
  for (const sample of samples) {
    sample.input = data.inputs.find(r => r.seq === sample.seq);
    assert(sample.input && sample.input.target === sample.target && !sample.input.skip);
    const previous = frames.filter(r => r.index < sample.visible.index && r.pixelMatch.state === 'matched' &&
      r.pixelMatch.matches[0].id !== sample.target).at(-1);
    sample.previousNonResponse = previous ?? null;
    sample.displayBounds = nativeVisibleLatencyBounds(sample.input.eventAt, previous?.displayMs, sample.visible.displayMs, nativeToPage);
  }
  const delayed = injectStall ? samples.at(-1) : undefined;
  if (delayed) {
    // Keep the worker's epoch-converted value as non-authoritative diagnostic
    // data. Its local busy interval proves injection; original-input/native
    // display bounds below independently remain the end-to-end oracle.
    assert(delayed.input.injectedDelayMs >= 50, 'Control did not inject its promised same-clock stall');
    assert(delayed.displayBounds.hi >= 49, 'Pixel observer hid the known stall');
    if(native){
      const qualification=qualifyInjectedDelayBounds(delayed.displayBounds,50,pc.guardMs+nc.guardMs);
      writeFileSync(join(out,'delay-calibration.json'),JSON.stringify({qualification,input:delayed.input,
        bounds:delayed.displayBounds,previousNonResponse:delayed.previousNonResponse,response:delayed.visible,pc,nc},null,2));
      assert.equal(qualification.status,'qualified',
        'Native delay calibration uncertain: captured lower bound does not prove injected delay within existing clock tolerance');
    }
  }
  const regular = samples.filter(s => !s.delayed);
  const summary: any = { label, native, responses: regular.length, delayedResponses: injectStall ? 1 : 0,
    scope: native ? 'Owned-window pixel observation; workload and overhead validation still required' : 'Headless pixel replay with synthetic geometry/timestamps; NOT native timing',
    noOp: 'pass', geometry, ambiguousFrames: frames.filter(r => r.pixelMatch.state === 'ambiguous').length,
    unmatchedFrames: frames.filter(r => r.pixelMatch.state === 'unmatched').length };
  if (!native) {
    const captures = stream.rows.filter(r => r.kind === 'headless-acquisition');
    summary.headlessAcquisition = { count: captures.length,
      maximumMs: Math.max(...captures.map(r => r.durationMs)),
      over50Ms: captures.filter(r => r.durationMs > 50).length,
      over1000Ms: captures.filter(r => r.durationMs > 1000).length,
      scope: 'Screenshot transport and decoding only; not guest or native display latency' };
  }
  if (native) {
    summary.displayP50 = { lo: quantile(regular.map(s => s.displayBounds.lo), .5), hi: quantile(regular.map(s => s.displayBounds.hi), .5) };
    summary.displayP95 = { lo: quantile(regular.map(s => s.displayBounds.lo), .95), hi: quantile(regular.map(s => s.displayBounds.hi), .95) };
    if (delayed) summary.delayedControl = delayed.displayBounds;
    summary.matcherMsP95 = quantile(frames.map(r => r.matcherMs), .95);
  }
  stream.check();
  return { summary, ready, nativeBefore, nativeAfter, pageBefore, pageAfter, nc, pc, nativeToPage, samples, calibrationAttempts, ...data };
}
