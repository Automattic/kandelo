// Disposable dedicated kernel Worker for host/test/kgpu-boundary.test.ts.
//
// WHY a Worker of its own: the test plays the GPU host adapter, so it needs
// the kernel worker's kgpu entry points and kick callback directly, and a
// memory-group launch. NodeKernelHost hides both behind its worker protocol.
// Results are owned scalars and copied strings, never a guest Memory.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { CentralizedKernelWorker, CAPTURED_STDIO } from '../../src/kernel-worker';
import { GroupedSessionRuntime } from '../../src/grouped-session-runtime';
import { retryKernelEntryResult as retry } from '../../src/kernel-entry-retry';
import { NodePlatformIO } from '../../src/platform/node';
import { NodeWorkerAdapter } from '../../src/worker-adapter';
import {
  KGPU_COMPLETION_CONTEXT_LOST,
  KGPU_COMPLETION_RETIRED,
  KGPU_COMPLETION_SIZE,
  KGPU_EXTENT_SIZE,
  KGPU_SUBMISSION_HEADER_SIZE,
} from '../../src/generated/abi';

interface Record { kind: number; context: number; seqno: number; extents: number; buffers: number }

/** Split drained bytes into submission records (`shared::kgpu` wire). */
function records(bytes: Uint8Array): Record[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record[] = [];
  for (let at = 0; at < bytes.byteLength;) {
    const extents = view.getUint32(at + 16, true), buffers = view.getUint32(at + 20, true);
    if (buffers !== 0) throw Error('fixture submits no buffers');
    out.push({ kind: view.getUint32(at, true), context: view.getUint32(at + 4, true),
      seqno: Number(view.getBigUint64(at + 8, true)), extents, buffers });
    at += KGPU_SUBMISSION_HEADER_SIZE + extents * KGPU_EXTENT_SIZE;
  }
  return out;
}

function completion(kind: number, context: number, seqno: number): Uint8Array {
  const bytes = new Uint8Array(KGPU_COMPLETION_SIZE), view = new DataView(bytes.buffer);
  view.setUint32(0, kind, true); view.setUint32(4, context, true);
  view.setBigUint64(8, BigInt(seqno), true);
  return bytes;
}

