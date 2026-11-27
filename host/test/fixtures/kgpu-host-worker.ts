// Disposable dedicated kernel Worker for host/test/kgpu-host.test.ts.
//
// WHY a Worker of its own: the kernel worker must run off the main thread,
// and each scenario needs a memory-group launch and direct inspection of the
// kgpu device (pinned frames, images, the GPU host's status) that
// NodeKernelHost hides behind its worker protocol. The GPU worker is the
// real one (src/kgpu/gpu-worker-node.ts) with the real executor module; only
// its WebGL 2 context is a test double, supplied the way an embedder
// supplies a factory. Scenarios that must catch work in flight hold the GPU
// worker's init message, so drained records wait in the ring, and may kill
// the worker behind the GPU host's back, as a crash would.
// Results are owned scalars and copied strings, never a guest Memory.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { CentralizedKernelWorker, CAPTURED_STDIO } from '../../src/kernel-worker';
import { GroupedSessionRuntime } from '../../src/grouped-session-runtime';
import { retryKernelEntryResult as retry } from '../../src/kernel-entry-retry';
import { NodePlatformIO } from '../../src/platform/node';
import { NodeWorkerAdapter, type WorkerHandle } from '../../src/worker-adapter';
import { createNodeGpuWorker, nodeKgpuConfig } from '../../src/kgpu-node';

const { scenario, renderer } = workerData as { scenario: string; renderer: 'webgl2' | 'null' };
const hold = ['exit', 'crash-exit', 'crash-wait', 'lose'].includes(scenario);
/** The `lose` scenario's first GPU worker loads the double in its
 * lose-on-first-clear mode, so the renderer is lost mid-submission. */
const loseFirst = scenario === 'lose';

/** The first GPU worker of a holding scenario: its init message is held
 * until `release`, and `kill` terminates it without the GPU host asking. */
let held: { release(): void; kill(): Promise<number> } | undefined;
function createGpuWorker(): WorkerHandle {
  const real = createNodeGpuWorker();
  if (!hold || held) return real;
  let queue: [unknown, Transferable[] | undefined][] | null = [];
  const rewrite = (message: unknown) => {
    const init = message as { webgl2Factory?: string };
    if (loseFirst && typeof init?.webgl2Factory === 'string') init.webgl2Factory += '?lose=first-clear';
    return message;
  };
  held = {
    release() { const q = queue!; queue = null; for (const [m, t] of q) real.postMessage(m, t); },
    kill: () => real.terminate(),
  };
  return {
    postMessage(message: unknown, transfer?: Transferable[]) { message = rewrite(message); if (queue) queue.push([message, transfer]); else real.postMessage(message, transfer); },
    on: ((event: string, handler: (...args: any[]) => void) => real.on(event as 'exit', handler)) as WorkerHandle['on'],
    off: ((event: string, handler: (...args: any[]) => void) => real.off(event as 'exit', handler)) as WorkerHandle['off'],
    terminate: () => real.terminate(),
  };
}

