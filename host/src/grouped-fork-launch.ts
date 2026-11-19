import type { CentralizedKernelWorker, GroupedForkLaunchRequest } from './kernel-worker';
import type { ForkExternrefProcessOwner } from './fork-externref-process-owner';
import type { ForkExternrefGeneration } from './fork-reference-broker';
import type { ForkHostImportOwnerRuntime, ForkHostImportOwnerWorker } from './fork-host-import-runtime';
import { ForkReplayGateCoordinator, observeForkReplayWorker } from './fork-replay-gate';
import { DeferredWorkerHandle } from './deferred-worker-handle';
import { createGroupedWorkerLaunch, createGroupedWorkerPrepare, waitForGroupedWorkerReady } from './grouped-worker-initialization';
import { retryKernelEntryResult } from './kernel-entry-retry';
import { CH_TOTAL_SIZE, PROCESS_FORK_MODE_FORK } from './generated/abi';
import type { MemoryGroupTaskReceipt } from './memory-group-protocol';
import type { CentralizedWorkerInitMessage } from './worker-protocol';
import type { WorkerAdapter } from './worker-adapter';

export interface GroupedForkWorkerOptions {
  readonly kernel: CentralizedKernelWorker;
  readonly request: GroupedForkLaunchRequest;
  readonly adapter: WorkerAdapter;
  readonly externrefs: ForkExternrefProcessOwner;
  readonly imports: ForkHostImportOwnerRuntime;
  readonly parentGeneration: ForkExternrefGeneration;
  readonly programBytes: ArrayBuffer;
  readonly programModule?: WebAssembly.Module;
  readonly channelOffset: number;
  readonly maximumVirtualPages: number;
  /** Node joins a terminated Worker. Browser termination alone proves no stop. */
  readonly terminationProvesQuiescence: boolean;
  readonly isCurrent: (ownership: GroupedForkWorkerOwnership) => boolean;
  /** Retain ownership before any Worker constructor can run. */
  readonly retain: (ownership: GroupedForkWorkerOwnership) => void;
  readonly discard?: (ownership: GroupedForkWorkerOwnership) => void;
  readonly onMessage: (message: any, ownership: GroupedForkWorkerOwnership) => void;
  readonly onError: (error: Error, ownership: GroupedForkWorkerOwnership) => void;
  readonly onExit: (code: number, ownership: GroupedForkWorkerOwnership) => void;
  readonly replayTimeoutMs?: number;
}

/** Child realm/reference custody, not an ordinary allocator lease. Physical
 * pages stay with the image store until exact group retirement is integrated.
 * Keep this object in the disposable kernel realm through failed containment.
 */
export class GroupedForkWorkerOwnership {
  private stopped = false;
  private joined = false;
  private released = false;
  private endpoint?: ForkHostImportOwnerWorker;
  private releaseObservers?: () => void;
  constructor(readonly pid: number, readonly receipt: MemoryGroupTaskReceipt,
    readonly generation: ForkExternrefGeneration, readonly worker: DeferredWorkerHandle,
    private readonly owner: ForkExternrefProcessOwner, private readonly terminationProvesQuiescence: boolean) {}
  get quiescent(): boolean { return this.stopped; }
  get hasJoined(): boolean { return this.joined; }
  attachEndpoint(endpoint: ForkHostImportOwnerWorker): void {
    if (this.endpoint) throw Error('Fork import endpoint already attached'); this.endpoint = endpoint;
  }
  attachObserverCleanup(cleanup: () => void): void {
    if (this.releaseObservers) throw Error('Fork Worker observers already attached');
    this.releaseObservers = cleanup;
  }
  acceptQuiescence(message: any): void {
    if (message.pid !== this.pid || message.tid !== undefined) throw Error('Wrong grouped fork terminal Worker');
    for (const key of ['group', 'pid', 'tid', 'serial', 'generation'] as const) {
      if (message.memoryGroup?.[key] !== this.receipt[key]) throw Error('Wrong grouped fork terminal receipt');
    }
    this.stopped = true;
  }
  noteExit(): void { if (this.terminationProvesQuiescence) this.joined = true; }
  async contain(): Promise<void> {
    await this.worker.terminate();
    if (this.terminationProvesQuiescence && DeferredWorkerHandle.hasCompletedBackingTermination(this.worker)) {
      this.joined = true;
    }
  }
  /** Release only host-reference authority, never physical pages. */
  releaseAfterStop(): boolean {
    if (this.released) return true;
    if (!this.stopped && !this.joined && !DeferredWorkerHandle.sealNeverStarted(this.worker)) return false;
    this.releaseObservers?.(); this.releaseObservers = undefined;
    this.endpoint?.close(); this.endpoint = undefined;
    this.owner.releaseGeneration(this.generation); this.released = true; return true;
  }
}

