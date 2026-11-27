import { expect, it, vi } from 'vitest';
import { GroupedWorkerObjects } from '../src/grouped-worker-objects';
import { receiveGroupedWorkerInitialization } from '../src/grouped-worker-initialization';
import { DeferredWorkerHandle } from '../src/deferred-worker-handle';
import { ForkExternrefProcessOwner } from '../src/fork-externref-process-owner';
import { ForkHostImportOwnerRuntime } from '../src/fork-host-import-runtime';
import { MockWorkerAdapter } from '../src/worker-adapter';
import { groupMemoryLayout } from './support/group-memory-layout';

function objects(pthread = false, constructorFails = false) {
  const receipt = { group: 7, pid: 100, tid: pthread ? 101 : 100, serial: (1n << 55n) + 3n, generation: 7n };
  const fixture = groupMemoryLayout({ receipt });
  const owner = new ForkExternrefProcessOwner(), generation = owner.startGeneration(100);
  const adapter = new MockWorkerAdapter();
  if (constructorFails) vi.spyOn(adapter, 'createWorker').mockImplementation(() => { throw Error('uncertain constructor'); });
  const release = vi.fn(() => owner.releaseGeneration(generation));
  const execution = new GroupedWorkerObjects(fixture.handle, receipt, generation,
    { adapter, launch: () => fixture.launch }, pthread ? undefined : release);
  const endpoint = new ForkHostImportOwnerRuntime(owner).createWorker({pid: 100, generationId: generation.id, authorizeSender: () => {}});
  const close = vi.spyOn(endpoint, 'close'), cleanup = vi.fn(); execution.attach(endpoint, cleanup);
  return { execution, fixture, receipt, worker: execution.worker, owner, close, cleanup, release, adapter };
}

it.each([false, true])('disposes kernel-selected objects once and preserves a pthread generation=%s', pthread => {
  const h = objects(pthread);
  // The real kernel authorization is exercised by native and real-kernel
  // tests; this test covers execution of the mechanical disposal callback.
  h.execution.disposeReferences(); h.execution.disposeReferences();
  expect(h.worker.start()).toBe(false);
  expect(h.execution.executionAbsent).toBe(true);
  expect(h.cleanup).toHaveBeenCalledTimes(1); expect(h.close).toHaveBeenCalledTimes(1);
  expect(h.release).toHaveBeenCalledTimes(pthread ? 0 : 1);
  if (pthread) expect(() => h.owner.startGeneration(100)).toThrow(/live generation/);
  else expect(() => h.owner.startGeneration(100)).not.toThrow();
  h.fixture.close();
});
it('executes termination without releasing references', async () => {
  const h = objects(); h.worker.start(); await h.execution.contain();
  expect(DeferredWorkerHandle.hasCompletedBackingTermination(h.worker)).toBe(true);
  expect(h.close).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
  h.fixture.close();
});
it('does not turn a constructor exception into absence or a Node join', async () => {
  const h = objects(false, true);
  expect(() => h.worker.start()).toThrow(/constructor/);
  expect(h.execution.constructorUncertain).toBe(true);
  await h.execution.contain();
  expect(DeferredWorkerHandle.hasCompletedBackingTermination(h.worker)).toBe(false); expect(h.execution.executionAbsent).toBe(false);
  expect(h.close).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
  expect(() => h.owner.startGeneration(100)).toThrow(/live generation/); h.fixture.close();
});

it('observes readiness from construction and delivers only to the exact started Worker', async () => {
  const h = objects();
  const init = { type: 'centralized_init' as const, pid: 100, programBytes: new ArrayBuffer(0), channelOffset: 4096, secureExec: false };
  expect(() => h.execution.deliverLaunch(init)).toThrow('lost its exact Worker');
  expect(h.worker.start()).toBe(true);
  const native = h.adapter.lastWorker!;
  let receiveLaunch!: (value: unknown) => void;
  const initialized = receiveGroupedWorkerInitialization(h.adapter.lastWorkerData,
    () => new Promise(resolve => { receiveLaunch = resolve; }), ready => native.simulateMessage(ready));
  expect(native.sentMessages).toHaveLength(0);
  await h.execution.waitReady();
  h.execution.deliverLaunch(init);
  expect(native.sentMessages).toHaveLength(1);
  receiveLaunch(native.sentMessages[0]);
  const result = await initialized;
  expect(result.init?.memory).toBe(h.fixture.memory);
  result.grouped?.detach();
  expect(() => h.execution.deliverLaunch(init)).toThrow('lost its exact Worker');
  expect(native.sentMessages).toHaveLength(1);
  await h.execution.contain();
  h.execution.disposeReferences();
  h.fixture.close();
});

it('refuses a pending memory delivery after native termination', async () => {
  const h = objects();
  const init = { type: 'centralized_init' as const, pid: 100, programBytes: new ArrayBuffer(0), channelOffset: 4096, secureExec: false };
  h.worker.start();
  await h.execution.contain();
  expect(() => h.execution.deliverLaunch(init)).toThrow('lost its exact Worker');
  expect(h.adapter.lastWorker?.sentMessages).toHaveLength(0);
  h.execution.disposeReferences();
  h.fixture.close();
});

it('cancels the pending readiness observation when its references are disposed', async () => {
  const h = objects();
  expect(h.worker.start()).toBe(true);
  const native = h.adapter.lastWorker!, off = vi.spyOn(native, 'off');
  const ready = h.execution.waitReady();
  h.execution.disposeReferences();
  await expect(ready).rejects.toThrow('disposed grouped Worker readiness');
  expect(off.mock.calls.map(([event]) => event)).toEqual(['message', 'error', 'exit']);
  expect(h.execution.quiescent).toBe(false);
  expect(DeferredWorkerHandle.hasCompletedBackingTermination(h.worker)).toBe(false);
  h.fixture.close();
});
it.each([false, true])('binds terminal observations to the exact process/pthread receipt=%s', pthread => {
  const h = objects(pthread); h.worker.start();
  const message = {pid: 100, tid: pthread ? 101 : undefined, memoryGroup: h.receipt};
  expect(() => h.execution.acceptQuiescence({...message, pid: 101})).toThrow(/Worker/);
  expect(() => h.execution.acceptQuiescence({...message, memoryGroup:{...h.receipt, serial: 3n}})).toThrow(/receipt/);
  expect(h.execution.quiescent).toBe(false);
  h.execution.acceptQuiescence(message); expect(h.execution.quiescent).toBe(true);
  expect(h.close).not.toHaveBeenCalled(); h.fixture.close();
});
it('keeps terminal observation and reference disposal separate from native termination', async () => {
  const h = objects(true); h.worker.start();
  h.execution.acceptQuiescence({pid: 100, tid: 101, memoryGroup: h.receipt});
  expect(DeferredWorkerHandle.hasCompletedBackingTermination(h.worker)).toBe(false);
  h.execution.disposeReferences();
  expect(h.execution.referencesDisposed).toBe(true);
  expect(DeferredWorkerHandle.hasCompletedBackingTermination(h.worker)).toBe(false);
  await h.execution.contain();
  expect(DeferredWorkerHandle.hasCompletedBackingTermination(h.worker)).toBe(true);
  h.fixture.close();
});
