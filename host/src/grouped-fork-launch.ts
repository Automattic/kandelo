import { GroupedWorkerObjects } from './grouped-worker-objects';
import type { CentralizedKernelWorker, GroupedForkLaunchRequest } from './kernel-worker';
import type { ForkExternrefProcessOwner } from './fork-externref-process-owner';
import type { ForkExternrefGeneration } from './fork-reference-broker';
import type { ForkHostImportOwnerRuntime, ForkHostImportOwnerWorker } from './fork-host-import-runtime';
import { DeferredWorkerHandle } from './deferred-worker-handle';
import { createGroupedWorkerLaunch, createGroupedWorkerPrepare, observeGroupedWorkerReady } from './grouped-worker-initialization';
import { MEMORY_GROUP_PROTOCOL, PROCESS_FORK_MODE_FORK } from './generated/abi';
import type { CentralizedWorkerInitMessage } from './worker-protocol';
import type { WorkerAdapter, WorkerHandle } from './worker-adapter';
import type { GroupReplicaLaunch } from './group-memory-transport';
import { MemoryGroupProtocolFault } from './memory-group-protocol';

export interface GroupedForkWorkerOptions {
  readonly kernel: CentralizedKernelWorker;
  readonly request: GroupedForkLaunchRequest;
  readonly adapter: WorkerAdapter;
  readonly externrefs: ForkExternrefProcessOwner;
  readonly imports: ForkHostImportOwnerRuntime;
  readonly parentGeneration: ForkExternrefGeneration;
  readonly programBytes: ArrayBuffer;
  readonly programModule?: WebAssembly.Module;
  readonly maximumVirtualPages: number;
  /** Node joins a terminated Worker. Browser termination alone proves no stop. */
  readonly terminationProvesQuiescence: boolean;
  readonly isCurrent: (ownership: GroupedWorkerObjects) => boolean;
  /** Retain ownership before any Worker constructor can run. */
  readonly retain: (ownership: GroupedWorkerObjects) => void;
  readonly discard?: (ownership: GroupedWorkerObjects) => void;
  readonly onMessage: (message: any, ownership: GroupedWorkerObjects) => void;
  readonly onError: (error: Error, ownership: GroupedWorkerObjects) => void;
  readonly onExit: (code: number, ownership: GroupedWorkerObjects) => void;
}


/** Native objects for a fork retained by the actual kernel operation. No
 * replay phase, deadline, rollback choice or release permission lives here. */
