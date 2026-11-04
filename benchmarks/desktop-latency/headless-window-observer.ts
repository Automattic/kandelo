import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { ObservationRows, type WindowObserver } from './native-observer-client.js';
import { screenshotRaster } from './captured-raster.js';

// Exercises the SAME control/calibration flow without operating the desktop.
// The window border and timestamps here are synthetic, never native timing.
export class HeadlessWindowObserver implements WindowObserver {
  readonly stream = new ObservationRows();
  private configuration: any;
  private snapshots: string[] = [];
  private snapshotIds = new Set<string>();
  private index = 0;
  constructor(private page: any, private binary: string) {
    this.stream.receive({ kind: 'ready', native: false, syntheticGeometry: true });
  }
  command(line: string) {
    this.stream.check();
    if (line.startsWith('matcher ')) {
      this.configuration = JSON.parse(line.slice(8));
      this.stream.receive({ kind: 'matcher-configured', tag: this.configuration.tag });
    } else if (line.startsWith('pixels ')) {
      const id = line.slice(7);
      assert(id && id.length <= 128 && this.snapshots.length < 4 && this.snapshotIds.size < 16 && !this.snapshotIds.has(id));
      this.snapshotIds.add(id); this.snapshots.push(id);
    } else if (line === 'matcher-clear') this.configuration = undefined;
    else throw new Error('Unknown headless observer command');
  }
  async flush() {
    try {
      // Replay has no autonomous native frame stream. Drain submitted work
      // before asking for its next captured pixels. This is NOT used by the
      // native adapter, whose response still requires WindowServer evidence.
      await this.page.evaluate(() => (globalThis as any).whenIdle());
      await this.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const mapping = { x: { scale: .75, offset: 7 }, y: { scale: .75, offset: 53 } } as any;
      const raster = await screenshotRaster(this.page, undefined, { width: 616, height: 514, mapping });
      const bgra = Buffer.from(raster.bgra).toString('base64');
      const now = performance.now();
      const frame: any = { kind: 'frame', index: ++this.index, displayMs: now, receivedMs: now,
        width: raster.width, height: raster.height, active: true, native: false };
      if (this.configuration) frame.pixelMatch = JSON.parse(execFileSync(this.binary, [], {
        input: JSON.stringify({ configuration: this.configuration, ...raster, bgra }) + '\n',
        encoding: 'utf8', maxBuffer: 1_000_000,
      }));
      this.stream.receive(frame);
      for (const id of this.snapshots.splice(0)) this.stream.receive({ ...frame, ...raster, kind: 'pixels', id, bgra });
    } catch (error) { this.stream.fail(error as Error); throw error; }
  }
  async calibrate() { return Array.from({ length: 9 }, () => { const n0 = performance.now(); return { n0, n1: n0, b: n0 }; }); }
  async close() { this.stream.check(); this.stream.dispose(); }
}
