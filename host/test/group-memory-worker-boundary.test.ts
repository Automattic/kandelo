import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import * as G from '../src/generated/program-extensions';
import { ABI_SYSCALLS, CHANNEL_STATUS_PENDING, CHANNEL_STATUS_COMPLETE, CH_STATUS, CH_SYSCALL, CH_RETURN, CH_REQUEST_FLAGS, CH_TOTAL_SIZE, ERRNO } from '../src/generated/abi';
import { WasmPosixKernel, getWasmPosixKernelRuntimeAccess } from '../src/kernel';
import { createCentralizedKernelWorkerTestDouble, CAPTURED_STDIO } from '../src/kernel-worker';
import { allocateKernelScratchRegion } from '../src/kernel-scratch';
import { resolveBinary } from '../src/binary-resolver';
import { VirtualPlatformIO } from '../src/vfs/vfs';
import { NodeTimeProvider } from '../src/vfs/time';
import { FixedTreeBackend } from './support/fixed-tree-backend';
import { retryKernelEntryResult } from '../src/kernel-entry-retry';
import { DeferredWorkerHandle } from '../src/deferred-worker-handle';
import { MockWorkerHandle } from '../src/worker-adapter';
import { GroupMemoryStorageRefusal } from '../src/group-memory-transport';

// The actual Rust kernel owns allocation and lifecycle here. The test-only
// bridge installs its exact gate/scratch on the host worker; no fake owner or
// copied allocator participates. SDK tests additionally run real guest Workers.
async function harness() {
  const io = new VirtualPlatformIO([{ mountPoint: '/', backend: new FixedTreeBackend({ '/': { mode: 0o040755, ino: 1 } }) }], new NodeTimeProvider());
  const config = { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true };
  const kernel = new WasmPosixKernel(config, io);
  await kernel.init(Uint8Array.from(readFileSync(resolveBinary('kernel.wasm'))));
  const access = getWasmPosixKernelRuntimeAccess(kernel), instance = access.instance()!;
  const scratch = allocateKernelScratchRegion(access.memory()!, instance.exports.kernel_alloc_scratch as (size: number) => number,
    CH_TOTAL_SIZE, 4, 'real kernel group host boundary', instance);
  const worker = createCentralizedKernelWorkerTestDouble({ config, io });
  worker.testAuthority.replaceKernelForScratchBoundaryTest(kernel);
  worker.testAuthority.initializeKernelForTest({ instance, gate: access.gate, mainScratch: scratch });
  expect(worker.configureMemoryGroups(32, 1)).toBe(0);
  const group = worker.createMemoryGroup(32, 8, 16); expect(group).toBeGreaterThan(0);
  expect(worker.createMemoryGroupBacking(group)).toBe(0);
  const pid = worker.createProcess(CAPTURED_STDIO);
  const receipt = worker.prepareMemoryGroupProcess(group, pid);
  if (typeof receipt === 'number') throw Error(`Admission refused: ${receipt}`);
  const handle = worker.prepareMemoryGroupImage(receipt, { initialVirtualPages: 4, maximumVirtualPages: 16, scratchBytes: 65536 });
  if (typeof handle === 'number') throw Error(`Image refused: ${handle}`);
  return { kernel, access, instance, scratch, worker, group, pid, receipt, handle };
}

function inspectBacking(h: Awaited<ReturnType<typeof harness>>) {
  const usage = h.worker.inspectMemoryGroupUsage(h.group);
  if (typeof usage === 'number') throw Error(`Inspection refused: errno ${-usage}`);
  if (!usage.backing) throw Error('Missing admitted backing');
  return usage.backing;
}

it('registers the actual Rust-owned image with an explicit virtual channel', async () => {
  const h = await harness();
  try {
    const launch = h.worker.publishMemoryGroupReplica(h.handle);
    if (typeof launch === 'number') throw Error(`Publication refused: ${launch}`);
    expect(launch.expectation.receipt).toEqual(h.receipt);
    expect(launch.source.byteLength).toBe(4 * 65536);
    h.worker.registerMemoryGroupProcess(h.handle, [65536], { brkBase: 3 * 65536,
      brkLimit: 16 * 65536, mmapBase: 4 * 65536, controlBase: 0, controlEnd: 3 * 65536, maxAddr: 16 * 65536 });
    expect(await retryKernelEntryResult(() => inspectBacking(h))).toMatchObject({ images: 1, replicas: 1, exposedReplicas: 1 });
    expect(await retryKernelEntryResult(() => h.worker.cancelUnexposedMemoryGroupReplica(h.handle))).toBe(-22);
    const concrete = new DeferredWorkerHandle(() => new MockWorkerHandle());
    await retryKernelEntryResult(() => h.worker.observeMemoryGroupReplicaWorker(h.handle, concrete, { terminationProvesQuiescence: false }));
    expect(await retryKernelEntryResult(() => h.worker.retireMemoryGroupUnstartedProcess(h.handle, concrete, () => {}))).toBe(true);
    expect(concrete.start()).toBe(false);
    expect(await retryKernelEntryResult(() => inspectBacking(h))).toMatchObject({ images: 0, replicas: 0, allocatedPages: 1, nativeObservers: 0 });
  } finally { h.scratch.revoke(); }
}, 30_000);

