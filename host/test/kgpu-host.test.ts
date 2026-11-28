// The kgpu device end to end on Node: a real grouped guest program calls
// kandelo.kgpu.v1, the kernel queues records, the kernel worker's KgpuHost
// moves them through the device ring to a real GPU worker running the Rust
// executor over a WebGL 2 test double, and completions come back the same
// way. Each case runs its own disposable kernel Worker
// (fixtures/kgpu-host-worker.ts) so a crash case cannot leak into the next.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { KandeloImageFs } from '../../images/vfs/lib/kandelo-image-fs';
import { resolveBinary } from '../src/binary-resolver';
import { compileSdkFixture } from './support/compile-sdk-fixture';
import {
  KGPU_BUFFER_HEADER_SIZE,
  KGPU_EXTENT_SIZE,
  KGPU_RECORD_FIELDS,
  KGPU_SUBMISSION_CONTEXT_CREATE,
  KGPU_SUBMISSION_HEADER_SIZE,
  KGPU_SUBMISSION_SUBMIT,
} from '../src/generated/abi';
import { RecordAssembler } from '../src/kgpu/records';
import { RING_DATA_BYTES } from '../src/device-worker/ring';

const root = resolve(import.meta.dirname, '../..');
const ENODEV = 19, EIO = 5;
let directory: string, image: string;

beforeAll(async () => {
  mkdirSync(join(root, '.scratch'), { recursive: true });
  directory = mkdtempSync(join(root, '.scratch/kgpu-host-'));
  image = join(directory, 'rootfs.vfs');
  const fixture = compileSdkFixture(new URL('./fixtures/kgpu-host.c', import.meta.url), [], { forkInstrument: true });
  const fs = KandeloImageFs.create();
  try {
    const grouped = fixture.programPath + '.grouped.wasm';
    execFileSync(fileURLToPath(new URL('../../sdk/bin/wasm32posix-shared-memory', import.meta.url)),
      [fixture.programPath, '-o', grouped], { stdio: 'pipe' });
    fs.mkdir('/tmp', 0o1777); fs.mkdir('/bin', 0o755);
    fs.writeFile('/bin/kgpu-host', new Uint8Array(readFileSync(grouped)), 0o755);
    writeFileSync(image, await fs.saveImage());
  } finally { fs.reset(); fixture.cleanup(); }
}, 180_000);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

