import { describe, expect, it, vi } from 'vitest';
import { reapOwnedJobExitedProcesses } from '../src/host-owned-process-reap';

describe('owned job process reaping', () => {
  it('reaps descendants before parents and tolerates already-reaped members', () => {
    const parents = new Map([[10, 0], [11, 10], [12, 11]]);
    const reap = vi.fn((parent: number, pid: number) => {
      expect(parents.get(pid)).toBe(parent);
      parents.delete(pid);
      return 0;
    });
    const instance = { exports: {
      kernel_get_parent_pid: (pid: number) => parents.get(pid) ?? -3,
      kernel_reap_exited_child: reap,
    } } as unknown as WebAssembly.Instance;
    reapOwnedJobExitedProcesses(instance, new Set([10, 11, 12, 13]));
    expect(reap.mock.calls).toEqual([[11, 12], [10, 11], [0, 10]]);
    reapOwnedJobExitedProcesses(instance, new Set([10, 11, 12, 13]));
    expect(reap).toHaveBeenCalledTimes(3);
  });

  it('refuses an unrelated guest parent and leaves running-state validation to Rust', () => {
    const reap = vi.fn(() => -10);
    const instance = { exports: {
      kernel_get_parent_pid: () => 99,
      kernel_reap_exited_child: reap,
    } } as unknown as WebAssembly.Instance;
    expect(() => reapOwnedJobExitedProcesses(instance, new Set([10]))).toThrow('unexpected parent 99');
    expect(reap).not.toHaveBeenCalled();
    expect(() => reapOwnedJobExitedProcesses(instance, new Set([99, 10]))).toThrow('errno 10');
  });
});
