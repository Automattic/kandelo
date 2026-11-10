import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { ObservationRows, type WindowObserver } from './native-observer-client.js';
import { screenshotRaster } from './captured-raster.js';

// Exercises the SAME control/calibration flow without operating the desktop.
// The window border and timestamps here are synthetic, never native timing.
export class HeadlessWindowObserver implements WindowObserver {
  // This budget covers screenshot transport and decoding, not display latency.
  // The native observer retains its independent ten-second response deadline.
  readonly stream = new ObservationRows(30_000);
  private configuration: any;
  private decision: any;
  private snapshots: string[] = [];
  private snapshotIds = new Set<string>();
  private index = 0;
  constructor(private page: any, private binary: string, private decisionMode = false) {
    this.stream.receive({ kind: 'ready', native: false, syntheticGeometry: true });
  }
  command(line: string) {
    this.stream.check();
    try {
    if (line.startsWith('decision ')) {
      assert(this.decisionMode);this.decision=JSON.parse(line.slice(9));this.configuration=undefined;this.stream.receive({kind:'decision-configured',tag:this.decision.tag});
    } else if (line.startsWith('matcher ')) {
      assert(!this.decisionMode,'Legacy sparse matcher is incompatible with response-roi mode');
      this.configuration = JSON.parse(line.slice(8));this.decision=undefined;
      this.stream.receive({ kind: 'matcher-configured', tag: this.configuration.tag });
    } else if (line.startsWith('pixels ')) {
      const id = line.slice(7);
      assert(id && id.length <= 128 && this.snapshots.length < 4 && this.snapshotIds.size < 16 && !this.snapshotIds.has(id));
      this.snapshotIds.add(id); this.snapshots.push(id);
    } else if (line === 'matcher-clear') {this.configuration = undefined;this.decision=undefined;}
    else throw new Error('Unknown headless observer command');
    } catch(error) {this.stream.fail(error as Error);throw error;}
  }
  async flush() {
    try {
      // Replay pumps captured frames while a response is outstanding. Keep
      // intermediate/missing matches; no source acknowledgement ends a wait.
      const waiting = this.stream.pendingCount > 0;
      do {
      await this.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const viewport = this.page.viewportSize();
      assert(viewport, 'A fixed viewport is required for replay');
      const scale=this.decisionMode?1:.75;
      const mapping = { x: { scale, offset: 7 }, y: { scale, offset: 53 } } as any;
      const acquisitionStartN = performance.now();
      let raster;
      try {
        raster = await screenshotRaster(this.page, undefined, { width: Math.round(viewport.width * scale) + 16, height: Math.round(viewport.height * scale) + 64, mapping });
      } finally {
        const acquisitionEndN = performance.now();
        this.stream.receive({ kind: 'headless-acquisition', acquisitionStartN, acquisitionEndN,
          durationMs: acquisitionEndN - acquisitionStartN, completed: !!raster, native: false });
      }
      const bgra = Buffer.from(raster.bgra).toString('base64');
      const now = performance.now();
      const frame: any = { kind: 'frame', index: ++this.index, displayMs: now, receivedMs: now,
        width: raster.width, height: raster.height, active: true, native: false };
      if (this.configuration) frame.pixelMatch = JSON.parse(execFileSync(this.binary, [], {
        input: JSON.stringify({ configuration: this.configuration, ...raster, bgra }) + '\n',
        encoding: 'utf8', maxBuffer: 1_000_000,
      }));
      if(this.decision)frame.decisionMatch=JSON.parse(execFileSync(this.binary,[],{
        input:JSON.stringify({decision:this.decision,...raster,bgra})+'\n',encoding:'utf8',maxBuffer:1_000_000}));
      this.stream.receive(frame);
      for (const id of this.snapshots.splice(0)) this.stream.receive({ ...frame, ...raster, kind: 'pixels', id, bgra });
      } while (waiting && this.stream.pendingCount > 0);
    } catch (error) { this.stream.fail(error as Error); throw error; }
  }
  async calibrate() { return Array.from({ length: 9 }, () => { const n0 = performance.now(); return { n0, n1: n0, b: n0 }; }); }
  async close() { this.stream.check(); this.stream.dispose(); }
}
