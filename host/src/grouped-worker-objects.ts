import type { GroupReplicaLaunch, PreparedGroupReplica } from './group-memory-transport';
import type { ForkExternrefGeneration } from './fork-reference-broker';
import type { ForkHostImportOwnerWorker } from './fork-host-import-runtime';
import type { MemoryGroupTaskReceipt } from './memory-group-protocol';
import { DeferredWorkerHandle } from './deferred-worker-handle';
import { createGroupedWorkerLaunch, createGroupedWorkerPrepare, observeGroupedWorkerReady, type GroupedWorkerInit } from './grouped-worker-initialization';
import type { ProcessMemoryEnvelope } from './process-memory-descriptor';
import type { WorkerAdapter } from './worker-adapter';

interface WorkerPreparation {
  adapter: WorkerAdapter;
  launch: () => GroupReplicaLaunch;
  readinessTimeoutMs?: number;
}

/** Native objects and observations for one exact execution. These facts do
 * not grant release permission: the kernel invokes disposeReferences only
 * through its reference-detachment effect (or unconstructed cancellation). */
export class GroupedWorkerObjects {
  private stopped = false;
  private absent = false;
  private disposed = false;
  private endpoint?: ForkHostImportOwnerWorker;
  private cleanup?: () => void;
  private initialization?: {
    readiness: ReturnType<typeof observeGroupedWorkerReady>;
    envelope: ProcessMemoryEnvelope;
  };
  private constructorFailed = false;
  readonly worker: DeferredWorkerHandle;

  constructor(readonly handle: PreparedGroupReplica, readonly receipt: MemoryGroupTaskReceipt,
    readonly generation: ForkExternrefGeneration, preparation: WorkerPreparation,
    private releaseGeneration?: () => void) {
    this.worker = new DeferredWorkerHandle(() => {
      const launch = preparation.launch();
      const prepare = createGroupedWorkerPrepare(launch.expectation);
      this.constructorFailed = true;
      const worker = preparation.adapter.createWorker(prepare);
      this.constructorFailed = false;
      // Observe on the construction stack. Rust consumes this observation at
      // its readiness effect, which may arrive after the Worker has replied.
      const readiness = observeGroupedWorkerReady(worker, prepare, preparation.readinessTimeoutMs);
      void readiness.result.catch(() => {});
      this.initialization = { readiness, envelope: launch.envelope };
      return worker;
    });
  }

  get constructorUncertain(): boolean { return this.constructorFailed; }
  waitReady(): Promise<void> {
    if (!this.initialization) throw Error('Grouped readiness requires a constructed Worker');
    return this.initialization.readiness.result;
  }
  cancelReadiness(reason: Error): void {
    this.initialization?.readiness.cancel(reason);
  }
  deliverLaunch(init: GroupedWorkerInit): void {
    const prepared = this.initialization;
    if (!prepared || !this.worker.postMessageToStartedWorker(createGroupedWorkerLaunch(init, prepared.envelope))) {
      throw Error('Grouped launch lost its exact Worker');
    }
    this.initialization = undefined;
  }
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
    this.initialization?.readiness.cancel(Error('Kernel disposed grouped Worker readiness'));
    this.initialization = undefined;
    this.cleanup?.(); this.cleanup = undefined;
    this.endpoint?.close(); this.endpoint = undefined;
    this.releaseGeneration?.(); this.releaseGeneration = undefined; this.disposed = true;
  }
}
