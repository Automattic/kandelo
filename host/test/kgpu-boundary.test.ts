// The kernel/host boundary of the kgpu device, end to end: a real grouped
// program calls `kandelo.kgpu.v1.__kandelo_kgpu_v1` through the process
// worker (request 602 on its own channel), and this test plays the GPU host
// adapter with the kernel worker's kick callback and its drain/complete
// entries (`kernel_kgpu_drain` / `kernel_kgpu_complete`).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { KandeloImageFs } from '../../images/vfs/lib/kandelo-image-fs';
import { resolveBinary } from '../src/binary-resolver';
import {
  CH_ARGS,
  CH_ARG_SIZE,
  CH_REQUEST_FLAGS,
  CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
  CH_SYSCALL,
  EXTENSION_REQUEST_KGPU_V1,
  KGPU_EXTENT_SIZE,
  KGPU_OP_ARG_SIZES,
  KGPU_OUTBOX_CAPACITY,
  KGPU_SUBMISSION_CONTEXT_CREATE,
  KGPU_SUBMISSION_CONTEXT_DESTROY,
  KGPU_SUBMISSION_HEADER_SIZE,
  KGPU_SUBMISSION_SUBMIT,
} from '../src/generated/abi';
import { compileSdkFixture } from './support/compile-sdk-fixture';
import { buildDlopenImports } from '../src/worker-main';
import { GroupProcessAddressSpace } from '../src/process-address-space';
import { processDataView } from '../src/process-memory-views';
import { KGPU_IMPORT, KGPU_MODULE } from '../src/generated/program-extensions';

const root = resolve(import.meta.dirname, '../..');
// One-extent submissions that exactly fill the outbox: the next one cannot fit.
const FILL = Math.floor(KGPU_OUTBOX_CAPACITY / (KGPU_SUBMISSION_HEADER_SIZE + KGPU_EXTENT_SIZE));
const EINVAL = 22, EIO = 5;
let directory: string, image: string;

beforeAll(async () => {
  mkdirSync(join(root, '.scratch'), { recursive: true });
  directory = mkdtempSync(join(root, '.scratch/kgpu-boundary-'));
  image = join(directory, 'rootfs.vfs');
  const fixture = compileSdkFixture(new URL('./fixtures/kgpu-boundary.c', import.meta.url), [], { forkInstrument: true });
  const fs = KandeloImageFs.create();
  try {
    const grouped = fixture.programPath + '.grouped.wasm';
    execFileSync(fileURLToPath(new URL('../../sdk/bin/wasm32posix-shared-memory', import.meta.url)),
      [fixture.programPath, '-o', grouped], { stdio: 'pipe' });
    fs.mkdir('/tmp', 0o1777); fs.mkdir('/bin', 0o755);
    fs.writeFile('/bin/kgpu-boundary', new Uint8Array(readFileSync(grouped)), 0o755);
    writeFileSync(image, await fs.saveImage());
  } finally { fs.reset(); fixture.cleanup(); }
}, 180_000);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

