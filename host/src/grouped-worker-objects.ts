import type { PreparedGroupReplica } from './group-memory-transport';
import type { ForkExternrefGeneration } from './fork-reference-broker';
import type { ForkHostImportOwnerWorker } from './fork-host-import-runtime';
import type { MemoryGroupTaskReceipt } from './memory-group-protocol';
import { DeferredWorkerHandle } from './deferred-worker-handle';

/** Native objects and observations for one exact execution. These facts do
 * not grant release permission: the kernel invokes disposeReferences only
 * through its reference-detachment effect (or unconstructed cancellation). */
export class GroupedWorkerObjects {
  private stopped = false;
  private absent = false;
  private disposed = false;
  private endpoint?: ForkHostImportOwnerWorker;
  private cleanup?: () => void;
  constructor(readonly handle: PreparedGroupReplica, readonly receipt: MemoryGroupTaskReceipt,
    readonly generation: ForkExternrefGeneration, readonly worker: DeferredWorkerHandle,
    private releaseGeneration?: () => void) {}
  get pid(): number { return this.receipt.pid; }
  get tid(): number { return this.receipt.tid; }
  get quiescent(): boolean { return this.stopped || this.absent; }
  get executionAbsent(): boolean { return this.absent; }
  get referencesDisposed(): boolean { return this.disposed; }
  attachEndpoint(endpoint: ForkHostImportOwnerWorker): void {
    if (this.endpoint) throw Error('Grouped Worker endpoint already attached'); this.endpoint = endpoint;
  }
  attachObserverCleanup(cleanup: () => void): void {
    if (this.cleanup) throw Error('Grouped Worker observers already attached'); this.cleanup = cleanup;
  }
  attach(endpoint: ForkHostImportOwnerWorker, cleanup: () => void): void {
    this.attachEndpoint(endpoint); this.attachObserverCleanup(cleanup);
  }
  acceptQuiescence(message: any): void {
    if (message.pid !== this.pid || message.tid !== (this.tid === this.pid ? undefined : this.tid)) {
      throw Error('Wrong terminal grouped Worker');
    }
    for (const key of ['group', 'pid', 'tid', 'serial', 'generation'] as const) {
      if (message.memoryGroup?.[key] !== this.receipt[key]) throw Error('Wrong terminal grouped Worker receipt');
    }
    this.stopped = true;
  }
  async contain(): Promise<void> {
    await this.worker.terminate();
  }
  /** Mechanical cleanup only. Eligibility is retained by ProcessTable, and
   * failure here leaves Rust's detachment acknowledgement outstanding. */
  disposeReferences(): void {
    if (this.disposed) return;
    this.absent = DeferredWorkerHandle.sealNeverStarted(this.worker);
    this.cleanup?.(); this.cleanup = undefined;
    this.endpoint?.close(); this.endpoint = undefined;
    this.releaseGeneration?.(); this.releaseGeneration = undefined; this.disposed = true;
  }
}
