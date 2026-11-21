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
    retireMemoryGroupImage: async (_handle: unknown, retireReferences: () => void) => {
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
    contain: async () => {}, releaseAfterStop: () => true, generation: {id: 7},
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
