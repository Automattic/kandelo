import { HOST_ADAPTER_VERSION } from '../src/generated/abi';
import { GROUPED_WORKER_EXTENSIONS } from '../src/program-extensions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupMemoryLayout } from './support/group-memory-layout';
import { GroupedWorkerRuntime } from '../src/grouped-worker-runtime';
import { createGroupedWorkerPrepare, createGroupedWorkerLaunch, receiveGroupedWorkerInitialization, waitForGroupedWorkerReady, createGroupedWorkerCancellation } from '../src/grouped-worker-initialization';
import { centralizedWorkerMain, centralizedThreadWorkerMain } from '../src/worker-main';
import { MockWorkerHandle } from '../src/worker-adapter';
import { runWithProcessWorkerQuiescence } from '../src/worker-quiescence';
import { describeWasmArtifactPolicyFailures } from '../src/constants';
import * as G from '../src/generated/program-extensions';
const P = 65536;
function fixture() {
  const receipt = { group: 7, pid: 100, tid: 100, serial: (1n << 55n) + 1n, generation: (1n << 54n) + 3n };
  const { handle, launch, memory, close } = groupMemoryLayout({ receipt });
  const { assertLive: _live, ...expected } = launch.expectation;
  const init = { type: 'centralized_init' as const, pid: 100, programBytes: new ArrayBuffer(0), channelOffset: 4096, secureExec: false };
  return { handle, launch, expected, init, memory, close };
}
function leb(value: number): number[] { const out: number[] = []; do { const byte = value & 127; value >>>= 7; out.push(byte | (value ? 128 : 0)); } while (value); return out; }
const text = (value: string): number[] => { const bytes = [...new TextEncoder().encode(value)]; return [...leb(bytes.length), ...bytes]; };
function artifact(patch: object = {}, start = false): ArrayBuffer {
  const metadata = { version: 3, layout: 3, threadAttach: 2, cooperativeStop: 3, executionBarrier: 1, orderedWaitQueue: 2, kernelGrowth: 1,
    initialPages: 1, maximumPages: 16, accessProfile: 'outlined', sourceSha256: '0'.repeat(64), helpersSha256: '1'.repeat(64), ...patch };
  const bytes = [0,97,115,109,1,0,0,0];
  const section = (id: number, body: number[]) => bytes.push(id, ...leb(body.length), ...body);
  section(1, [start ? 2 : 1,0x60,1,0x7f,1,0x7f,...(start ? [0x60,0,0] : [])]);
  section(2, [2,...text(G.MEMORY_GROUP_MODULE),...text('memory'),2,3,1,32,
    ...text(G.MEMORY_GROUP_GROWTH_MODULE),...text(G.MEMORY_GROUP_GROWTH_IMPORT),0,0]);
  if (start) { section(3,[1,1]); section(8,[1]); section(10,[1,2,0,0x0b]); }
  section(0,[...text(G.MEMORY_GROUP_SECTION), ...new TextEncoder().encode(JSON.stringify(metadata))]);
  return Uint8Array.from(bytes).buffer;
}
afterEach(() => vi.useRealTimers());
describe('normal grouped Worker initialization', () => {
  it('retains the ordinary entry contract without adding a memory handshake', async () => {
    const init = { type: 'centralized_init' }, receive = vi.fn(), post = vi.fn();
    const result = await receiveGroupedWorkerInitialization(init, receive, post);
    expect(result.init).toBe(init); expect(result.grouped).toBeUndefined();
    expect(receive).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it('exchanges exact memory-free readiness before accepting one admitted backing', async () => {
    const f = fixture(), posts: any[] = [];
    let next!: (value: unknown) => void;
    const initialization = receiveGroupedWorkerInitialization(createGroupedWorkerPrepare(f.expected),
      () => new Promise(resolve => { next = resolve; }), message => posts.push(message));
    expect(posts).toHaveLength(1);
    const inspect = (value: unknown): void => {
      if (value && typeof value === 'object') {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        for (const child of Object.values(value)) inspect(child);
      } else expect(['string','number','bigint']).toContain(typeof value);
    };
    inspect(posts[0]); expect(posts[0].receipt.serial).toBe(f.expected.receipt.serial);
    const worker = new MockWorkerHandle(), prepared = waitForGroupedWorkerReady(worker, f.expected);
    worker.simulateMessage(posts[0]); await prepared;
    next(createGroupedWorkerLaunch(f.init, f.launch.envelope));
    const received = await initialization;
    expect(received.init!.memory).toBe(f.launch.envelope.memory);
    expect(received.grouped!.descriptor.receipt).toEqual(f.expected.receipt);
    received.grouped!.detach(); f.close();
  });
  it.each([false, true])('cancels an exact scalar-only prepared realm without receiving memory (pthread=%s)', async thread => {
    const f = fixture();
    const expected = thread ? { ...f.expected, receipt: { ...f.expected.receipt, tid: 101, serial: 3n } } : f.expected;
    const posts: unknown[] = [];
    const result = await receiveGroupedWorkerInitialization(createGroupedWorkerPrepare(expected),
      async () => createGroupedWorkerCancellation(expected.receipt), message => posts.push(message));
    expect(result.stopped).toEqual(expected.receipt);
    expect(result.init).toBeUndefined(); expect(result.grouped).toBeUndefined();
    expect(posts).toHaveLength(1);
    const events: unknown[] = [];
    await runWithProcessWorkerQuiescence({ postMessage: value => events.push(value), close: () => events.push('closed') },
      { pid: expected.receipt.pid, ...(thread ? { tid: 101 } : {}), memoryGroup: result.stopped }, async () => {}, () => {});
    expect(events).toEqual([{ type: 'memory_quiescent', pid: expected.receipt.pid, ...(thread ? { tid: 101 } : {}), memoryGroup: expected.receipt }, 'closed']);
    f.close();
  });
  it.each(['serial', 'generation', 'tid'] as const)('refuses a preparation cancellation for another %s', async field => {
    const f = fixture(), wrong = { ...f.expected.receipt };
    if (field === 'tid') wrong.tid++; else wrong[field]++;
    await expect(receiveGroupedWorkerInitialization(createGroupedWorkerPrepare(f.expected),
      async () => createGroupedWorkerCancellation(wrong), () => {})).rejects.toThrow('another admission');
    f.close();
  });
  it('refuses memory-bearing launch without a preceding expectation', async () => {
    const f = fixture(), receive = vi.fn(), post = vi.fn();
    await expect(receiveGroupedWorkerInitialization(createGroupedWorkerLaunch(f.init, f.launch.envelope), receive, post)).rejects.toThrow('without its readiness');
    expect(receive).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled(); f.close();
  });
  it.each([undefined, HOST_ADAPTER_VERSION - 1, HOST_ADAPTER_VERSION + 1])('refuses stale Worker cancellation capability before memory delivery (%s)', async hostAdapter => {
    const f = fixture(), posts: any[] = [];
    await expect(receiveGroupedWorkerInitialization(createGroupedWorkerPrepare(f.expected),
      async () => ({ type: 'wrong' }), message => posts.push(message))).rejects.toThrow();
    const worker = new MockWorkerHandle(), ready = waitForGroupedWorkerReady(worker, f.expected);
    const message = { ...posts[0], hostAdapter };
    if (hostAdapter === undefined) delete message.hostAdapter;
    worker.simulateMessage(message);
    await expect(ready).rejects.toThrow();
    expect(worker.sentMessages).toHaveLength(0);
    f.close();
  });
  it.each([undefined, 0, 2])('refuses a Worker without the exact kernel replay protocol (%s)', async version => {
    const f = fixture(), posts: any[] = [];
    const pending = receiveGroupedWorkerInitialization(createGroupedWorkerPrepare(f.expected),
      async () => ({ type: 'wrong' }), message => posts.push(message));
    await expect(pending).rejects.toThrow();
    const worker = new MockWorkerHandle(), ready = waitForGroupedWorkerReady(worker, f.expected);
    const message = { ...posts[0], forkReplay: version };
    if (version === undefined) delete message.forkReplay;
    worker.simulateMessage(message);
    await expect(ready).rejects.toThrow();
    expect(worker.sentMessages).toHaveLength(0);
    f.close();
  });
  it.each([false, true])('acknowledges an exact pre-execution stop without guest storage (pthread=%s)', async thread => {
    const f = fixture();
    const task = { ...f.expected.receipt, tid: 101, serial: f.expected.receipt.serial + 1n };
    const launch = thread ? groupMemoryLayout({ receipt: task, memory: f.memory, replicaPage: 5 }).launch : f.launch;
    const { assertLive: _live, ...expected } = launch.expectation;
    const init = thread ? { ...f.init, type: 'centralized_thread_init', tid: 101 } : f.init;
    const message = createGroupedWorkerLaunch(init as any, launch.envelope);
    Atomics.store(new Int32Array(launch.envelope.memory.buffer,
      expected.replica + G.MEMORY_GROUP_REPLICA_RUN, 1), 0, 0);
    const received = await receiveGroupedWorkerInitialization(createGroupedWorkerPrepare(expected), async () => message, () => {});
    expect(received.stopped).toEqual(expected.receipt);
    expect(received.grouped).toBeUndefined(); expect(received.init).toBeUndefined();
    const events: unknown[] = [];
    await runWithProcessWorkerQuiescence({ postMessage: message => events.push(message), close: () => events.push('closed') },
      { pid: expected.receipt.pid, ...(thread ? { tid: 101 } : {}), memoryGroup: received.stopped }, async () => {}, () => {});
    expect(events).toEqual([{ type: 'memory_quiescent', pid: 100, ...(thread ? { tid: 101 } : {}), memoryGroup: expected.receipt }, 'closed']);
    f.close();
  });
  it.each(['serial', 'generation', 'pid', 'root', 'run'])('refuses a stopped launch with mismatched %s', async field => {
    const f = fixture(), message = createGroupedWorkerLaunch(f.init, f.launch.envelope);
    const view = new DataView(f.launch.envelope.memory.buffer, f.expected.replica, G.MEMORY_GROUP_REPLICA_BYTES);
    view.setUint32(G.MEMORY_GROUP_REPLICA_RUN, field === 'run' ? 2 : 0, true);
    if (field === 'serial') view.setBigUint64(G.MEMORY_GROUP_REPLICA_SERIAL, f.expected.receipt.serial + 1n, true);
    if (field === 'generation') view.setBigUint64(G.MEMORY_GROUP_REPLICA_GENERATION, f.expected.receipt.generation + 1n, true);
    if (field === 'pid') view.setUint32(G.MEMORY_GROUP_REPLICA_PID, 101, true);
    if (field === 'root') view.setUint32(G.MEMORY_GROUP_REPLICA_ROOT, f.expected.root + P, true);
    await expect(receiveGroupedWorkerInitialization(createGroupedWorkerPrepare(f.expected), async () => message, () => {})).rejects.toThrow();
    f.close();
  });
  it('rejects expectation getters before receiving or acknowledging anything', async () => {
    const get = vi.fn(), receive = vi.fn(), post = vi.fn();
    const value = { type: 'kandelo.memory-group.worker-prepare.v3', get expected() { get(); return {}; } };
    await expect(receiveGroupedWorkerInitialization(value, receive, post)).rejects.toThrow('accessors');
    expect(get).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it.each(['pid', 'memory'] as const)('rejects a second launch with mismatched %s', async field => {
    const f = fixture(), init: any = { ...f.init, [field]: field === 'pid' ? 101 : f.launch.envelope.memory };
    const message = { type: 'kandelo.memory-group.worker-launch.v3', init, envelope: f.launch.envelope };
    await expect(receiveGroupedWorkerInitialization(createGroupedWorkerPrepare(f.expected), async () => message, () => {})).rejects.toThrow('disagrees');
    f.close();
  });
  it('rejects stale readiness and leaves ownership with the caller', async () => {
    const f = fixture(), posts: any[] = [];
    const pending = receiveGroupedWorkerInitialization(createGroupedWorkerPrepare(f.expected), async () => ({ type: 'wrong' }), message => posts.push(message));
    await expect(pending).rejects.toThrow();
    const worker = new MockWorkerHandle(), terminate = vi.spyOn(worker, 'terminate');
    const ready = waitForGroupedWorkerReady(worker, f.expected);
    worker.simulateMessage({ ...posts[0], receipt: { ...f.expected.receipt, serial: f.expected.receipt.serial + 1n } });
    await expect(ready).rejects.toThrow('another admission'); expect(terminate).not.toHaveBeenCalled(); f.close();
  });
  it('times out readiness without claiming Worker retirement', async () => {
    vi.useFakeTimers(); const f = fixture(), worker = new MockWorkerHandle(), terminate = vi.spyOn(worker, 'terminate');
    const refusal = expect(waitForGroupedWorkerReady(worker, f.expected, 5)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5); await refusal;
    expect(terminate).not.toHaveBeenCalled(); f.close();
  });
  it.each([{ layout: 2 }, { threadAttach: 1 }, { maximumPages: 1 }, { accessProfile: 'research' }])('refuses incompatible executable metadata %j', patch => {
    const f = fixture(), runtime = new GroupedWorkerRuntime(f.launch.envelope, f.launch.expectation), bytes = artifact(patch);
    expect(() => runtime.validate(new WebAssembly.Module(bytes), bytes, 100, 100)).toThrow('Incompatible');
    runtime.detach(); f.close();
  });
  it('refuses a start section before binding controls or executing Wasm', () => {
    const f = fixture(), runtime = new GroupedWorkerRuntime(f.launch.envelope, f.launch.expectation), bytes = artifact({}, true);
    expect(() => runtime.validate(new WebAssembly.Module(bytes), bytes, 100, 100)).toThrow('defer its start');
    runtime.detach(); f.close();
  });
  it('rejects an original thread start before constructor patching can hide it', async () => {
    const f = fixture(), task = { ...f.expected.receipt, tid: 101, serial: f.expected.receipt.serial + 1n };
    const { launch } = groupMemoryLayout({ receipt: task, memory: f.memory, replicaPage: 5 });
    const runtime = new GroupedWorkerRuntime(launch.envelope, launch.expectation), events: any[] = [];
    await centralizedThreadWorkerMain({ postMessage: (message: unknown) => events.push(message) } as any, {
      type: 'centralized_thread_init', pid: 100, tid: 101, memory: runtime.memory, programBytes: artifact({}, true),
      processChannelOffset: 4096, channelOffset: 8192, secureExec: false, fnPtr: 0, argPtr: 0,
      stackPtr: 32768, tlsPtr: 0, ctidPtr: 0, tlsOffset: 16384, tlsAllocAddr: 16384,
    }, runtime);
    expect(events).toHaveLength(1); expect(events[0].type).toBe('error');
    expect(events[0].message).toContain('defer its start'); runtime.detach(); f.close();
  });
  it('keeps ordinary artifact refusal and admits only the explicit grouped extension policy', () => {
    const bytes = artifact();
    expect(describeWasmArtifactPolicyFailures(bytes).join(' ')).toContain('unsupported required program extension');
    expect(describeWasmArtifactPolicyFailures(bytes, { supportedProgramExtensions: GROUPED_WORKER_EXTENSIONS })).toEqual([]);
  });
  it('revokes storage before publishing an exact grouped terminal fence', async () => {
    const f = fixture(), runtime = new GroupedWorkerRuntime(f.launch.envelope, f.launch.expectation), events: any[] = [];
    await runWithProcessWorkerQuiescence({ postMessage: message => {
      expect(() => runtime.source.readBytes(0, 1)).toThrow(); events.push(message);
    }, close: () => events.push('close') }, { pid: 100, memoryGroup: f.expected.receipt }, async () => runtime.detach(), () => {});
    expect(events).toEqual([{ type: 'memory_quiescent', pid: 100, memoryGroup: f.expected.receipt }, 'close']); f.close();
  });
  it.each([false, true])('handles stop winning during a retirement-marker read (stop=%s)', async stopped => {
    const f = fixture(), runtime = new GroupedWorkerRuntime(f.launch.envelope, f.launch.expectation);
    const failure = Error('marker storage revoked');
    vi.spyOn(runtime.source, 'readBytes').mockImplementation(() => {
      if (stopped) Atomics.store(new Int32Array(runtime.memory.buffer,
        f.expected.replica + G.MEMORY_GROUP_REPLICA_RUN, 1), 0, 0);
      throw failure;
    });
    const post = vi.fn();
    const running = centralizedWorkerMain({ postMessage: post } as any,
      { ...f.init, memory: runtime.memory } as any, runtime);
    if (stopped) { await running; expect(post).not.toHaveBeenCalled(); }
    else await expect(running).rejects.toBe(failure);
    runtime.detach(); f.close();
  });
});