/** Shared Node/browser fork launch. The dispatcher already paused/copied the
 * parent and allocated this exact Rust child; this function owns real normal
 * Worker construction and the existing continuation replay commit protocol.
 */
export async function launchGroupedForkWorker(options: GroupedForkWorkerOptions): Promise<GroupedForkWorkerOwnership> {
  const { kernel, request, externrefs, imports } = options;
  const replay = new ForkReplayGateCoordinator(`grouped fork child pid=${request.childPid}`);
  let ownership: GroupedForkWorkerOwnership | undefined;
  let generation: ForkExternrefGeneration | undefined;
  let endpoint: ForkHostImportOwnerWorker | undefined;
  let observed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // Acquire opaque reference custody before the first asynchronous launch
    // boundary. The parent image barrier still protects this continuation.
    generation = externrefs.forkGenerationFromContinuation(options.parentGeneration, request.childPid,
      request.parentSource, 4, request.continuation.forkBufAddr).generation;
    const published = await retryKernelEntryResult(() => kernel.publishMemoryGroupReplica(request.childReplica));
    if (typeof published === 'number') throw Error(`Cannot publish grouped fork child: errno ${-published}`);
    const { assertLive: _live, ...expected } = published.expectation;
    let init!: Omit<CentralizedWorkerInitMessage, 'memory'>;
    const worker = new DeferredWorkerHandle(() => {
      deadline = setTimeout(() => replay.cancel(new Error('Grouped fork replay deadline')), options.replayTimeoutMs ?? 30000);
      const actual = options.adapter.createWorker(createGroupedWorkerPrepare(expected));
      void waitForGroupedWorkerReady(actual, expected).then(() => {
        if (!options.isCurrent(ownership!)) throw Error('Stale grouped child before memory launch');
        actual.postMessage(createGroupedWorkerLaunch(init, published.envelope));
      }).catch(error => replay.cancel(error));
      return actual;
    });
    ownership = new GroupedForkWorkerOwnership(request.childPid, expected.receipt, generation, worker, externrefs,
      options.terminationProvesQuiescence);
    const exact = ownership;
    // Every published child gets its exact deferred-realm observer before
    // registration or reference setup can fail. Sealing that handle later
    // proves absence without treating publication as an execution ACK.
    await retryKernelEntryResult(() => kernel.observeMemoryGroupReplicaWorker(request.childReplica, worker,
      { terminationProvesQuiescence: options.terminationProvesQuiescence }));
    observed = true;
    options.retain(exact);
    endpoint = imports.createWorker({ pid: request.childPid, generationId: generation.id,
      authorizeSender: () => { if (!options.isCurrent(exact)) throw Error('Stale grouped fork host-import sender'); },
      onDiagnostic: error => {
        const committed = replay.currentPhase === 'committed'; replay.cancel(error);
        if (committed) options.onError(error instanceof Error ? error : new Error(String(error)), exact);
      } });
    ownership.attachEndpoint(endpoint);

    const releaseReplayObserver = observeForkReplayWorker(replay, worker, request.childPid, () => options.isCurrent(exact));
    const onMessage = (message: any): void => {
      try {
        if (message.type === 'fork_host_import') {
          if (!endpoint!.dispatch(message.wake)) throw Error('Stale grouped fork host-import wake');
        } else {
          if (message.type === 'memory_quiescent') exact.acceptQuiescence(message);
          if (message.type === 'error' && replay.currentPhase !== 'committed') replay.cancel(Error(String(message.message)));
          else options.onMessage(message, exact);
        }
      } catch (error) { const committed = replay.currentPhase === 'committed'; replay.cancel(error); if (committed) options.onError(error instanceof Error ? error : new Error(String(error)), exact); }
    };
    const onError = (error: Error): void => { const committed = replay.currentPhase === 'committed'; replay.cancel(error); if (committed) options.onError(error, exact); };
    const onExit = (code: number): void => { exact.noteExit(); if (replay.currentPhase === 'committed') options.onExit(code, exact); else if (code) replay.cancel(Error(`Grouped fork Worker exit ${code}`)); };
    worker.on('message', onMessage); worker.on('error', onError); worker.on('exit', onExit);
    ownership.attachObserverCleanup(() => {
      releaseReplayObserver(); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
    });
    published.source.fillBytes(options.channelOffset, CH_TOTAL_SIZE, 0);
    await retryKernelEntryResult(() => kernel.registerMemoryGroupProcess(request.childReplica, [options.channelOffset], {
      ptrWidth: 4, maxAddr: options.maximumVirtualPages * 65536, preserveProcessState: true,
    }));
    const secureExec = await retryKernelEntryResult(() => kernel.processSecureExec(request.childPid));
    init = { type: 'centralized_init', pid: request.childPid, programBytes: options.programBytes,
      programModule: options.programModule, channelOffset: options.channelOffset, secureExec, ptrWidth: 4,
      externrefGenerationId: generation.id, forkHostImports: endpoint.init,
      isForkChild: true, forkMode: PROCESS_FORK_MODE_FORK, forkBufAddr: request.continuation.forkBufAddr,
      forkReplayGate: replay.gate,
      forkChildThreadFnPtr: request.continuation.kind === 'thread' ? request.continuation.fnPtr : undefined,
      forkChildThreadArgPtr: request.continuation.kind === 'thread' ? request.continuation.argPtr : undefined,
      kernelAbiVersion: kernel.getKernelAbiVersion(), kernelAbiContractDigest: kernel.getKernelAbiContractDigest() ?? undefined };
    const disposition = await retryKernelEntryResult(() => kernel.startMemoryGroupProcessWorkerWhenRunnable(request.childReplica,
      () => worker.start(), () => replay.cancel(new Error('Grouped fork launch cancelled')),
      error => { replay.cancel(error); return true; }));
    if (disposition === 'stale' || disposition === 'dead') throw Error(`Grouped fork child is ${disposition}`);
    await replay.waitUntilReady(); replay.throwIfCancelled();
    if (!options.isCurrent(exact) || !await retryKernelEntryResult(() => kernel.shouldLaunchPendingChild(request.childPid))) {
      throw Error('Grouped fork child changed before replay commit');
    }
    replay.throwIfCancelled(); replay.commit(); return exact;
  } catch (error) {
    replay.cancel(error);
    if (ownership && observed) {
      const drainDeadline = Date.now() + (options.replayTimeoutMs ?? 30000);
      while (!await retryKernelEntryResult(() => kernel.requestMemoryGroupReplicaWorkerStop(request.childReplica, ownership!.worker))) {
        if (Date.now() >= drainDeadline) throw new Error('Failed grouped fork stop drain remains unproven', { cause: error });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      const stopped = kernel.waitForMemoryGroupReplicaQuiescence(request.childReplica);
      let stopDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([stopped, new Promise<void>(resolve => {
          stopDeadline = setTimeout(resolve, options.replayTimeoutMs ?? 30000);
        })]);
      } finally { if (stopDeadline) clearTimeout(stopDeadline); }
      await ownership.contain();
      // A deadline grants no reuse. Node may instead prove a real join;
      // unconfirmed browser/construction failures remain charged.
      if (!ownership.releaseAfterStop()) throw new Error('Failed grouped fork lacks exact stop proof', { cause: error });
      await stopped;
      if (!await retryKernelEntryResult(() => kernel.deactivateMemoryGroupProcess(request.childReplica))) {
        throw new Error('Grouped fork rollback no longer owns its child registration', { cause: error });
      }
      options.discard?.(ownership);
    } else {
      endpoint?.close();
      if (ownership) { await ownership.contain(); ownership.releaseAfterStop(); }
      else if (generation) externrefs.releaseGeneration(generation);
    }
    throw error;
  } finally { if (deadline) clearTimeout(deadline); }
}