async function published() {
  const h = await harness();
  const launch = await retryKernelEntryResult(() => h.worker.publishMemoryGroupReplica(h.handle));
  if (typeof launch === 'number') throw Error(`Publication refused: ${launch}`);
  return { ...h, launch };
}

it('balances a late channel observation refused by Rust without failing the kernel or releasing custody', async () => {
  const h = await published();
  const worker = h.worker as any;
  try {
    // Register the actual Rust-owned image without arming a native listener;
    // inject only the scalar refusal at the platform marshalling boundary.
    worker.usePolling = true;
    h.worker.registerMemoryGroupProcess(h.handle, [65536], { brkBase: 3 * 65536,
      brkLimit: 16 * 65536, mmapBase: 4 * 65536, controlBase: 0, controlEnd: 3 * 65536, maxAddr: 16 * 65536 });
    worker.stopPolling(); worker.usePolling = false;
    const registration = worker.processes.get(h.pid), channel = registration.channels[0];
    const before = inspectBacking(h);
    const refuse = vi.spyOn(registration.grouped.store, 'prepareChannelObservation')
      .mockImplementationOnce(() => { throw new GroupMemoryStorageRefusal(ERRNO.ESRCH); });
    expect(() => worker.listenOnChannel(channel)).not.toThrow();
    expect(refuse).toHaveBeenCalledOnce(); refuse.mockRestore();
    expect(worker.pendingChannelListenerCounts.get(channel) ?? 0).toBe(0);
    expect(worker.pendingChannelNativeObservations.size).toBe(0);
    expect(inspectBacking(h)).toEqual(before);
    // The refusal cannot stand in for a Worker fence or return any frames.
    const concrete = new DeferredWorkerHandle(() => new MockWorkerHandle());
    h.worker.observeMemoryGroupReplicaWorker(h.handle, concrete, { terminationProvesQuiescence: false });
    expect(await h.worker.retireMemoryGroupUnstartedProcess(h.handle, concrete, () => {})).toBe(true);
    expect(inspectBacking(h)).toMatchObject({ images: 0, replicas: 0, allocatedPages: 1, nativeObservers: 0 });
  } finally { worker.stopPolling(); h.scratch.revoke(); }
}, 30_000);

it('reports allocator contention without poisoning inspection or changing ownership', async () => {
  const h = await published();
  const lock = new Int32Array(h.launch.envelope.memory.buffer, G.MEMORY_GROUP_CONTROL, 1);
  try {
    const before = h.worker.inspectMemoryGroupUsage(h.group);
    expect(typeof before).toBe('object');
    expect(Atomics.compareExchange(lock, 0, 0, 1)).toBe(0);
    try { expect(h.worker.inspectMemoryGroupUsage(h.group)).toBe(-ERRNO.EAGAIN); }
    finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
    expect(h.worker.inspectMemoryGroupUsage(h.group)).toEqual(before);
    expect(inspectBacking(h)).toMatchObject({ images: 1, replicas: 1, exposedReplicas: 1 });
  } finally { h.scratch.revoke(); }
}, 30_000);

it.each(['group', 'pid', 'tid', 'serial', 'generation'] as const)('contains a foreign terminal %s without freeing the real Rust allocation', async key => {
  const h = await published();
  try {
    const concrete = new MockWorkerHandle();
    h.worker.observeMemoryGroupReplicaWorker(h.handle, concrete, { terminationProvesQuiescence: false });
    const before = new Uint8Array(h.launch.envelope.memory.buffer, G.MEMORY_GROUP_BITMAP, G.MEMORY_GROUP_BITMAP_BYTES).slice();
    const forged = { ...h.receipt, [key]: typeof h.receipt[key] === 'bigint' ? h.receipt[key] as bigint ^ (1n << 40n) : Number(h.receipt[key]) + 1 };
    expect(() => concrete.simulateMessage({ type: 'memory_quiescent', pid: h.pid, memoryGroup: forged })).toThrow(/Wrong terminal/);
    expect(() => inspectBacking(h)).toThrow();
    expect(() => h.launch.source.readBytes(0, 1)).toThrow();
    // Fatal containment makes inspection unavailable. Read only the retained
    // test-owned backing to prove its allocation bits were not returned.
    expect(new Uint8Array(h.launch.envelope.memory.buffer, G.MEMORY_GROUP_BITMAP, G.MEMORY_GROUP_BITMAP_BYTES)).toEqual(before);
  } finally { h.scratch.revoke(); }
}, 30_000);

