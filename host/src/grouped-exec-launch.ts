import type { CentralizedKernelWorker } from './kernel-worker';
import type { PreparedExecLaunchPlan, PreparedExecLaunchRequest } from './exec-target';
import type { PreparedGroupReplica } from './memory-group-image-store';
import type { ForkExternrefGeneration } from './fork-reference-broker';
import type { ForkExternrefProcessOwner } from './fork-externref-process-owner';
import type { ForkHostImportOwnerRuntime, ForkHostImportOwnerWorker } from './fork-host-import-runtime';
import type { MemoryGroupTaskReceipt } from './memory-group-protocol';
import type { CentralizedWorkerInitMessage } from './worker-protocol';
import type { WorkerAdapter, WorkerHandle } from './worker-adapter';
import { DeferredWorkerHandle } from './deferred-worker-handle';
import { createGroupedWorkerLaunch, createGroupedWorkerPrepare, waitForGroupedWorkerReady } from './grouped-worker-initialization';
import { retryKernelEntryResult } from './kernel-entry-retry';

export interface GroupedExecWorkerOptions {
  readonly kernel: CentralizedKernelWorker;
  readonly request: PreparedExecLaunchRequest;
  readonly previousImage: PreparedGroupReplica;
  readonly previousWorkers: readonly WorkerHandle[];
  readonly previousGeneration: ForkExternrefGeneration;
  readonly externrefs: ForkExternrefProcessOwner;
  readonly imports: ForkHostImportOwnerRuntime;
  readonly adapter: WorkerAdapter;
  readonly terminationProvesQuiescence: boolean;
  readonly isCurrent: (worker: GroupedExecWorkerOwnership) => boolean;
  readonly retain: (worker: GroupedExecWorkerOwnership) => void;
  /** Mark the exact old execution intentional on the commit stack. */
  readonly onCommitted: () => void;
  readonly onStopped?: () => void | Promise<void>;
  /** Both images and old host references retired; kernel owns exit status. */
  readonly onTerminated?: (signal: number) => void;
  readonly retirePreviousReferences: () => void;
  readonly onRetired: (previous: PreparedGroupReplica, replacement: PreparedGroupReplica) => void;
  readonly onMessage: (message: any, worker: GroupedExecWorkerOwnership) => void;
  readonly onError: (error: Error, worker: GroupedExecWorkerOwnership) => void;
  readonly onExit: (code: number, worker: GroupedExecWorkerOwnership) => void;
}

/** One exact replacement realm. A numeric PID or shared physical Memory
 * cannot authorize terminal messages or release another exec generation. */
export class GroupedExecWorkerOwnership {
  private stopped = false;
  private joined = false;
  private released = false;
  private endpoint?: ForkHostImportOwnerWorker;
  private cleanup?: () => void;
  constructor(readonly pid: number, readonly handle: PreparedGroupReplica,
    readonly receipt: MemoryGroupTaskReceipt, readonly generation: ForkExternrefGeneration,
    readonly worker: DeferredWorkerHandle, private readonly owner: ForkExternrefProcessOwner,
    private readonly joins: boolean) {}
  get quiescent(): boolean { return this.stopped; }
  get hasJoined(): boolean { return this.joined; }
  attach(endpoint: ForkHostImportOwnerWorker, cleanup: () => void): void {
    this.endpoint = endpoint; this.cleanup = cleanup;
  }
  acceptQuiescence(message: any): void {
    if (message.pid !== this.pid || message.tid !== undefined) throw Error('Wrong terminal grouped exec Worker');
    for (const key of ['group', 'pid', 'tid', 'serial', 'generation'] as const) {
      if (message.memoryGroup?.[key] !== this.receipt[key]) throw Error('Wrong terminal grouped exec receipt');
    }
    this.stopped = true;
  }
  noteExit(): void { if (this.joins) this.joined = true; }
  async contain(): Promise<void> {
    await this.worker.terminate();
    if (this.joins && DeferredWorkerHandle.hasCompletedBackingTermination(this.worker)) this.joined = true;
  }
  releaseAfterStop(): boolean {
    if (this.released) return true;
    if (!this.stopped && !this.joined && !DeferredWorkerHandle.sealNeverStarted(this.worker)) return false;
    this.cleanup?.(); this.cleanup = undefined;
    this.endpoint?.close(); this.endpoint = undefined;
    this.owner.releaseGeneration(this.generation); this.released = true; return true;
  }
}

/** Shared Node/browser transition. Precommit allocates no realm and exposes
 * no future Memory; the kernel-owned backend owns its unconstructed rollback. */
