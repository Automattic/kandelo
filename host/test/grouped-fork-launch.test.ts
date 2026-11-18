import { expect, it, vi } from 'vitest';
import { GroupedForkWorkerOwnership } from '../src/grouped-fork-launch';
import { DeferredWorkerHandle } from '../src/deferred-worker-handle';
import { ForkExternrefProcessOwner } from '../src/fork-externref-process-owner';
import { MockWorkerHandle } from '../src/worker-adapter';

const receipt = { group: 3, pid: 101, tid: 101, serial: 0x8000000100000003n, generation: 7n };
function ownership(joins: boolean) {
  const owner = new ForkExternrefProcessOwner(), generation = owner.startGeneration(101);
  const actual = new MockWorkerHandle(), worker = new DeferredWorkerHandle(() => actual);
  const child = new GroupedForkWorkerOwnership(101, receipt, generation, worker, owner, joins);
  const cleanup = vi.fn(); child.attachObserverCleanup(cleanup);
  return { owner, child, worker, cleanup };
}

it('seals a never-constructed child before releasing reference observers', () => {
  const h = ownership(false);
  expect(h.child.releaseAfterStop()).toBe(true);
  expect(h.worker.start()).toBe(false);
  expect(h.cleanup).toHaveBeenCalledTimes(1);
  expect(h.child.quiescent).toBe(false);
  expect(h.child.releaseAfterStop()).toBe(true);
  expect(h.cleanup).toHaveBeenCalledTimes(1);
});

it('retains reference custody after a constructor throws without a concrete Node join', async () => {
  const owner = new ForkExternrefProcessOwner(), generation = owner.startGeneration(101);
  const worker = new DeferredWorkerHandle(() => { throw Error('constructor lost its realm'); });
  const child = new GroupedForkWorkerOwnership(101, receipt, generation, worker, owner, true);
  const cleanup = vi.fn(); child.attachObserverCleanup(cleanup);
  expect(() => worker.start()).toThrow(/constructor/);
  await child.contain();
  expect(child.hasJoined).toBe(false);
  expect(child.releaseAfterStop()).toBe(false);
  expect(cleanup).not.toHaveBeenCalled();
  expect(() => owner.startGeneration(101)).toThrow(/live generation/);
});

it.each([true, false])('keeps constructed reference custody until a proven stop (Node join=%s)', async joins => {
  const h = ownership(joins); h.worker.start();
  expect(h.child.releaseAfterStop()).toBe(false);
  await h.child.contain();
  expect(h.child.hasJoined).toBe(joins);
  expect(h.child.releaseAfterStop()).toBe(joins);
  if (!joins) {
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(() => h.child.acceptQuiescence({ pid: 101, memoryGroup: { ...receipt, serial: 3n } })).toThrow(/receipt/);
    expect(h.child.releaseAfterStop()).toBe(false);
    h.child.acceptQuiescence({ pid: 101, memoryGroup: receipt });
    expect(h.child.releaseAfterStop()).toBe(true);
  }
  expect(h.cleanup).toHaveBeenCalledTimes(1);
  // The old generation has actually left the broker, allowing a fresh image.
  expect(() => h.owner.startGeneration(101)).not.toThrow();
});
