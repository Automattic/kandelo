import { expect, it, vi } from 'vitest';
import { GroupedThreadWorkerOwnership } from '../src/grouped-thread-launch';
import { DeferredWorkerHandle } from '../src/deferred-worker-handle';
import { MockWorkerHandle } from '../src/worker-adapter';
import { groupMemoryLayout } from './support/group-memory-layout';
import { ForkExternrefProcessOwner } from '../src/fork-externref-process-owner';
import { ForkHostImportOwnerRuntime } from '../src/fork-host-import-runtime';

function ownership(joins: boolean, constructorFails = false) {
  const main = { group: 7, pid: 100, tid: 100, serial: 1n, generation: 0n };
  const thread = { ...main, tid: 101, serial: (1n << 55n) + 3n };
  const fixture = groupMemoryLayout({ receipt: thread });
  const { handle, launch } = fixture;
  const worker = new DeferredWorkerHandle(() => { if (constructorFails) throw Error('uncertain constructor'); return new MockWorkerHandle(); });
  const child = new GroupedThreadWorkerOwnership(100, 101, { status: 'ready', handle, launch, processChannelOffset: 65536,
    allocation: { slotStartPage: 3, basePage: 3, tlsOffset: 3 * 65536, tlsAllocAddr: 3 * 65536, forkSaveOffset: 4 * 65536, channelOffset: 5 * 65536 } }, worker, joins);
  const owner = new ForkExternrefProcessOwner(), generation = owner.startGeneration(100);
  const endpoint = new ForkHostImportOwnerRuntime(owner).createWorker({ pid: 100, generationId: generation.id, authorizeSender: () => {} });
  const closed = vi.spyOn(endpoint, 'close'), cleanup = vi.fn(); child.attach(endpoint, cleanup);
  return { fixture, worker, child, owner, closed, cleanup, thread };
}

it('seals an absent pthread and closes only its endpoint, preserving the process generation', () => {
  const h = ownership(false), extent = h.fixture.memory.buffer.byteLength;
  expect(h.child.releaseAfterStop()).toBe(true); expect(h.worker.start()).toBe(false);
  expect(h.child.executionAbsent).toBe(true); expect(h.child.quiescent).toBe(true); expect(h.closed).toHaveBeenCalledTimes(1);
  expect(h.child.releaseAfterStop()).toBe(true); expect(h.cleanup).toHaveBeenCalledTimes(1);
  expect(() => h.owner.startGeneration(100)).toThrow(/live generation/);
  expect(h.fixture.memory.buffer.byteLength).toBe(extent); h.fixture.close();
});
it.each([true, false])('keeps pthread reference custody until exact proof (Node joins=%s)', async joins => {
  const h = ownership(joins); h.worker.start();
  expect(h.child.releaseAfterStop()).toBe(false); await h.child.contain();
  expect(h.child.hasJoined).toBe(joins); expect(h.child.releaseAfterStop()).toBe(joins);
  if (!joins) {
    expect(h.closed).not.toHaveBeenCalled();
    expect(() => h.child.acceptQuiescence({ pid: 100, tid: 102, memoryGroup: h.thread })).toThrow(/pthread/);
    expect(() => h.child.acceptQuiescence({ pid: 100, tid: 101, memoryGroup: { ...h.thread, serial: 3n } })).toThrow(/receipt/);
    expect(h.child.releaseAfterStop()).toBe(false);
    h.child.acceptQuiescence({ pid: 100, tid: 101, memoryGroup: h.thread });
    expect(h.child.releaseAfterStop()).toBe(true);
  }
  expect(h.closed).toHaveBeenCalledTimes(1); expect(h.cleanup).toHaveBeenCalledTimes(1);
  expect(() => h.owner.startGeneration(100)).toThrow(/live generation/); h.fixture.close();
});
it('does not invent a Node join after a constructor failed without returning a backing', async () => {
  const h = ownership(true, true);
  expect(() => h.worker.start()).toThrow(/constructor/); await h.child.contain();
  expect(h.child.hasJoined).toBe(false); expect(h.child.releaseAfterStop()).toBe(false);
  expect(h.closed).not.toHaveBeenCalled(); expect(h.cleanup).not.toHaveBeenCalled(); h.fixture.close();
});

it('joins the exact Node exit after quiescence and refuses a browser synthetic exit', async () => {
  const h = ownership(true); h.worker.start(); let settled = false;
  const joined = h.child.waitForNodeJoin().then(() => { settled = true; });
  h.child.acceptQuiescence({ pid: 100, tid: 101, memoryGroup: h.thread });
  await Promise.resolve(); expect(settled).toBe(false);
  h.child.noteExit(); await joined; expect(h.child.hasJoined).toBe(true);
  await h.child.waitForNodeJoin(); h.fixture.close();
  const browser = ownership(false); browser.worker.start(); browser.child.noteExit();
  await expect(browser.child.waitForNodeJoin()).rejects.toThrow(/cannot prove/);
  expect(browser.child.hasJoined).toBe(false); browser.fixture.close();
});