it.each([true, false])('accepts only the bound Worker fence or a concrete Node join (joins=%s)', async joins => {
  const h = await published();
  try {
    const concrete = new MockWorkerHandle(), other = new MockWorkerHandle();
    h.worker.observeMemoryGroupReplicaWorker(h.handle, concrete, { terminationProvesQuiescence: joins });
    const before = inspectBacking(h)!.allocatedPages;
    const fence = { type: 'memory_quiescent', pid: h.pid, memoryGroup: h.receipt };
    other.simulateMessage(fence);
    concrete.simulateMessage({ type: 'exit', pid: h.pid, status: 23 });
    expect(inspectBacking(h)).toMatchObject({ exposedReplicas: 1, allocatedPages: before });
    concrete.simulateExit(0);
    expect(inspectBacking(h)!.exposedReplicas).toBe(joins ? 0 : 1);
    concrete.simulateMessage(fence);
    concrete.simulateMessage(fence); concrete.simulateExit(0);
    await h.worker.waitForMemoryGroupReplicaQuiescence(h.handle);
    expect(inspectBacking(h)).toMatchObject({ exposedReplicas: 0, allocatedPages: before });
    // Worker quiescence alone cannot retire a Rust process which is still live.
    expect(await h.worker.retireMemoryGroupImage(h.handle, () => {})).toBe(-16);
  } finally { h.scratch.revoke(); }
}, 30_000);

it.each([true, false])('retains an uncertain constructor without inventing absence or a Node join (joins=%s)', async joins => {
  const h = await published();
  try {
    const concrete = new DeferredWorkerHandle(() => { throw Error('uncertain constructor'); });
    h.worker.observeMemoryGroupReplicaWorker(h.handle, concrete, { terminationProvesQuiescence: joins });
    const before = inspectBacking(h)!.allocatedPages;
    expect(() => concrete.start()).toThrow('uncertain constructor');
    await concrete.terminate();
    expect(h.worker.sealMemoryGroupReplicaWorkerAbsence(h.handle, concrete)).toBe(false);
    expect(inspectBacking(h)).toMatchObject({ exposedReplicas: 1, allocatedPages: before });
  } finally { h.scratch.revoke(); }
}, 30_000);

it('joins the exact asynchronous host closer before Rust returns image storage', async () => {
  const h = await published();
  try {
    const concrete = new DeferredWorkerHandle(() => new MockWorkerHandle());
    h.worker.observeMemoryGroupReplicaWorker(h.handle, concrete, { terminationProvesQuiescence: false });
    const before = inspectBacking(h)!.allocatedPages;
    let finish!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const called = new Promise<void>(resolve => { entered = resolve; });
    const close = vi.fn(() => { entered(); return pending; });
    const retirement = h.worker.retireMemoryGroupUnstartedProcess(h.handle, concrete, close);
    await called;
    expect(await retryKernelEntryResult(() => inspectBacking(h))).toMatchObject({ allocatedPages: before, images: 1 });
    finish(); expect(await retirement).toBe(true);
    expect(await h.worker.retireMemoryGroupImage(h.handle, close)).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(inspectBacking(h)).toMatchObject({ allocatedPages: 1, images: 0, nativeObservers: 0 });
  } finally { h.scratch.revoke(); }
}, 30_000);

it('retains the Rust allocation after a failed asynchronous host closer without repeating it', async () => {
  const h = await published();
  try {
    const concrete = new DeferredWorkerHandle(() => new MockWorkerHandle());
    h.worker.observeMemoryGroupReplicaWorker(h.handle, concrete, { terminationProvesQuiescence: false });
    const before = inspectBacking(h)!.allocatedPages;
    const close = vi.fn(async () => { throw Error('reference closer failed'); });
    await expect(h.worker.retireMemoryGroupUnstartedProcess(h.handle, concrete, close)).rejects.toThrow('reference closer failed');
    await expect(h.worker.retireMemoryGroupImage(h.handle, close)).rejects.toThrow('reference closer failed');
    expect(close).toHaveBeenCalledTimes(1);
    expect(inspectBacking(h)).toMatchObject({ allocatedPages: before, images: 1 });
  } finally { h.scratch.revoke(); }
}, 30_000);

