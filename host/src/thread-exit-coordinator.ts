export interface ThreadExitCompletion {
  joinFutexAddr?: number;
  clearTidFutexAddr?: number;
}

export type ThreadTerminator = (completion?: ThreadExitCompletion) => Promise<void>;

/**
 * Coordinates pthread SYS_exit notifications with host Worker termination.
 *
 * Starting a Worker is not atomic with installing all host bookkeeping: a very
 * short-lived pthread can reach SYS_exit before its terminator is registered.
 * The kernel must still abandon that syscall channel so guest code cannot run
 * past SYS_exit and race pthread_join() stack reclamation.
 */
export class ThreadExitCoordinator {
  private terminators = new Map<string, ThreadTerminator>();
  private pendingExits = new Map<string, ThreadExitCompletion | undefined>();

  register(pid: number, channelOffset: number, terminate: ThreadTerminator): void {
    const key = this.key(pid, channelOffset);
    this.terminators.set(key, terminate);
    if (this.pendingExits.has(key)) {
      const completion = this.pendingExits.get(key);
      this.pendingExits.delete(key);
      void terminate(completion);
    }
  }

  release(pid: number, channelOffset: number): void {
    const key = this.key(pid, channelOffset);
    this.terminators.delete(key);
    this.pendingExits.delete(key);
  }

  requestExit(
    pid: number,
    channelOffset: number,
    completion?: ThreadExitCompletion,
  ): boolean {
    const key = this.key(pid, channelOffset);
    const terminate = this.terminators.get(key);
    if (!terminate) {
      this.pendingExits.set(key, completion);
      return true;
    }
    void terminate(completion);
    return true;
  }

  private key(pid: number, channelOffset: number): string {
    return `${pid}:${channelOffset}`;
  }
}