export async function launchGroupedForkWorker(options: GroupedForkWorkerOptions): Promise<GroupedWorkerObjects> {
  const { kernel, request, externrefs, imports } = options;
  let ownership!: GroupedWorkerObjects;
  let generation: ForkExternrefGeneration | undefined, endpoint: ForkHostImportOwnerWorker | undefined;
  let launch!: GroupReplicaLaunch, init!: Omit<CentralizedWorkerInitMessage, 'memory'>;
  let native: WorkerHandle | undefined, factoryAttempted = false, observed = false;
  let readiness: ReturnType<typeof observeGroupedWorkerReady> | undefined;
  let replayResult!: Promise<void>, replayReady!: () => void, replayError!: (error: Error) => void;
  let forward: ((message: any) => void) | undefined;
  const messages: any[] = [];
  const errors: Error[] = [], exits: number[] = [];
  await kernel.runMemoryGroupForkLaunch(request, {
    createObjects: receipt => {
      generation = externrefs.forkGenerationFromContinuation(options.parentGeneration, request.childPid,
        request.parentSource, 4, request.continuation.forkBufAddr).generation;
      replayResult = new Promise<void>((resolve, reject) => { replayReady = resolve; replayError = reject; });
      void replayResult.catch(() => {});
      const worker = new DeferredWorkerHandle(() => {
        const { assertLive: _live, ...expected } = launch.expectation;
        factoryAttempted = true;
        native = options.adapter.createWorker(createGroupedWorkerPrepare(expected));
        readiness = observeGroupedWorkerReady(native, expected);
        void readiness.result.catch(() => {});
        return native;
      });
      ownership = new GroupedWorkerObjects(request.childReplica, receipt, generation, worker,
        () => externrefs.releaseGeneration(generation!));
    },
    publishTransport: value => { launch = value; },
    bindWorker: () => {
      kernel.observeMemoryGroupReplicaWorker(request.childReplica, ownership.worker,
        { terminationProvesQuiescence: options.terminationProvesQuiescence, retireHostReferences: () => ownership.disposeReferences() });
      observed = true;
      options.retain(ownership);
    },
    registerProcess: () => kernel.registerMemoryGroupProcess(request.childReplica, [request.channelOffset], {
      ptrWidth: 4, maxAddr: options.maximumVirtualPages * 65536, preserveProcessState: true }),
    connectImports: secureExec => {
      endpoint = imports.createWorker({ pid: request.childPid, generationId: generation!.id,
        authorizeSender: () => { if (!options.isCurrent(ownership)) throw Error('Stale grouped fork host-import sender'); },
        onDiagnostic: error => {
          const failure = error instanceof Error ? error : Error(String(error));
          if (forward) options.onError(failure, ownership); else { errors.push(failure); replayError(failure); }
        } });
      ownership.attachEndpoint(endpoint);
      const onMessage = (message: any): void => {
        try {
          if (message.type === 'fork_host_import') {
            if (!endpoint!.dispatch(message.wake)) throw Error('Stale grouped fork host-import wake');
          } else if (message.type === 'fork_replay_ready') {
            if (message.pid !== request.childPid || !options.isCurrent(ownership)) throw new MemoryGroupProtocolFault('Wrong grouped fork replay sender');
            replayReady();
          } else {
            if (message.type === 'memory_quiescent') ownership.acceptQuiescence(message);
            if (forward) forward(message);
            else {
              if (messages.length === MEMORY_GROUP_PROTOCOL.driver.native_event_limit) throw new MemoryGroupProtocolFault('Unconsumed native fork messages');
              messages.push(message);
              if (message.type === 'error' || message.type === 'exit' || message.type === 'memory_quiescent') replayError(Error('Grouped fork Worker terminated before replay commit'));
            }
          }
        } catch (cause) {
          const error = cause instanceof Error ? cause : Error(String(cause));
          if (forward) options.onError(error, ownership); else { errors.push(error); replayError(error); }
        }
      };
      const onError = (error: Error) => { if (forward) options.onError(error, ownership); else { errors.push(error); replayError(error); } };
      const onExit = (code: number) => { if (forward) options.onExit(code, ownership); else { exits.push(code); replayError(Error(`Grouped fork native exit ${code}`)); } };
      ownership.worker.on('message', onMessage); ownership.worker.on('error', onError); ownership.worker.on('exit', onExit);
      ownership.attachObserverCleanup(() => {
        readiness?.cancel(Error('Kernel disposed native fork readiness'));
        ownership.worker.off('message', onMessage); ownership.worker.off('error', onError); ownership.worker.off('exit', onExit);
        messages.length = errors.length = exits.length = 0;
      });
      init = { type: 'centralized_init', pid: request.childPid, programBytes: options.programBytes,
        programModule: options.programModule, channelOffset: request.channelOffset, secureExec, ptrWidth: 4,
        externrefGenerationId: generation!.id, forkHostImports: endpoint.init,
        isForkChild: true, forkMode: PROCESS_FORK_MODE_FORK, forkBufAddr: request.continuation.forkBufAddr,
        forkChildThreadFnPtr: request.continuation.kind === 'thread' ? request.continuation.fnPtr : undefined,
        forkChildThreadArgPtr: request.continuation.kind === 'thread' ? request.continuation.argPtr : undefined,
        kernelAbiVersion: kernel.getKernelAbiVersion(), kernelAbiContractDigest: kernel.getKernelAbiContractDigest() ?? undefined };
    },
    startWorker: () => { if (!ownership.worker.start()) throw Error('Native fork constructor was cancelled'); },
    constructorUncertain: () => factoryAttempted && !native,
    waitReady: () => { if (!readiness) throw Error('Native fork readiness has no Worker'); return readiness.result; },
    deliverLaunch: () => {
      if (!native || !options.isCurrent(ownership)) throw Error('Native fork launch lost its Worker');
      native.postMessage(createGroupedWorkerLaunch(init, launch.envelope, kernel.wasmModules));
    },
    waitReplay: () => replayResult,
    installRuntimeListeners: () => {
      forward = message => options.onMessage(message, ownership);
      for (const message of messages.splice(0)) forward(message);
      for (const error of errors.splice(0)) options.onError(error, ownership);
      for (const code of exits.splice(0)) options.onExit(code, ownership);
    },
    cancelNativeObservers: () => {
      readiness?.cancel(Error('Kernel cancelled native fork readiness'));
      replayError?.(Error('Kernel cancelled native fork replay'));
    },
    sealAbsence: () => {
      if (!observed) {
        kernel.observeMemoryGroupReplicaWorker(request.childReplica, ownership.worker,
          { terminationProvesQuiescence: options.terminationProvesQuiescence, retireHostReferences: () => ownership.disposeReferences() });
        observed = true;
      }
      kernel.sealMemoryGroupReplicaWorkerAbsence(request.childReplica, ownership.worker);
    },
    contain: async () => { await ownership?.contain(); },
    disposeObjects: () => {
      if (ownership) { ownership.disposeReferences(); options.discard?.(ownership); }
      else { endpoint?.close(); if (generation) externrefs.releaseGeneration(generation); }
      messages.length = errors.length = exits.length = 0;
    },
  });
  return ownership;
}
