import { afterEach, describe, expect, it, vi } from 'vitest';
import { KernelReentrantEntryError } from '../src/kernel-entry-gate';
import { OwnedJobs } from '../src/owned-jobs';

afterEach(() => vi.useRealTimers());
describe('owned command families', () => {
  it('waits for every worker to detach and retries reaping before reporting completion', () => {
    vi.useFakeTimers();
    const reap = vi.fn().mockImplementationOnce(() => { throw new KernelReentrantEntryError('owned job process reap'); });
    const jobs = new OwnedJobs(vi.fn(), 4096, reap);
    jobs.create('a', 10, 1000);
    jobs.inherit(10, 11);
    jobs.exited(11, 0);
    jobs.detached(11);
    expect(reap).not.toHaveBeenCalled(); // The parent may still wait for child 11.
    jobs.exited(10, 7);
    expect(jobs.read('a')).toMatchObject({ exitCode: 7, terminationObserved: false });
    jobs.detached(10);
    expect(reap).toHaveBeenCalledWith(new Set([10, 11]));
    expect(jobs.read('a').terminationObserved).toBe(false);
    vi.advanceTimersByTime(10);
    expect(jobs.read('a')).toMatchObject({ status: 'completed', terminationObserved: true });
    expect(reap).toHaveBeenCalledTimes(2);
  });

  it('keeps the first exit status when a member exit is reported twice', () => {
    const jobs = new OwnedJobs(vi.fn(), 4096);
    jobs.create('a', 10, 1000);
    jobs.exited(10, 0);
    jobs.exited(10, 137);
    jobs.detached(10);
    expect(jobs.read('a')).toMatchObject({ status: 'completed', exitCode: 0, terminationObserved: true });
    jobs.release('a');
  });

  it('reports a reap that fails for any reason but contention and completes the job once', () => {
    vi.useFakeTimers();
    const failure = new Error('foo');
    const reap = vi.fn(() => { throw failure; });
    const fail = vi.fn();
    const jobs = new OwnedJobs(vi.fn(), 4096, reap, fail);
    jobs.create('a', 10, 1000);
    jobs.exited(10, 0);
    jobs.detached(10);
    expect(jobs.read('a')).toMatchObject({ status: 'completed', terminationObserved: true });
    vi.advanceTimersByTime(1000);
    expect(reap).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(failure);
    jobs.release('a');
  });

  it.each(['cancelled', 'timed_out'] as const)('reaps the full %s family after asynchronous detachment', reason => {
    vi.useFakeTimers();
    const reap = vi.fn();
    const jobs = new OwnedJobs(vi.fn(), 4096, reap);
    jobs.create('a', 10, 100);
    jobs.inherit(10, 11);
    if (reason === 'timed_out') vi.advanceTimersByTime(100);
    else jobs.cancel('a');
    jobs.exited(10, 137);
    jobs.detached(10);
    jobs.exited(11, 137);
    expect(jobs.read('a')).toMatchObject({ status: 'cancelling', terminationObserved: false });
    jobs.detached(11);
    expect(reap).toHaveBeenCalledWith(new Set([10, 11]));
    expect(jobs.read('a')).toMatchObject({ status: reason, terminationObserved: true });
    vi.advanceTimersByTime(1000);
    expect(reap).toHaveBeenCalledTimes(1);
  });
  it('requires all descendants to exit and retries cancellation across launch gaps', () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const jobs = new OwnedJobs(kill);
    jobs.create('a', 10, 1000);
    jobs.inherit(10, 11);
    jobs.create('unrelated', 20, 1000);
    jobs.exited(10, 7);
    jobs.detached(10);
    expect(jobs.read('a')).toMatchObject({ status: 'running', exitCode: 7, terminationObserved: false });
    jobs.cancel('a');
    jobs.inherit(11, 12);
    jobs.exited(11, 137);
    jobs.detached(11);
    vi.advanceTimersByTime(10);
    expect(kill.mock.calls.map(call => call[0])).toEqual([11, 12]);
    jobs.exited(12, 137);
    jobs.detached(12);
    expect(jobs.read('a')).toMatchObject({ status: 'cancelled', exitCode: 7, terminationObserved: true });
    expect(jobs.read('unrelated')).toMatchObject({ status: 'running' });
    vi.advanceTimersByTime(10);
    expect(kill).toHaveBeenCalledTimes(2);
    jobs.exited(20, 0);
    jobs.detached(20);
  });
  it('retains a bounded mixed stream, expires old cursors and paginates without duplicates', () => {
    vi.useFakeTimers();
    const jobs = new OwnedJobs(() => {}, 5);
    jobs.create('a', 10, 1000);
    const enc = new TextEncoder();
    jobs.output(10, 'stdout', enc.encode('abc'));
    jobs.output(10, 'stderr', enc.encode('defg'));
    expect(jobs.read('a', 0)).toEqual({ expired: true, oldest: 2 });
    const first = jobs.read('a', undefined, 2);
    expect(first).toMatchObject({ next: 4, truncated: true, hasMore: true });
    if (first.expired) throw new Error('unexpected expiry');
    expect(first.chunks.map(chunk => [chunk.stream, new TextDecoder().decode(chunk.bytes)])).toEqual([['stdout', 'c'], ['stderr', 'd']]);
    const next = jobs.read('a', first.next, 2);
    expect(next).toMatchObject({ next: 6, hasMore: true });
    expect(() => jobs.read('a', 100)).toThrow('INVALID_CURSOR');
    jobs.exited(10, 0);
    jobs.detached(10);
  });
  it('refuses to release a live family and frees the slot once the family has terminated', () => {
    vi.useFakeTimers();
    const jobs = new OwnedJobs(vi.fn());
    jobs.create('a', 10, 1000);
    jobs.inherit(10, 11);
    jobs.exited(10, 0);
    jobs.detached(10);
    expect(() => jobs.release('a')).toThrow('JOB_RUNNING');
    jobs.exited(11, 0);
    jobs.detached(11);
    jobs.release('a');
    expect(() => jobs.read('a')).toThrow('UNKNOWN_JOB');
    expect(() => jobs.release('a')).toThrow('UNKNOWN_JOB');
    jobs.create('a', 12, 1000);
    expect(jobs.read('a')).toMatchObject({ pid: 12, status: 'running' });
  });
  it('keeps capacity available across more families than one computer may hold at once', () => {
    vi.useFakeTimers();
    const jobs = new OwnedJobs(vi.fn());
    for (let index = 0; index < 100; index++) {
      const pid = index + 1;
      jobs.create(`job-${index}`, pid, 1000);
      jobs.exited(pid, 0);
      jobs.detached(pid);
      jobs.release(`job-${index}`);
    }
    for (let index = 0; index < 64; index++) jobs.create(`live-${index}`, 1000 + index, 1000);
    expect(() => jobs.create('over', 2000, 1000)).toThrow('Job capacity reached (64 per computer)');
  });
  it('forgets a job whose root never launched and keeps every other job', () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const jobs = new OwnedJobs(kill);
    jobs.create('a', 10, 100);
    jobs.inherit(10, 11);
    jobs.abandon(11);
    jobs.abandon(99);
    expect(jobs.read('a')).toMatchObject({ pid: 10, status: 'running' });
    expect(() => jobs.create('a', 20, 100)).toThrow('Job ID already exists');
    jobs.abandon(20);
    expect(jobs.read('a')).toMatchObject({ pid: 10 });
    jobs.create('b', 30, 100);
    jobs.abandon(30);
    expect(() => jobs.read('b')).toThrow('UNKNOWN_JOB');
    vi.advanceTimersByTime(100);
    expect(kill).not.toHaveBeenCalledWith(30);
    for (let index = 0; index < 100; index++) {
      jobs.create(`refused-${index}`, 100 + index, 1000);
      jobs.abandon(100 + index);
    }
    jobs.create('c', 300, 1000);
    expect(jobs.read('c')).toMatchObject({ pid: 300, status: 'running' });
  });
  it('times out even when no client polls and does not change a completed job', () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const jobs = new OwnedJobs(kill);
    jobs.create('a', 10, 100);
    vi.advanceTimersByTime(100);
    expect(kill).toHaveBeenCalledWith(10);
    expect(jobs.read('a')).toMatchObject({ status: 'cancelling', terminationObserved: false });
    jobs.exited(10, 137);
    jobs.detached(10);
    expect(jobs.read('a')).toMatchObject({ status: 'timed_out', terminationObserved: true });
    jobs.cancel('a');
    expect(jobs.read('a')).toMatchObject({ status: 'timed_out' });
  });
});
