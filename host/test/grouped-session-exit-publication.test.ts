import { expect, it, vi } from 'vitest';
import { GroupedSessionRuntime } from '../src/grouped-session-runtime';
import { KernelReentrantEntryError } from '../src/kernel-entry-gate';
import type { CentralizedKernelWorker } from '../src/kernel-worker';
import type { WorkerAdapter } from '../src/worker-adapter';

it('waits for a deferred root reap when destroy starts after execution retirement', async () => {
  let allowReap = false;
  let attempted!: () => void;
  const firstAttempt = new Promise<void>(resolve => { attempted = resolve; });
  const reaper = vi.fn(() => {
    attempted();
    if (!allowReap) throw new KernelReentrantEntryError('held diagnostic kernel entry');
    return 'reaped' as const;
  });
  const kernel = {
    waitForMemoryGroupReplicaQuiescence: async () => {},
    deactivateMemoryGroupProcess: () => true,
    retireMemoryGroupImage: async (_handle: unknown, retireReferences: () => void = () => {}) => {
      retireReferences(); return 0;
    },
    reapHostOwnedExitedProcess: reaper,
    signalProcess: () => 0,
  } as unknown as CentralizedKernelWorker;
  const onExit = vi.fn(), report = vi.fn();
  const session = new GroupedSessionRuntime(kernel, {} as WorkerAdapter,
    {maximumPages: 8, maximumProcesses: 1, maximumTasks: 1}, false, onExit, report);
  // An already-stopped fixture owner: this test checks final publication
  // ownership, not Worker, memory or kernel execution semantics.
  const process: any = {pid: 123, handle: {}, owner: {
    contain: async () => {}, generation: {id: 7},
  }};
  (session as any).processes.set(123, process);
  expect(session.exit(123, 23)).toBe(true);
  await firstAttempt;
  let destroyed = false;
  const destruction = session.destroy().then(() => { destroyed = true; });
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(destroyed).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
  } finally {
    allowReap = true;
    await destruction;
    await process.retiring;
  }
  expect(onExit).toHaveBeenCalledExactlyOnceWith(123, 23, 7);
  expect(report).not.toHaveBeenCalled();
});

it('releases settled pthread retirement promises during sustained session churn', async () => {
  const kernel = {
    waitForMemoryGroupReplicaQuiescence: async () => {},
    retireMemoryGroupThread: async () => 0,
  } as unknown as CentralizedKernelWorker;
  const report = vi.fn();
  const session = new GroupedSessionRuntime(kernel, {} as WorkerAdapter,
    {maximumPages: 8}, false, vi.fn(), report);
  const state = session as any;
  state.processes.set(123, {pid: 123});
  for (let tid = 200; tid < 264; tid++) {
    state.threads.set(tid, {pid: 123, tid, handle: {}, referencesDisposed: false});
    expect(session.threadExit(123, tid)).toBe(true);
    const pending = state.threadRetirements.get(tid);
    expect(pending).toBeInstanceOf(Promise);
    expect(session.threadExit(123, tid)).toBe(true);
    await pending;
    expect(state.threads.size).toBe(0);
    expect(state.threadRetirements.size).toBe(0);
  }
  expect(report).not.toHaveBeenCalled();
});

it('releases failed retirement bookkeeping while preserving the thread for containment', async () => {
  const kernel = {
    waitForMemoryGroupReplicaQuiescence: async () => {},
    retireMemoryGroupThread: async () => -5,
    recordMemoryGroupCrash: vi.fn(() => 0),
  } as unknown as CentralizedKernelWorker;
  const report = vi.fn();
  const session = new GroupedSessionRuntime(kernel, {} as WorkerAdapter,
    {maximumPages: 8}, false, vi.fn(), report);
  const state = session as any, thread = {pid: 123, tid: 200, handle: {}, referencesDisposed: false};
  state.processes.set(123, {pid: 123}); state.threads.set(200, thread);
  expect(session.threadExit(123, 200)).toBe(true);
  await expect(state.threadRetirements.get(200)).rejects.toThrow('errno 5');
  expect(state.threadRetirements.size).toBe(0);
  expect(state.threads.get(200)).toBe(thread);
  expect(report).toHaveBeenCalledOnce();
});