async function execute() {
  let session!: GroupedSessionRuntime;
  let fatal: string | undefined;
  const stdout = new Map<number, string>(); let stderr = '';
  const diagnostics: string[] = [];
  const exits = new Map<number, (code: number) => void>();
  // The Node kernel worker's own configuration, with the factory standing
  // in for the embedder's and the GPU worker wrapped for holding.
  const kgpu = { ...nodeKgpuConfig(renderer === 'webgl2' ? workerData.webgl2Factory : undefined), createWorker: createGpuWorker };
  const kernel = new CentralizedKernelWorker({
    maxWorkers: 16, dataBufferSize: 65536, useSharedMemory: true, kernelMaxPages: 1024, kgpu,
  }, new NodePlatformIO(), {
    onExit: (pid, code) => { session.exit(pid, code); }, onGroupedFork: r => session.fork(r), onGroupedClone: r => session.clone(r),
    onGroupedExec: r => session.exec(r), onThreadExit: (pid, tid) => session.threadExit(pid, tid),
    onKernelFatal: e => { fatal = e.message; }, onHostDiagnostic: e => diagnostics.push(JSON.stringify(e)),
  });
  const image: Uint8Array = readFileSync(workerData.image);
  kernel.configureRootfsOverlay(() => -2, [], false, image.byteLength, (offset, destination) => {
    const n = Math.min(destination.length, Math.max(0, image.length - offset));
    destination.set(image.subarray(offset, offset + n)); return n;
  });
  note('init');
  await kernel.init(Uint8Array.from(readFileSync(workerData.kernel)).buffer);
  kernel.setProcessOutputCallbacks({
    onStdout: (pid, b) => stdout.set(pid, (stdout.get(pid) ?? '') + new TextDecoder().decode(b)),
    onStderr: (_pid, b) => { stderr += new TextDecoder().decode(b); },
  });
  session = new GroupedSessionRuntime(kernel, new NodeWorkerAdapter(), { maximumPages: 2048, maximumProcesses: 8, maximumTasks: 16 }, true,
    (pid, code) => exits.get(pid)?.(code), (_pid, error) => diagnostics.push(error.message));
  const group = await session.initialPathGroup();

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const lines = (pid: number, prefix: string) => (stdout.get(pid) ?? '').split('\n')
    .filter(line => line.startsWith(prefix + ' ')).map(line => line.split(' ').slice(1).map(Number));
  const waitFor = async (pid: number, prefix: string) => {
    for (const deadline = Date.now() + 60_000; lines(pid, prefix).length === 0;) {
      if (fatal || Date.now() > deadline) throw Error(`no "${prefix}" line from ${pid}: ${fatal ?? ''} stdout=${stdout.get(pid)} stderr=${stderr}`);
      await sleep(5);
    }
    return lines(pid, prefix)[0]!;
  };
  /** Launch /bin/kgpu-host grouped; `exited` settles when its exit publishes. */
  const launch = async (...args: string[]) => {
    const pid = await retry(() => kernel.createProcess(CAPTURED_STDIO));
    if (args[0] === 'lose') await retry(() => kernel.installHostStdinPipe(pid));
    let done = false;
    const exited = new Promise<number>(resolve => exits.set(pid, code => { done = true; resolve(code); }));
    const launched = await kernel.launchInitialPath(pid, '/bin/kgpu-host', ['kgpu-host', ...args], [],
      async request => ({ onCommitFailure: () => {}, startAfterCommit: async () => {
        await session.launch(pid, request.targetBytes, request.targetModule, request.argv, request.envp, 2048, 8,
          kernel.takeCommittedExecSecureExec(pid), true);
        return 0;
      } }), group);
    if (launched !== 0) throw Error('path commit ' + launched);
    return { pid, exited, done: () => done, out: () => stdout.get(pid) ?? '' };
  };
  const within = <T>(promise: Promise<T>, ms: number, what: string) => Promise.race([promise,
    sleep(ms).then(() => { throw Error(`${what} did not happen within ${ms} ms: ${JSON.stringify(debug())}`); })]);
  const pinned = () => retry(() => kernel.devicePinnedFrames());
  const images = async () => {
    // Retirement is asynchronous after the exit publishes; wait for it.
    for (const deadline = Date.now() + 10_000; ;) {
      const snapshot = await retry(() => kernel.inspectMemoryGroup(group));
      const count = typeof snapshot === 'number' ? snapshot : snapshot.images;
      if (count === 0 || Date.now() > deadline) return count;
      await sleep(10);
    }
  };
  const status = () => kernel.kgpuStatus();
  debug = () => ({ stdout: Object.fromEntries(stdout), stderr, fatal, diagnostics, status: status() });

  note(scenario);
  const result: Record<string, unknown> = {};
  if (scenario === 'clear' || scenario === 'create' || scenario === 'fault') {
    const p = await launch(scenario);
    result.code = await within(p.exited, 60_000, 'exit');
    result.stdout = p.out();
  } else if (scenario === 'many') {
    const p = await launch('many', '200');
    result.code = await within(p.exited, 120_000, 'exit');
    result.stdout = p.out();
  } else if (scenario === 'exit' || scenario === 'crash-exit') {
    const p = await launch('exit');
    await waitFor(p.pid, 'submit');
    await sleep(300);
    result.pinnedWhileHeld = await pinned();
    result.exitedWhileHeld = p.done();
    if (scenario === 'exit') {
      held!.release();
      result.code = await within(p.exited, 30_000, 'exit after release');
      result.exitedAfterRelease = p.done();
    } else {
      await held!.kill();
      result.code = await within(p.exited, 30_000, 'exit after kill');
      result.exitedAfterKill = p.done();
      const create = await launch('create');
      await within(create.exited, 30_000, 'create exit');
      result.createAfterReset = lines(create.pid, 'create')[0]?.[0];
      await kernel.restartKgpu();
      const again = await launch('clear');
      await within(again.exited, 60_000, 'clear after restart');
      result.createAfterRestart = lines(again.pid, 'create')[0]?.[0];
      result.pixelsAfterRestart = lines(again.pid, 'pixel');
    }
    result.stdout = p.out();
  } else if (scenario === 'crash-wait') {
    const p = await launch('wait');
    await waitFor(p.pid, 'submit');
    await sleep(300);
    result.waitedWhileHeld = lines(p.pid, 'wait').length > 0;
    await held!.kill();
    result.code = await within(p.exited, 30_000, 'exit after kill');
    result.stdout = p.out();
  } else if (scenario === 'lose') {
    const p = await launch('lose');
    await waitFor(p.pid, 'submit');
    await sleep(300);
    // The wait is parked: the GPU worker has not started yet.
    result.waitedWhileHeld = lines(p.pid, 'wait').length > 0;
    held!.release();
    await waitFor(p.pid, 'wait');
    // The lost renderer must take the device down through the worker's
    // failure and the kernel reset, with no help from the test.
    for (const deadline = Date.now() + 30_000; status()!.state !== 'down';) {
      if (Date.now() > deadline) throw Error(`no reset after the renderer was lost: ${JSON.stringify(debug())}`);
      await sleep(10);
    }
    kernel.appendStdinData(p.pid, new Uint8Array([0x67]));
    result.code = await within(p.exited, 30_000, 'exit after loss');
    result.stdout = p.out();
    await kernel.restartKgpu();
    const again = await launch('clear');
    await within(again.exited, 60_000, 'clear after restart');
    result.createAfterRestart = lines(again.pid, 'create')[0]?.[0];
    result.pixelsAfterRestart = lines(again.pid, 'pixel');
  } else throw Error('unknown scenario ' + scenario);
  result.imagesAfter = await images();
  result.pinnedAfter = await pinned();
  result.status = status();
  result.stderr = stderr; result.fatal = fatal; result.diagnostics = diagnostics;
  await session.destroy();
  await kernel.shutdownKgpu();
  return result;
}

let stage = 'start';
let debug: () => unknown = () => undefined;
const note = (next: string) => { stage = next; };
// A hang must report where it stopped instead of ending the Worker silently.
const watchdog = setTimeout(() => {
  let state: unknown;
  try { state = debug(); } catch (error) { state = String(error); }
  parentPort!.postMessage({ failure: `fixture stalled at ${stage}: ${JSON.stringify(state)}` });
}, 140_000);
try { parentPort!.postMessage(await execute()); }
catch (e) { parentPort!.postMessage({ failure: `${String(e)} (at ${stage})`, stack: e instanceof Error ? e.stack : undefined }); }
finally { clearTimeout(watchdog); parentPort!.close(); }
