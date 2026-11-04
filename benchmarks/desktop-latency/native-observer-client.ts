import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { holdObservation } from './observer-promises.js';
import type { ClockSample } from './clock-bounds.js';

export class ObservationRows {
  readonly rows: any[] = [];
  private waiters: any[] = [];
  private failure?: Error;
  private guarded = false;
  private lastFrame?: { index: number; displayMs: number };
  constructor(private readonly defaultTimeoutMs = 10_000) {
    assert(Number.isInteger(defaultTimeoutMs) && defaultTimeoutMs > 0 && defaultTimeoutMs <= 60_000);
  }
  get pendingCount() { return this.waiters.length; }
  arm() { this.guarded = true; }
  fail(error: Error) {
    this.failure ??= error;
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(this.failure); }
  }
  receive(row: any) {
    try {
      assert(row && typeof row.kind === 'string', 'Malformed observer row');
      row.receivedN = performance.now();
      assert(this.rows.length < 25_000, 'Observer capacity exceeded');
      this.rows.push(row);
      if (row.kind === 'error') throw new Error(row.error);
      if (row.kind === 'frame') {
        assert(Number.isInteger(row.index) && Number.isFinite(row.displayMs), 'Invalid native frame identity');
        assert(!this.lastFrame || (row.index > this.lastFrame.index && row.displayMs >= this.lastFrame.displayMs),
          'Reordered or duplicated native frame');
        this.lastFrame = row;
      }
      if (this.guarded && ((row.kind === 'frame' && row.active !== true) ||
          (row.kind === 'sample-status' && [2, 3].includes(row.status))))
        throw new Error('Visible measurement lost its active display');
      for (const w of this.waiters.slice()) if (this.rows.length - 1 >= w.after && w.predicate(row)) {
        this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(row);
      }
    } catch (error) { this.fail(error as Error); }
  }
  wait(predicate: (row: any) => boolean, after = 0, timeoutMs = this.defaultTimeoutMs): Promise<any> {
    if (this.failure) return holdObservation(Promise.reject(this.failure));
    const row = this.rows.slice(after).find(predicate);
    if (row) return Promise.resolve(row);
    return holdObservation(new Promise((resolve, reject) => {
      const w: any = { predicate, after, resolve, reject };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('Native pixel/control response timeout'));
      }, timeoutMs);
      this.waiters.push(w);
    }));
  }
  check() { if (this.failure) throw this.failure; }
  dispose() { this.fail(new Error('Observer disposed')); }
}
export interface WindowObserver {
  stream: ObservationRows;
  command(line: string): void;
  flush(): Promise<void>;
  calibrate(): Promise<ClockSample[]>;
  close(): Promise<void>;
}
export class NativeWindowObserver implements WindowObserver {
  readonly stream = new ObservationRows();
  private child: ChildProcessWithoutNullStreams;
  private closed: Promise<number | null>;
  private stopping = false;
  private id = 0;
  stderr = '';
  constructor(binary: string, title: string, owners: number[], width: string) {
    assert(owners.length && owners.every(Number.isInteger));
    this.child = spawn(binary, [title, owners.join(','), width], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', e => this.stream.fail(e));
    this.child.stdin.on('error', e => this.stream.fail(e));
    this.child.stderr.on('data', b => { this.stderr += b; if (this.stderr.length > 1_000_000) {
      this.stream.fail(new Error('Native stderr capacity')); this.child.kill('SIGTERM');
    } });
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.stream.receive(JSON.parse(line)); } catch (e) { this.stream.fail(e as Error); }
    });
    this.closed = new Promise(resolve => this.child.once('close', code => {
      if (!this.stopping) this.stream.fail(new Error(`Native observer exited ${code}: ${this.stderr}`));
      resolve(code);
    }));
  }
  command(line: string) { this.stream.check(); assert(!line.includes('\n')); this.child.stdin.write(line + '\n'); }
  async flush() {} // A native response is driven by actual WindowServer samples.
  async calibrate() {
    const samples: ClockSample[] = [];
    for (let i = 0; i < 9; i++) {
      const id = String(++this.id), start = this.stream.rows.length, n0 = performance.now();
      const pending = this.stream.wait(r => r.kind === 'pong' && r.id === id, start);
      this.command(`ping ${id}`); const row = await pending;
      samples.push({ n0, n1: row.receivedN, b: row.nativeMs });
    }
    return samples;
  }
  async close() {
    this.stopping = true;
    this.child.stdin.write('stop\n');
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 5000);
    try { assert.equal(await this.closed, 0, this.stderr); this.stream.check(); }
    finally { clearTimeout(timer); this.stream.dispose(); }
  }
}

/** Enumerate only descendants of a caller-owned browser/server/test process. */
export function ownedProcessFamily(rootPid: number): number[] {
  assert(Number.isInteger(rootPid) && rootPid > 0);
  const tree = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  assert(tree.some(([pid]) => pid === rootPid), 'Owned process root no longer exists');
  const owners = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of tree) if (owners.has(parent) && !owners.has(pid)) { owners.add(pid); changed = true; }
  }
  return [...owners];
}