/** Run one scenario in a disposable kernel Worker and return its report. */
async function scenario(name: string, renderer: 'webgl2' | 'null' = 'webgl2'): Promise<any> {
  const registration = new URL('../node_modules/tsx/dist/esm/api/index.mjs', import.meta.url).href;
  const entry = new URL('./fixtures/kgpu-host-worker.ts', import.meta.url).href;
  const worker = new Worker(`import{register}from ${JSON.stringify(registration)};register();await import(${JSON.stringify(entry)});`, {
    eval: true,
    workerData: {
      scenario: name, renderer, image,
      kernel: resolveBinary('kernel.wasm'),
      webgl2Factory: new URL('./support/kgpu-webgl2-double.ts', import.meta.url).href,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r: any = await new Promise((yes, no) => {
      timer = setTimeout(() => no(Error(`${name}: kernel Worker deadline`)), 150_000);
      worker.once('message', yes);
      worker.once('error', no);
      worker.once('exit', code => no(Error(`${name}: worker exit ${code}`)));
    });
    expect(r.failure, `${r.failure}\n${r.stack}`).toBeUndefined();
    expect(r.fatal).toBeUndefined();
    expect(r.stderr).toBe('');
    return r;
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

const lines = (stdout: string, prefix: string) =>
  stdout.split('\n').filter(line => line.startsWith(prefix + ' ')).map(line => line.split(' ').slice(1).map(Number));

describe('kgpu host', () => {
  it('clear_and_readback_roundtrip', async () => {
    const r = await scenario('clear');
    expect(r.code, r.stdout).toBe(0);
    expect(lines(r.stdout, 'create')[0]![0]).toBe(0);
    expect(lines(r.stdout, 'wait')).toEqual([[0]]);
    // R2: clear color (0.2, 0.4, 0.6, 1.0) reads back as 51, 102, 153, 255.
    expect(lines(r.stdout, 'pixel')).toEqual(Array.from({ length: 16 }, (_, i) => [i, 51, 102, 153, 255]));
    expect(r.pinnedAfter).toBe(0);
    expect(r.status.resets).toBe(0);
    expect(r.status.workersStarted).toBe(1);
  }, 240_000);

  it('ring_full_backpressure_completes_all', async () => {
    const r = await scenario('many');
    expect(r.code, r.stdout).toBe(0);
    const [[waited, first, last]] = lines(r.stdout, 'many') as number[][];
    expect(waited).toBe(200);
    expect(last! - first!).toBe(199);
    // The batch is several times the submission ring, so the host had to
    // hold drained records until the GPU worker made room.
    expect(r.status.submittedBytes).toBeGreaterThan(3 * RING_DATA_BYTES);
    expect(r.status.ringFullStalls).toBeGreaterThan(0);
    expect(r.status.completions).toBeGreaterThanOrEqual(201);
    expect(r.pinnedAfter).toBe(0);
  }, 240_000);

  it('exit_while_pinned_publishes_after_retired', async () => {
    const r = await scenario('exit');
    expect(r.code, r.stdout).toBe(0);
    expect(lines(r.stdout, 'submit')[0]![0]).toBe(0);
    // Held: the GPU worker had not been released, so the submission was
    // drained but not retired, and its frames stayed pinned.
    expect(r.pinnedWhileHeld).toBeGreaterThan(0);
    expect(r.exitedWhileHeld).toBe(false);
    expect(r.exitedAfterRelease).toBe(true);
    expect(r.pinnedAfter).toBe(0);
    expect(r.imagesAfter).toBe(0);
    expect(r.status.resets).toBe(0);
  }, 240_000);

  it('worker_crash_resets_device_and_releases_exits', async () => {
    const r = await scenario('crash-exit');
    expect(r.code, r.stdout).toBe(0);
    expect(r.pinnedWhileHeld).toBeGreaterThan(0);
    expect(r.exitedWhileHeld).toBe(false);
    // R15: only after the killed worker is gone does the kernel reset, and
    // the reset releases the exit.
    expect(r.exitedAfterKill).toBe(true);
    expect(r.status.resets).toBe(1);
    expect(r.pinnedAfter).toBe(0);
    expect(r.imagesAfter).toBe(0);
    // The renderer is gone until the host starts a new worker.
    expect(r.createAfterReset).toBe(-ENODEV);
    expect(r.createAfterRestart).toBe(0);
    expect(r.pixelsAfterRestart).toEqual(Array.from({ length: 16 }, (_, i) => [i, 51, 102, 153, 255]));
    expect(r.status.workersStarted).toBe(2);
  }, 240_000);

  it('faulted_context_releases_its_pins', async () => {
    const r = await scenario('fault');
    expect(r.code, r.stdout).toBe(0);
    expect(lines(r.stdout, 'submit')[0]![0]).toBe(0);
    // R16: the executor faulted only this context; its loss released the
    // context's pins without a device reset.
    expect(lines(r.stdout, 'wait')).toEqual([[-EIO]]);
    expect(lines(r.stdout, 'resubmit')).toEqual([[-EIO]]);
    expect(r.pinnedAfter).toBe(0);
    expect(r.imagesAfter).toBe(0);
    expect(r.status.resets).toBe(0);
  }, 240_000);

  it('worker_crash_loses_contexts', async () => {
    const r = await scenario('crash-wait');
    expect(r.code, r.stdout).toBe(0);
    expect(r.waitedWhileHeld).toBe(false);
    expect(lines(r.stdout, 'wait')).toEqual([[-EIO]]);
    expect(r.status.resets).toBe(1);
    expect(r.pinnedAfter).toBe(0);
  }, 240_000);

  it('webgl_context_loss_loses_every_context', async () => {
    const r = await scenario('lose');
    expect(r.code, r.stdout).toBe(0);
    expect(lines(r.stdout, 'submit')[0]![0]).toBe(0);
    expect(r.waitedWhileHeld).toBe(false);
    // The renderer was lost during the clear: the parked wait fails, the
    // context that was idle is lost too, and with the worker gone there is
    // no renderer until the host starts a new one.
    expect(lines(r.stdout, 'wait')).toEqual([[-EIO]]);
    expect(lines(r.stdout, 'idle-submit')).toEqual([[-EIO]]);
    expect(lines(r.stdout, 'create-after')).toEqual([[-ENODEV]]);
    expect(r.status.resets).toBe(1);
    expect(r.pinnedAfter).toBe(0);
    expect(r.imagesAfter).toBe(0);
    expect(r.diagnostics.join('\n')).toMatch(/WebGL context lost/);
    // A restarted worker renders again.
    expect(r.createAfterRestart).toBe(0);
    expect(r.pixelsAfterRestart).toEqual(Array.from({ length: 16 }, (_, i) => [i, 51, 102, 153, 255]));
    expect(r.status.workersStarted).toBe(2);
  }, 240_000);

  it('node_null_renderer_create_is_enodev', async () => {
    const r = await scenario('create', 'null');
    expect(lines(r.stdout, 'create')[0]![0]).toBe(-ENODEV);
    expect(r.code).toBe(1);
    // No renderer: no GPU worker is ever started.
    expect(r.status.workersStarted).toBe(0);
  }, 240_000);
});

describe('kgpu record assembly', () => {
  /** A submit record with `buffers` one-extent buffers, encoded with the
   * generated field offsets. */
  function submit(context: number, seqno: number, buffers: number): Uint8Array {
    const length = KGPU_SUBMISSION_HEADER_SIZE + KGPU_EXTENT_SIZE + buffers * (KGPU_BUFFER_HEADER_SIZE + KGPU_EXTENT_SIZE);
    const bytes = new Uint8Array(length), view = new DataView(bytes.buffer), f = KGPU_RECORD_FIELDS;
    view.setUint32(f.submission.kind, KGPU_SUBMISSION_SUBMIT, true);
    view.setUint32(f.submission.context, context, true);
    view.setBigUint64(f.submission.seqno, BigInt(seqno), true);
    view.setUint32(f.submission.streamExtentCount, 1, true);
    view.setUint32(f.submission.bufferCount, buffers, true);
    let at = KGPU_SUBMISSION_HEADER_SIZE;
    view.setBigUint64(at + f.extent.offset, 0x10000n, true); view.setUint32(at + f.extent.len, 16, true);
    at += KGPU_EXTENT_SIZE;
    for (let i = 0; i < buffers; i++) {
      view.setUint32(at + f.buffer.access, 1, true); view.setUint32(at + f.buffer.extentCount, 1, true);
      at += KGPU_BUFFER_HEADER_SIZE;
      view.setBigUint64(at + f.extent.offset, BigInt(0x20000 + i * 64), true); view.setUint32(at + f.extent.len, 64, true);
      at += KGPU_EXTENT_SIZE;
    }
    return bytes;
  }

  it('reassembles records split anywhere across ring chunks', () => {
    const create = new Uint8Array(KGPU_SUBMISSION_HEADER_SIZE);
    new DataView(create.buffer).setUint32(KGPU_RECORD_FIELDS.submission.kind, KGPU_SUBMISSION_CONTEXT_CREATE, true);
    const stream = [create, submit(1, 1, 0), submit(1, 2, 64), submit(1, 3, 3)];
    const joined = new Uint8Array(stream.reduce((n, r) => n + r.byteLength, 0));
    stream.reduce((at, r) => { joined.set(r, at); return at + r.byteLength; }, 0);
    for (const chunk of [1, 7, 24, 25, 1000, joined.byteLength]) {
      const assembler = new RecordAssembler();
      const out: Uint8Array[] = [];
      for (let at = 0; at < joined.byteLength; at += chunk) {
        assembler.append(joined.subarray(at, at + chunk));
        for (let record; (record = assembler.next()) !== null;) out.push(record.slice());
      }
      expect(out, `chunk ${chunk}`).toEqual(stream);
      expect(assembler.pending).toBe(0);
    }
  });

  it('refuses a record whose counts exceed the wire limits', () => {
    const bad = submit(1, 1, 0);
    new DataView(bad.buffer).setUint32(KGPU_RECORD_FIELDS.submission.bufferCount, 65, true);
    const assembler = new RecordAssembler();
    assembler.append(bad);
    expect(() => assembler.next()).toThrow(/kgpu record/);
  });
});