export function prepareGroupedExecWorker(options: GroupedExecWorkerOptions): PreparedExecLaunchPlan {
  const { kernel, request } = options;
  const reservation = request.groupedExec;
  if (!reservation) throw Error('Grouped exec requires its opaque preparation');
  let consumed = false;
  return {
    onCommitFailure: () => { consumed = true; },
    startAfterCommit: async () => {
      if (consumed) throw Error('Grouped exec launch plan already consumed');
      consumed = true;
      try {
        const handoff = kernel.beginMemoryGroupExecHandoff(reservation);
        if (handoff.previousImage !== options.previousImage) throw Error('Grouped exec predecessor changed');
        options.onCommitted();
        const generation = options.externrefs.replaceGeneration(options.previousGeneration);
        await handoff.stopped;
        // A browser terminate call is used only after every exact image fence.
        await Promise.all(options.previousWorkers.map(worker => worker.terminate()));
        await options.onStopped?.();
        const retirePrevious = async (): Promise<void> => {
          for (;;) {
            const result = await retryKernelEntryResult(() => kernel.retireMemoryGroupImage(handoff.previousImage, () => {
              options.retirePreviousReferences(); options.externrefs.releaseGeneration(options.previousGeneration);
            }));
            if (result === 0) return;
            if (result !== -16) throw Error(`Cannot retire old grouped exec image: errno ${-result}`);
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
        };
        const signal = await retryKernelEntryResult(() => kernel.inspectMemoryGroupExecTermination(reservation));
        if (signal > 0) {
          await retryKernelEntryResult(() => kernel.cancelTerminatedMemoryGroupExec(reservation));
          await retirePrevious();
          options.externrefs.releaseGeneration(generation);
          await retryKernelEntryResult(() => kernel.finishMemoryGroupExecTermination(reservation));
          options.onTerminated?.(signal);
          return 0;
        }
        const launch = await retryKernelEntryResult(() => kernel.publishMemoryGroupReplica(handoff.replacementImage));
        if (typeof launch === 'number') throw Error(`Cannot publish grouped exec replacement: errno ${-launch}`);
        const layout = reservation.layout;
        await retryKernelEntryResult(() => kernel.registerMemoryGroupProcess(handoff.replacementImage, [layout.channelOffset], {
          ...layout, ptrWidth: 4, argv: request.argv, env: request.envp, preserveProcessState: true,
        }));
        await retirePrevious();
        options.onRetired(handoff.previousImage, handoff.replacementImage);
        const { assertLive: _live, ...expected } = launch.expectation;
        let ownership!: GroupedExecWorkerOwnership;
        let init!: Omit<CentralizedWorkerInitMessage, 'memory'>;
        const worker = new DeferredWorkerHandle(() => {
          const actual = options.adapter.createWorker(createGroupedWorkerPrepare(expected));
          void waitForGroupedWorkerReady(actual, expected).then(() => {
            if (!options.isCurrent(ownership)) throw Error('Stale grouped exec before memory launch');
            actual.postMessage(createGroupedWorkerLaunch(init, launch.envelope));
          }).catch(error => options.onError(error instanceof Error ? error : Error(String(error)), ownership));
          return actual;
        });
        ownership = new GroupedExecWorkerOwnership(request.pid, handoff.replacementImage, expected.receipt,
          generation, worker, options.externrefs, options.terminationProvesQuiescence);
        const endpoint = options.imports.createWorker({ pid: request.pid, generationId: generation.id,
          authorizeSender: () => { if (!options.isCurrent(ownership)) throw Error('Stale grouped exec host-import sender'); },
          onDiagnostic: error => options.onError(error instanceof Error ? error : Error(String(error)), ownership) });
        init = { type: 'centralized_init', pid: request.pid, programBytes: request.targetBytes,
          programModule: request.targetModule, channelOffset: layout.channelOffset, secureExec: handoff.secureExec,
          argv: request.argv, env: request.envp, ptrWidth: 4, externrefGenerationId: generation.id,
          forkHostImports: endpoint.init, kernelAbiVersion: kernel.getKernelAbiVersion(),
          kernelAbiContractDigest: kernel.getKernelAbiContractDigest() ?? undefined };
        const message = (value: any) => {
          if (value.type === 'fork_host_import') {
            if (!endpoint.dispatch(value.wake)) throw Error('Stale grouped exec host-import wake');
          } else {
            if (value.type === 'memory_quiescent') ownership.acceptQuiescence(value);
            options.onMessage(value, ownership);
          }
        };
        const error = (reason: Error) => options.onError(reason, ownership);
        const exit = (code: number) => { ownership.noteExit(); options.onExit(code, ownership); };
        worker.on('message', message); worker.on('error', error); worker.on('exit', exit);
        ownership.attach(endpoint, () => { worker.off('message', message); worker.off('error', error); worker.off('exit', exit); });
        options.retain(ownership);
        await retryKernelEntryResult(() => kernel.observeMemoryGroupReplicaWorker(handoff.replacementImage, worker,
          { terminationProvesQuiescence: options.terminationProvesQuiescence }));
        const disposition = await retryKernelEntryResult(() => kernel.startMemoryGroupProcessWorkerWhenRunnable(handoff.replacementImage,
          () => worker.start(), () => options.onError(Error('Grouped exec launch cancelled'), ownership),
          cause => kernel.containMemoryGroupExecFailure(cause)));
        if (disposition === 'stale' || disposition === 'dead') throw Error(`Grouped exec replacement is ${disposition}`);
        kernel.finishMemoryGroupExecHandoff(reservation);
        return 0;
      } catch (cause) { return kernel.containMemoryGroupExecFailure(cause); }
    },
  };
}
