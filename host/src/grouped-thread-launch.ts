import { GroupedWorkerObjects } from './grouped-worker-objects';
import type { CentralizedKernelWorker, GroupedThreadChannelAttachment, GroupedThreadLaunch } from './kernel-worker';
import type { ForkExternrefGeneration } from './fork-reference-broker';
import type { ForkHostImportOwnerRuntime } from './fork-host-import-runtime';
import { DeferredWorkerHandle } from './deferred-worker-handle';
import { createGroupedWorkerLaunch, createGroupedWorkerPrepare, observeGroupedWorkerReady } from './grouped-worker-initialization';
import type { CentralizedThreadInitMessage } from './worker-protocol';
import type { WorkerAdapter, WorkerHandle } from './worker-adapter';

export interface GroupedThreadWorkerOptions {
  readonly kernel: CentralizedKernelWorker;
  readonly attachment: GroupedThreadChannelAttachment;
  readonly adapter: WorkerAdapter;
  readonly imports: ForkHostImportOwnerRuntime;
  readonly generation: ForkExternrefGeneration;
  readonly programBytes: ArrayBuffer;
  readonly terminationProvesQuiescence: boolean;
  readonly isCurrent: (thread: GroupedWorkerObjects) => boolean;
  readonly retain: (thread: GroupedWorkerObjects) => void;
  readonly discard: (thread: GroupedWorkerObjects) => void;
  readonly onMessage: (message: any, thread: GroupedWorkerObjects) => void;
  readonly onError: (error: Error, thread: GroupedWorkerObjects) => void;
  readonly onExit: (code: number, thread: GroupedWorkerObjects) => void;
}


/** Native objects for the actual kernel clone owner. This adapter neither
 * selects startup order nor authorizes rollback, delivery or reclamation. */
export async function launchGroupedThreadWorker(options: GroupedThreadWorkerOptions): Promise<GroupedWorkerObjects> {
  const { kernel, attachment } = options;
  let ownership!: GroupedWorkerObjects, plan!: GroupedThreadLaunch;
  let init!: Omit<CentralizedThreadInitMessage, 'memory'>;
  let native: WorkerHandle | undefined, factoryAttempted = false;
  let readiness: ReturnType<typeof observeGroupedWorkerReady> | undefined;
  let forward = false;
  const messages: any[] = [], errors: Error[] = [], exits: number[] = [];
  await kernel.runMemoryGroupThreadLaunch(attachment, {
    createObjects: (receipt, selected) => {
      plan = selected;
      const { assertLive: _live, ...expected } = plan.launch.expectation;
      const worker = new DeferredWorkerHandle(() => {
        factoryAttempted = true;
        native = options.adapter.createWorker(createGroupedWorkerPrepare(expected));
        readiness = observeGroupedWorkerReady(native, expected);
        void readiness.result.catch(() => {});
        return native;
      });
      ownership = new GroupedWorkerObjects(plan.handle, receipt, options.generation, worker);
    },
    bindWorker: () => {
      kernel.observeMemoryGroupReplicaWorker(plan.handle, ownership.worker,
        { terminationProvesQuiescence: options.terminationProvesQuiescence, retireHostReferences: () => ownership.disposeReferences() });
      options.retain(ownership);
    },
    connectImports: secureExec => {
      const exact = ownership;
      const endpoint = options.imports.createWorker({ pid: exact.pid, generationId: options.generation.id,
        authorizeSender: () => { if (!options.isCurrent(exact)) throw Error('Stale grouped thread host-import sender'); } });
      ownership.attachEndpoint(endpoint);
      const onMessage = (message: any): void => {
        try {
          if (message.type === 'fork_host_import') {
            if (!endpoint.dispatch(message.wake)) throw Error('Stale grouped thread host-import wake');
          } else {
            if (message.type === 'memory_quiescent') exact.acceptQuiescence(message);
            if (forward) options.onMessage(message, exact); else messages.push(message);
          }
        } catch (cause) {
          const error = cause instanceof Error ? cause : Error(String(cause));
          if (forward) options.onError(error, exact); else errors.push(error);
        }
      };
      const onError = (error: Error): void => { if (forward) options.onError(error, exact); else errors.push(error); };
      const onExit = (code: number): void => { if (forward) options.onExit(code, exact); else exits.push(code); };
      ownership.worker.on('message', onMessage); ownership.worker.on('error', onError); ownership.worker.on('exit', onExit);
      ownership.attachObserverCleanup(() => {
        readiness?.cancel(Error('Kernel disposed pthread readiness'));
        ownership.worker.off('message', onMessage); ownership.worker.off('error', onError); ownership.worker.off('exit', onExit);
        messages.length = errors.length = exits.length = 0;
      });
      init = { type: 'centralized_thread_init', pid: exact.pid, tid: exact.tid, programBytes: options.programBytes,
        processChannelOffset: plan.processChannelOffset, channelOffset: plan.allocation.channelOffset,
        secureExec, externrefGenerationId: options.generation.id, forkHostImports: endpoint.init,
        fnPtr: plan.entry.fnPtr, argPtr: plan.entry.argPtr, stackPtr: plan.entry.stackPtr, tlsPtr: plan.entry.tlsPtr,
        ctidPtr: plan.entry.ctidPtr, tlsOffset: plan.allocation.tlsOffset, tlsAllocAddr: plan.allocation.tlsOffset,
        ptrWidth: 4, kernelAbiVersion: kernel.getKernelAbiVersion(),
        kernelAbiContractDigest: kernel.getKernelAbiContractDigest() ?? undefined };
    },
    startWorker: () => { if (!ownership.worker.start()) throw Error('Native pthread constructor was cancelled'); },
    constructorUncertain: () => factoryAttempted && !native,
    waitReady: () => { if (!readiness) throw Error('Pthread readiness has no Worker'); return readiness.result; },
    installRuntimeListeners: () => {
      forward = true;
      for (const message of messages.splice(0)) options.onMessage(message, ownership);
      for (const error of errors.splice(0)) options.onError(error, ownership);
      for (const code of exits.splice(0)) options.onExit(code, ownership);
    },
    deliverLaunch: () => {
      if (!native || !options.isCurrent(ownership)) throw Error('Native pthread delivery lost its exact Worker');
      native.postMessage(createGroupedWorkerLaunch(init, plan.launch.envelope));
    },
    cancelNativeObservers: () => {
      forward = false;
      readiness?.cancel(Error('Kernel cancelled pthread readiness'));
      messages.length = errors.length = exits.length = 0;
    },
    contain: async () => { await ownership?.contain(); },
    disposeObjects: () => {
      if (ownership) { ownership.disposeReferences(); options.discard(ownership); }
      messages.length = errors.length = exits.length = 0;
    },
  });
  return ownership;
}