async function execute() {
  let session!: GroupedSessionRuntime, exitResolve!: (code: number) => void;
  let stdout = '', stderr = '', fatal: string | undefined, kicks = 0;
  const diagnostics: string[] = [];
  const exited = new Promise<number>(resolve => { exitResolve = resolve; });
  const kernel = new CentralizedKernelWorker({ maxWorkers: 16, dataBufferSize: 65536, useSharedMemory: true, kernelMaxPages: 1024 }, new NodePlatformIO(), {
    onExit: (pid, code) => { session.exit(pid, code); }, onGroupedFork: r => session.fork(r), onGroupedClone: r => session.clone(r),
    onGroupedExec: r => session.exec(r), onThreadExit: (pid, tid) => session.threadExit(pid, tid),
    onKernelFatal: e => { fatal = e.message; }, onHostDiagnostic: e => diagnostics.push(JSON.stringify(e)),
    // The contract: record the kick, never re-enter the kernel from it.
    onKgpuKick: () => { kicks++; },
  });
  const image: Uint8Array = readFileSync(workerData.image);
  kernel.configureRootfsOverlay(() => -2, [], false, image.byteLength, (offset, destination) => {
    const n = Math.min(destination.length, Math.max(0, image.length - offset));
    destination.set(image.subarray(offset, offset + n)); return n;
  });
  note('init');
  await kernel.init(Uint8Array.from(readFileSync(workerData.kernel)).buffer);
  kernel.setOutputCallbacks({ onStdout: b => stdout += new TextDecoder().decode(b), onStderr: b => stderr += new TextDecoder().decode(b) });
  session = new GroupedSessionRuntime(kernel, new NodeWorkerAdapter(), { maximumPages: 2048, maximumProcesses: 8, maximumTasks: 16 }, true,
    (_pid, code) => exitResolve(code), (_pid, error) => diagnostics.push(error.message));
  note('group');
  const group = await session.initialPathGroup();
  // R3: without a renderer, context creation is ENODEV.
  await retry(() => kernel.setKgpuRenderer(true));

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const lines = (prefix: string) => stdout.split('\n').filter(line => line.startsWith(prefix + ' '));
  const waitFor = async (prefix: string, count = 1) => {
    for (const deadline = Date.now() + 60_000; lines(prefix).length < count;) {
      if (fatal || Date.now() > deadline) throw Error(`no "${prefix}" line: ${fatal ?? ''} stdout=${stdout} stderr=${stderr}`);
      await sleep(5);
    }
    return lines(prefix)[count - 1]!.split(' ').slice(1).map(Number);
  };
  const drainAll = async () => {
    const out: Record[] = [];
    for (;;) {
      const bytes = await retry(() => kernel.drainKgpu());
      if (bytes.byteLength === 0) return out;
      out.push(...records(bytes));
    }
  };
  const complete = (bytes: Uint8Array) => retry(() => kernel.completeKgpu(bytes));

  note('launch');
  const pid = await retry(() => kernel.createProcess(CAPTURED_STDIO));
  await retry(() => kernel.installHostStdinPipe(pid));
  const launched = await kernel.launchInitialPath(pid, '/bin/kgpu-boundary', ['kgpu-boundary', String(workerData.fill)], [],
    async request => ({ onCommitFailure: () => {}, startAfterCommit: async () => {
      await session.launch(pid, request.targetBytes, request.targetModule, request.argv, request.envp, 2048, 8,
        kernel.takeCommittedExecSecureExec(pid), true);
      return 0;
    } }), group);
  if (launched !== 0) throw Error('path commit ' + launched);

  // 1. Create, submit and wait: one kick, then both records in order, then
  //    a Retired completion answers the parked wait.
  note('phase 1');
  const [createResult, context] = await waitFor('create');
  const [submitResult, seqno] = await waitFor('submit');
  const kicksAfterSubmit = kicks;
  const first = await drainAll();
  await sleep(50);
  const waitedBeforeRetire = lines('wait').length > 0;
  const retireStatus = await complete(completion(KGPU_COMPLETION_RETIRED, context!, seqno!));
  const [waitResult] = await waitFor('wait');

  // 2. Fill the outbox; the next submit must be held by the host's EAGAIN
  //    retry until a drain frees room, and then report its real seqno.
  note('phase 2');
  const go = () => kernel.appendStdinData(pid, new Uint8Array([0x67]));
  go();
  const [filled] = await waitFor('filled');
  await sleep(400);
  const heldBeforeDrain = lines('held').length > 0;
  const full = await drainAll();
  const [heldResult, heldSeqno] = await waitFor('held');
  const admitted = await drainAll();

  // 3. Fill again and lose the context while the next submit is retrying.
  note('phase 3');
  go();
  const [refilled] = await waitFor('filled', 2);
  await sleep(400);
  const lostBeforeLoss = lines('lost').length > 0;
  const lossStatus = await complete(completion(KGPU_COMPLETION_CONTEXT_LOST, context!, 0));
  const [lostResult, lostSeqno] = await waitFor('lost');
  const afterLoss = await drainAll();
  // Drained work stays pinned until the executor retires it.
  const pinnedBeforeRetire = await retry(() => kernel.devicePinnedFrames());
  const finalRetireStatus = await complete(completion(KGPU_COMPLETION_RETIRED, context!, heldSeqno!));
  const pinnedAfterRetire = await retry(() => kernel.devicePinnedFrames());
  const result = {
    stdout, stderr, fatal, diagnostics, kicks, kicksAfterSubmit,
    badSize: lines('bad-size')[0], badOp: lines('bad-op')[0],
    createResult, context, submitResult, seqno, first, waitedBeforeRetire, retireStatus, waitResult,
    filled, heldBeforeDrain, fullCount: full.length, fullLast: full.at(-1)?.seqno, heldResult, heldSeqno, admitted,
    refilled, lostBeforeLoss, lossStatus, lostResult, lostSeqno, afterLossCount: afterLoss.length,
    pinnedBeforeRetire, finalRetireStatus, pinnedAfterRetire,
  };
  note('exit');
  debug = () => ({ ...result, stdout, stderr, diagnostics, fatal, kicks,
    pinned: kernel.devicePinnedFrames(), group: kernel.inspectMemoryGroup(group) });
  go();
  const code = await exited;
  // Exit destroys the process's contexts through the device.
  await sleep(50);
  const afterExit = await drainAll();
  await session.destroy();
  kernel.stopPolling();
  return { ...result, code, kicks, afterExit };
}

let stage = 'start';
let debug: () => unknown = () => undefined;
const note = (next: string) => { stage = next; };
// A hang must report where it stopped instead of ending the Worker silently.
const watchdog = setTimeout(() => {
  let state: unknown;
  try { state = debug(); } catch (error) { state = String(error); }
  parentPort!.postMessage({ failure: `fixture stalled at ${stage}: ${JSON.stringify(state)}` });
}, 120_000);
try { parentPort!.postMessage(await execute()); }
catch (e) { parentPort!.postMessage({ failure: `${String(e)} (at ${stage})`, stack: e instanceof Error ? e.stack : undefined }); }
finally { clearTimeout(watchdog); parentPort!.close(); }
