/** Worker-owned command families. Ownership survives exec, reparenting and setsid. */
export class OwnedJobs {
  private jobs = new Map<string, {
    root: number; members: Set<number>; pendingDetach: Set<number>; family: Set<number>; cleaned: boolean; exitCode: number | null;
    reason: 'cancelled' | 'timed_out' | null;
    chunks: Array<{ stream: 'stdout' | 'stderr'; bytes: Uint8Array }>;
    start: number; end: number; timer: ReturnType<typeof setTimeout>;
  }>();
  private owners = new Map<number, string>();
  constructor(private kill: (pid: number) => void, private retainedBytes = 256 * 1024, private reap: (pids: ReadonlySet<number>) => void = () => {}) {}

  create(id: string, pid: number, timeoutMs: number) {
    if (this.jobs.has(id)) throw new Error('Job ID already exists');
    if (this.jobs.size >= 64) throw new Error('Job capacity reached (64 per computer)');
    const timer = setTimeout(() => this.cancel(id, 'timed_out'), timeoutMs);
    this.jobs.set(id, { root: pid, members: new Set([pid]), pendingDetach: new Set([pid]), family: new Set([pid]), cleaned: false, exitCode: null, reason: null, chunks: [], start: 0, end: 0, timer });
    this.owners.set(pid, id);
  }
  inherit(parent: number, child: number) {
    const id = this.owners.get(parent);
    if (!id) return;
    this.owners.set(child, id);
    this.jobs.get(id)!.members.add(child);
    this.jobs.get(id)!.pendingDetach.add(child);
    this.jobs.get(id)!.family.add(child);
  }
  exited(pid: number, status: number) {
    const id = this.owners.get(pid);
    if (!id) return;
    const job = this.jobs.get(id)!;
    if (pid === job.root) job.exitCode = status;
    job.members.delete(pid);
    if (!job.members.size) clearTimeout(job.timer);
    this.cleanup(id);
  }
  /** Called only after the exact worker generation has detached. */
  detached(pid: number) {
    const id = this.owners.get(pid);
    if (!id) return;
    this.jobs.get(id)!.pendingDetach.delete(pid);
    this.cleanup(id);
  }
  private cleanup(id: string) {
    const job = this.require(id);
    if (job.cleaned || job.members.size || job.pendingDetach.size) return;
    clearTimeout(job.timer);
    try {
      // No live parent can still need waitpid's exit status. Keep the complete
      // family until here, including children that exited before their parent.
      this.reap(job.family);
      job.cleaned = true;
      for (const pid of job.family) this.owners.delete(pid);
    } catch {
      // Kernel entry contention must not turn signal delivery into completion.
      job.timer = setTimeout(() => this.cleanup(id), 10);
    }
  }
  output(pid: number, stream: 'stdout' | 'stderr', bytes: Uint8Array) {
    const id = this.owners.get(pid);
    if (!id || !bytes.length) return;
    const job = this.jobs.get(id)!;
    job.chunks.push({ stream, bytes: bytes.slice() });
    job.end += bytes.length;
    let excess = job.end - job.start - this.retainedBytes;
    while (excess > 0) {
      const chunk = job.chunks[0];
      const drop = Math.min(excess, chunk.bytes.length);
      if (drop === chunk.bytes.length) job.chunks.shift();
      else chunk.bytes = chunk.bytes.slice(drop);
      job.start += drop;
      excess -= drop;
    }
  }
  cancel(id: string, reason: 'cancelled' | 'timed_out' = 'cancelled') {
    const job = this.require(id);
    if (!job.members.size || job.reason) return;
    job.reason = reason;
    clearTimeout(job.timer);
    const drain = () => {
      // New children inherit ownership synchronously before any launch await.
      // Retry across launch/exec gaps and kernel entry contention. Completion
      // requires authoritative exit events for every member, not signal delivery.
      for (const pid of job.members) {
        try { this.kill(pid); } catch { /* retry while termination is pending */ }
      }
      if (job.members.size) job.timer = setTimeout(drain, 10);
    };
    drain();
  }
  read(id: string, offset?: number, limit = 4096) {
    const job = this.require(id);
    const cursor = offset ?? job.start;
    if (cursor < job.start) return { expired: true as const, oldest: job.start };
    if (!Number.isSafeInteger(cursor) || cursor > job.end) throw new Error('INVALID_CURSOR');
    const chunks: Array<{ stream: 'stdout' | 'stderr'; bytes: Uint8Array }> = [];
    let pos = job.start, remaining = limit;
    for (const chunk of job.chunks) {
      const from = Math.max(0, cursor - pos);
      const bytes = chunk.bytes.slice(from, from + remaining);
      if (bytes.length) { chunks.push({ stream: chunk.stream, bytes }); remaining -= bytes.length; }
      pos += chunk.bytes.length;
      if (!remaining) break;
    }
    const next = cursor + limit - remaining;
    return { expired: false as const, pid: job.root, status: !job.cleaned ? (job.reason ? 'cancelling' : 'running') : job.reason ?? 'completed', exitCode: job.exitCode, terminationObserved: job.cleaned, chunks, next, hasMore: next < job.end, truncated: offset === undefined && job.start > 0 };
  }
  private require(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('UNKNOWN_JOB');
    return job;
  }
}