it('returns scalar diagnostics and refuses actual allocator contention without blocking admission inspection', async () => {
  const h = await published();
  try {
    const before = h.worker.inspectMemoryGroupUsage(h.group);
    if (typeof before === 'number') throw Error(`Inspection refused: ${before}`);
    expect(Object.values(before.backing!).every(value => typeof value === 'number')).toBe(true);
    expect(Object.isFrozen(before) && Object.isFrozen(before.backing)).toBe(true);
    const lock = new Int32Array(h.launch.envelope.memory.buffer, G.MEMORY_GROUP_CONTROL, 1);
    expect(Atomics.compareExchange(lock, 0, 0, 1)).toBe(0);
    try {
      expect(h.worker.inspectMemoryGroupUsage(h.group)).toBe(-11);
      expect(h.worker.inspectMemoryGroup(h.group)).toMatchObject({ group: h.group, tasks: 1 });
      expect(Atomics.load(lock, 0)).toBe(1);
    } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
    expect(h.worker.inspectMemoryGroupUsage(h.group)).toEqual(before);
  } finally { h.scratch.revoke(); }
}, 30_000);

it('returns the actual never-exposed image only after exact Rust cancellation', async () => {
  const h = await harness();
  try {
    expect(inspectBacking(h)!.allocatedPages).toBeGreaterThan(1);
    expect(h.worker.cancelUnexposedMemoryGroupReplica(h.handle)).toBe(0);
    expect(inspectBacking(h)).toMatchObject({ allocatedPages: 1, images: 0, replicas: 0 });
    expect(h.worker.cancelUnexposedMemoryGroupReplica(h.handle)).toBe(-22);
  } finally { h.scratch.revoke(); }
}, 30_000);

for (const wake of ['notify', 'timeout'] as const) {
  it(`publishes a real Rust-owned completion after notification queue ${wake}`, async () => {
    const h = await published(), worker = h.worker as any;
    const source = h.launch.source;
    const queue = new Int32Array(h.launch.envelope.memory.buffer, G.MEMORY_GROUP_WAIT_HEADER, 1);
    const concrete = new DeferredWorkerHandle(() => new MockWorkerHandle());
    try {
      worker.usePolling = true;
      h.worker.registerMemoryGroupProcess(h.handle, [65536], { brkBase: 3 * 65536,
        brkLimit: 16 * 65536, mmapBase: 4 * 65536, controlBase: 0, controlEnd: 3 * 65536, maxAddr: 16 * 65536 });
      worker.stopPolling();
      h.worker.observeMemoryGroupReplicaWorker(h.handle, concrete, { terminationProvesQuiescence: false });
      const channel = worker.processes.get(h.pid).channels[0];
      source.atomicStoreI32(65536 + CH_SYSCALL, ABI_SYSCALLS.Getpid);
      source.atomicStoreI32(65536 + CH_REQUEST_FLAGS, 0);
      source.atomicStoreI32(65536 + CH_STATUS, CHANNEL_STATUS_PENDING);
      Atomics.store(queue, 0, 1);
      await retryKernelEntryResult(() => worker.handleSyscall(channel));
      expect(source.atomicLoadI32(65536 + CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
      expect(await retryKernelEntryResult(() => inspectBacking(h))).toMatchObject({ pendingCompletions: 1, nativeObservers: 1 });
      Atomics.store(queue, 0, 0);
      if (wake === 'notify') Atomics.notify(queue, 0);
      await expect.poll(() => source.atomicLoadI32(65536 + CH_STATUS)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(source.atomicLoadI32(65536 + CH_RETURN)).toBe(h.pid);
      await expect.poll(async () => (await retryKernelEntryResult(() => inspectBacking(h))).pendingCompletions).toBe(0);
      expect(await retryKernelEntryResult(() => inspectBacking(h))).toMatchObject({ nativeObservers: 0 });
      expect(await retryKernelEntryResult(() => h.worker.retireMemoryGroupUnstartedProcess(h.handle, concrete, () => {}))).toBe(true);
      expect(await retryKernelEntryResult(() => inspectBacking(h))).toMatchObject({ images: 0, replicas: 0, allocatedPages: 1, nativeObservers: 0 });
    } finally {
      Atomics.store(queue, 0, 0); Atomics.notify(queue, 0);
      worker.stopPolling(); h.scratch.revoke();
    }
  }, 30_000);
}
