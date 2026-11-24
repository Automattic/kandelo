import { expect, it, vi } from 'vitest';
import { GroupedWorkerObjects } from '../src/grouped-worker-objects';
import { DeferredWorkerHandle } from '../src/deferred-worker-handle';
import { ForkExternrefProcessOwner } from '../src/fork-externref-process-owner';
import { ForkHostImportOwnerRuntime } from '../src/fork-host-import-runtime';
import { MockWorkerHandle } from '../src/worker-adapter';
import { groupMemoryLayout } from './support/group-memory-layout';

function objects(pthread = false, constructorFails = false) {
  const receipt = { group: 7, pid: 100, tid: pthread ? 101 : 100, serial: (1n << 55n) + 3n, generation: 7n };
  const fixture = groupMemoryLayout({ receipt });
  const owner = new ForkExternrefProcessOwner(), generation = owner.startGeneration(100);
  const worker = new DeferredWorkerHandle(() => {
    if (constructorFails) throw Error('uncertain constructor'); return new MockWorkerHandle();
  });
  const release = vi.fn(() => owner.releaseGeneration(generation));
  const execution = new GroupedWorkerObjects(fixture.handle, receipt, generation, worker, pthread ? undefined : release);
  const endpoint = new ForkHostImportOwnerRuntime(owner).createWorker({pid: 100, generationId: generation.id, authorizeSender: () => {}});
  const close = vi.spyOn(endpoint, 'close'), cleanup = vi.fn(); execution.attach(endpoint, cleanup);
  return { execution, fixture, receipt, worker, owner, close, cleanup, release };
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
  expect(() => h.worker.start()).toThrow(/constructor/); await h.execution.contain();
  expect(DeferredWorkerHandle.hasCompletedBackingTermination(h.worker)).toBe(false); expect(h.execution.executionAbsent).toBe(false);
  expect(h.close).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
  expect(() => h.owner.startGeneration(100)).toThrow(/live generation/); h.fixture.close();
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