it('serves kgpu.v1 to a grouped program across the kernel/host boundary', async () => {
  const registration = new URL('../node_modules/tsx/dist/esm/api/index.mjs', import.meta.url).href;
  const entry = new URL('./fixtures/kgpu-boundary-worker.ts', import.meta.url).href;
  const worker = new Worker(`import{register}from ${JSON.stringify(registration)};register();await import(${JSON.stringify(entry)});`,
    { eval: true, workerData: { kernel: resolveBinary('kernel.wasm'), image, fill: FILL } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r: any = await new Promise((yes, no) => {
      timer = setTimeout(() => no(Error('kernel Worker deadline')), 150_000);
      worker.once('message', yes);
      worker.once('error', no);
      worker.once('exit', code => no(Error('worker exit ' + code)));
    });
    expect(r.failure, `${r.failure}\n${r.stack}`).toBeUndefined();
    expect(r.fatal).toBeUndefined();
    expect(r.diagnostics).toEqual([]);
    expect(r.stderr).toBe('');
    expect(r.code, r.stdout).toBe(0);

    // R11: refused by the import before any request.
    expect(r.badSize).toBe(`bad-size ${-EINVAL}`);
    expect(r.badOp).toBe(`bad-op ${-EINVAL}`);

    // The kick fires once for the two records queued before the drain, and
    // the drain yields them in order.
    expect(r.createResult).toBe(0);
    expect(r.submitResult).toBe(0);
    expect(r.kicksAfterSubmit).toBe(1);
    expect(r.first).toEqual([
      { kind: KGPU_SUBMISSION_CONTEXT_CREATE, context: r.context, seqno: 0, extents: 0, buffers: 0 },
      { kind: KGPU_SUBMISSION_SUBMIT, context: r.context, seqno: r.seqno, extents: 1, buffers: 0 },
    ]);
    // Feeding Retired answers the parked wait.
    expect(r.waitedBeforeRetire).toBe(false);
    expect(r.retireStatus).toBe(0);
    expect(r.waitResult).toBe(0);

    // R13: a submit that meets a full outbox is held by the host's EAGAIN
    // retry, not answered, and commits with the next seqno after a drain.
    expect(r.filled).toBe(r.seqno + FILL);
    expect(r.heldBeforeDrain).toBe(false);
    expect(r.fullCount).toBe(FILL);
    expect(r.fullLast).toBe(r.filled);
    expect(r.heldResult).toBe(0);
    expect(r.heldSeqno).toBe(r.filled + 1);
    expect(r.admitted).toEqual([
      { kind: KGPU_SUBMISSION_SUBMIT, context: r.context, seqno: r.heldSeqno, extents: 1, buffers: 0 },
    ]);

    // A context lost while the submit retries answers -EIO; its undrained
    // records are dropped, and (R16) the executor's own loss report also
    // releases its drained work, so a later Retired for it changes nothing.
    expect(r.refilled).toBe(r.heldSeqno + FILL);
    expect(r.lostBeforeLoss).toBe(false);
    expect(r.lossStatus).toBe(0);
    expect(r.lostResult).toBe(-EIO);
    expect(r.lostSeqno).toBe(0);
    expect(r.afterLossCount).toBe(0);
    expect(r.pinnedBeforeRetire).toBe(0);
    expect(r.finalRetireStatus).toBe(0);
    expect(r.pinnedAfterRetire).toBe(0);
    // Exit destroys the process's context through the device.
    expect(r.afterExit).toEqual([
      { kind: KGPU_SUBMISSION_CONTEXT_DESTROY, context: r.context, seqno: 0, extents: 0, buffers: 0 },
    ]);
    // One kick per empty-to-non-empty edge: the first records, each fill,
    // the held submit committing into the drained outbox, and the exit's
    // destroy record.
    expect(r.kicks).toBe(5);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}, 240_000);

// R11 at the import itself: a wrong size or an unknown op never becomes a
// request, so the host stages at most the op's struct; a right one becomes
// request 602 on the caller's channel with no flag that forbids the host's
// EAGAIN retry.
it('issues request 602 only for an op and size from the generated table', () => {
  const page = 65536, root = page, channel = 4096;
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 16, shared: true });
  const words = new Uint32Array(memory.buffer);
  words[root / 4] = 4;
  for (let i = 0; i < 4; i++) words[root / 4 + 16 + i] = (4 + 2 * i) * page | 3;
  const source = new GroupProcessAddressSpace({ memory, root, maximumPages: 4, assertLive: () => {} });
  const requests: { syscall: number; args: bigint[]; flags: number }[] = [];
  // Plays the kernel: record the published request and complete it.
  const wait32 = (): number => {
    const view = processDataView(source);
    requests.push({
      syscall: view.getInt32(channel + CH_SYSCALL, true),
      args: [0, 1, 2].map(i => view.getBigInt64(channel + CH_ARGS + i * CH_ARG_SIZE, true)),
      flags: view.getUint32(channel + CH_REQUEST_FLAGS, true),
    });
    return 1;
  };
  const support = buildDlopenImports(source, channel, 128, () => undefined, () => undefined, () => undefined,
    4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 100,
    'copied', undefined, undefined, wait32);
  const kgpu = (support.extensionImports[KGPU_MODULE] as Record<string, (arg: number, size: number, op: number) => number>)[KGPU_IMPORT]!;
  const EINVAL = -22;
  for (const op of [1, 2, 3, 4]) {
    expect(kgpu(page - 64, KGPU_OP_ARG_SIZES[op]! - 1, op)).toBe(EINVAL);
    expect(kgpu(page - 64, KGPU_OP_ARG_SIZES[op]! + 1, op)).toBe(EINVAL);
  }
  for (const op of [0, 5, -1, 0x7fffffff]) expect(kgpu(page - 64, 24, op)).toBe(EINVAL);
  expect(requests).toEqual([]);
  expect(kgpu(page - 64, KGPU_OP_ARG_SIZES[3]!, 3)).toBe(0);
  expect(requests).toEqual([{
    syscall: EXTENSION_REQUEST_KGPU_V1,
    args: [BigInt(page - 64), BigInt(KGPU_OP_ARG_SIZES[3]!), 3n],
    flags: CH_REQUEST_FLAG_DEFER_SIGNAL_DELIVERY,
  }]);
});
