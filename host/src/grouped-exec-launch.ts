import { GroupedWorkerObjects } from './grouped-worker-objects';
import type { CentralizedKernelWorker } from './kernel-worker';
import type { PreparedExecLaunchPlan, PreparedExecLaunchRequest } from './exec-target';
import type { PreparedGroupReplica } from './group-memory-transport';
import type { ForkExternrefGeneration } from './fork-reference-broker';
import type { ForkExternrefProcessOwner } from './fork-externref-process-owner';
import type { ForkHostImportOwnerRuntime } from './fork-host-import-runtime';
import type { CentralizedWorkerInitMessage } from './worker-protocol';
import type { WorkerAdapter } from './worker-adapter';
import { retryKernelEntryResult } from './kernel-entry-retry';

export interface GroupedExecWorkerOptions {
  readonly kernel: CentralizedKernelWorker;
  readonly request: PreparedExecLaunchRequest;
  readonly previousImage: PreparedGroupReplica;
  readonly previousGeneration: ForkExternrefGeneration;
  readonly externrefs: ForkExternrefProcessOwner;
  readonly imports: ForkHostImportOwnerRuntime;
  readonly adapter: WorkerAdapter;
  readonly terminationProvesQuiescence: boolean;
  readonly isCurrent: (worker: GroupedWorkerObjects) => boolean;
  readonly retain: (worker: GroupedWorkerObjects) => void;
  /** Mark the exact old execution intentional on the commit stack. */
  readonly onCommitted: () => void;
  readonly onStopped?: () => void | Promise<void>;
  /** Both images and old host references retired; kernel owns exit status. */
  readonly onTerminated?: (signal: number, status: number) => void;
  readonly retirePreviousReferences?: () => void | Promise<void>;
  readonly onRetired?: (previous: PreparedGroupReplica, replacement: PreparedGroupReplica) => void | Promise<void>;
  readonly onMessage: (message: any, worker: GroupedWorkerObjects) => void;
  readonly onError: (error: Error, worker: GroupedWorkerObjects) => void;
  readonly onExit: (code: number, worker: GroupedWorkerObjects) => void;
}


/** Shared Node/browser transition. Precommit allocates no realm and exposes
 * no future Memory; the kernel-owned backend owns its unconstructed rollback. */
export function prepareGroupedExecWorker(options: GroupedExecWorkerOptions): PreparedExecLaunchPlan {
  const { kernel, request } = options;
  const reservation = request.groupedExec;
  if (!reservation) throw Error('Grouped exec requires its opaque preparation');
  return {
    // No native objects are allocated before the actual Rust commit. The
    // exact exec operation owns cancellation and refuses repeated handoff.
    onCommitFailure: () => {},
    startAfterCommit: async () => {
      let generation!: ForkExternrefGeneration;
      let replacement!: GroupedWorkerObjects;
      let init!: Omit<CentralizedWorkerInitMessage, 'memory'>;
      let replacementExitObserver: ((code: number) => void) | undefined;
      try {
        return await kernel.runMemoryGroupExecHandoff(request, {
          detachPrevious: previous => {
            if (previous !== options.previousImage) throw Error('Grouped exec predecessor changed');
            options.onCommitted();
            generation = options.externrefs.replaceGeneration(options.previousGeneration);
          },
          previousWorkersJoined: options.onStopped,
          retirePreviousReferences: async () => {
            await options.retirePreviousReferences?.();
            options.externrefs.releaseGeneration(options.previousGeneration);
          },
          discardFuture: () => options.externrefs.releaseGeneration(generation),
          publishTermination: (signal, status) => options.onTerminated?.(signal, status),
          bindReplacement: async (handle, launch, secureExec) => {
            await options.onRetired?.(options.previousImage, handle);
            const ownership = new GroupedWorkerObjects(handle, launch.expectation.receipt, generation,
              { adapter: options.adapter, launch: () => launch, readinessTimeoutMs: 10000 },
              () => options.externrefs.releaseGeneration(generation));
            const { worker } = ownership;
            const endpoint = options.imports.createWorker({ pid: request.pid, generationId: generation.id,
              authorizeSender: () => { if (!options.isCurrent(ownership)) throw Error('Stale grouped exec host-import sender'); },
              onDiagnostic: error => options.onError(error instanceof Error ? error : Error(String(error)), ownership) });
            init = { type: 'centralized_init', pid: request.pid, programBytes: request.targetBytes,
              programModule: request.targetModule, channelOffset: reservation.layout.channelOffset, secureExec,
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
            const exit = (code: number) => { options.onExit(code, ownership); };
            replacementExitObserver = exit;
            worker.on('message', message); worker.on('error', error); worker.on('exit', exit);
            ownership.attach(endpoint, () => { worker.off('message', message); worker.off('error', error); worker.off('exit', exit); });
            options.retain(ownership);
            await retryKernelEntryResult(() => kernel.observeMemoryGroupReplicaWorker(handle, worker,
              { terminationProvesQuiescence: options.terminationProvesQuiescence, retireHostReferences: () => ownership.disposeReferences() }));
            replacement = ownership;
          },
          finishHandoff: () => kernel.finishProcessExecHandoff(request.pid),
          joinReplacement: async () => {
            // Rust requests this native join only after the exact stop fence.
            // Node terminate() can report 1; the runtime-exit callback must not
            // reinterpret that intentional native outcome as a guest crash.
            if (!replacementExitObserver) throw Error('Grouped exec has no bound exit observer');
            replacement.worker.off('exit', replacementExitObserver);
            await replacement.contain();
          },
          startReplacement: () => {
            if (!replacement.worker.start()) throw Error('Grouped exec Worker start cancelled');
          },
          waitReady: () => replacement.waitReady(),
          deliverLaunch: () => {
            if (!replacement || !options.isCurrent(replacement)) throw Error('Stale grouped exec before memory launch');
            replacement.deliverLaunch(init);
          },
        });
      } catch (cause) { return kernel.containMemoryGroupExecFailure(cause); }
    },
  };
}
