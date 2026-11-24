import { GroupedWorkerObjects } from './grouped-worker-objects';
import type { CentralizedKernelWorker, GroupedThreadChannelAttachment, GroupedThreadLaunch } from './kernel-worker';
import type { ForkExternrefGeneration } from './fork-reference-broker';
import type { ForkHostImportOwnerRuntime } from './fork-host-import-runtime';
import { DeferredWorkerHandle } from './deferred-worker-handle';
import { createGroupedWorkerLaunch, createGroupedWorkerPrepare, waitForGroupedWorkerReady } from './grouped-worker-initialization';
import { retryKernelEntryResult } from './kernel-entry-retry';
import type { CentralizedThreadInitMessage } from './worker-protocol';
import type { WorkerAdapter } from './worker-adapter';

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


/** Shared production thread launch. Only this exact clone capability selects
 * the image; physical Memory is transported solely to its disposable Worker. */
export async function launchGroupedThreadWorker(options: GroupedThreadWorkerOptions): Promise<GroupedWorkerObjects> {
  const { kernel, attachment } = options;
  const secureExec = await retryKernelEntryResult(() => kernel.processSecureExec(attachment.pid));
  let plan: GroupedThreadLaunch;
  for (;;) {
    const prepared = await retryKernelEntryResult(() => kernel.prepareMemoryGroupThreadLaunch(attachment));
    if (typeof prepared === 'number') throw Error(`Cannot prepare grouped pthread: errno ${-prepared}`);
    if (prepared.status === 'waiting') { await prepared.progress; continue; }
    plan = prepared; break;
  }
  let ownership!: GroupedWorkerObjects;
  let init!: Omit<CentralizedThreadInitMessage, 'memory'>;
  const { assertLive: _live, ...expected } = plan.launch.expectation;
  const worker = new DeferredWorkerHandle(() => {
    const actual = options.adapter.createWorker(createGroupedWorkerPrepare(expected));
    void waitForGroupedWorkerReady(actual, expected).then(() => {
      if (!options.isCurrent(ownership)) throw Error('Stale grouped thread before memory launch');
      actual.postMessage(createGroupedWorkerLaunch(init, plan.launch.envelope));
    }).catch(error => options.onError(error instanceof Error ? error : Error(String(error)), ownership));
    return actual;
  });
  ownership = new GroupedWorkerObjects(plan.handle, plan.launch.expectation.receipt, options.generation, worker, options.terminationProvesQuiescence);
  const exact = ownership;
  let observed = false;
  try {
    await retryKernelEntryResult(() => kernel.observeMemoryGroupReplicaWorker(plan.handle, worker,
      { terminationProvesQuiescence: options.terminationProvesQuiescence, retireHostReferences: () => exact.disposeReferences() }));
    observed = true;
    const endpoint = options.imports.createWorker({ pid: exact.pid, generationId: options.generation.id,
      authorizeSender: () => { if (!options.isCurrent(exact)) throw Error('Stale grouped thread host-import sender'); } });
    const onMessage = (message: any): void => {
      try {
        if (message.type === 'fork_host_import') {
          if (!endpoint.dispatch(message.wake)) throw Error('Stale grouped thread host-import wake');
        } else {
          if (message.type === 'memory_quiescent') exact.acceptQuiescence(message);
          options.onMessage(message, exact);
        }
      } catch (error) { options.onError(error instanceof Error ? error : Error(String(error)), exact); }
    };
    const onError = (error: Error): void => options.onError(error, exact);
    const onExit = (code: number): void => { exact.noteExit(); options.onExit(code, exact); };
    worker.on('message', onMessage); worker.on('error', onError); worker.on('exit', onExit);
    ownership.attach(endpoint, () => {
      worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
    });
    init = { type: 'centralized_thread_init', pid: exact.pid, tid: exact.tid, programBytes: options.programBytes,
      processChannelOffset: plan.processChannelOffset, channelOffset: plan.allocation.channelOffset,
      secureExec, externrefGenerationId: options.generation.id, forkHostImports: endpoint.init,
      fnPtr: plan.entry.fnPtr, argPtr: plan.entry.argPtr, stackPtr: plan.entry.stackPtr, tlsPtr: plan.entry.tlsPtr,
      ctidPtr: plan.entry.ctidPtr, tlsOffset: plan.allocation.tlsOffset, tlsAllocAddr: plan.allocation.tlsOffset,
      ptrWidth: 4, kernelAbiVersion: kernel.getKernelAbiVersion(),
      kernelAbiContractDigest: kernel.getKernelAbiContractDigest() ?? undefined };
    options.retain(exact);
    let startError: unknown;
    const disposition = await retryKernelEntryResult(() => kernel.startMemoryGroupThreadWorkerWhenRunnable(plan.handle,
      () => worker.start(), () => { startError ??= Error('Grouped thread start cancelled'); },
      error => { startError = error; return true; }));
    if (startError) throw startError;
    if (disposition === 'stale' || disposition === 'dead') throw Error(`Grouped thread is ${disposition}`);
    return exact;
  } catch (error) {
    // Seal only this observed handle. A constructor attempt is uncertainty,
    // even if terminate() resolves without a returned concrete Worker.
    const absent = observed && await retryKernelEntryResult(() => kernel.sealMemoryGroupReplicaWorkerAbsence(plan.handle, worker));
    if (absent) await kernel.releaseMemoryGroupWorkerReferences(plan.handle);
    await exact.contain();
    if (await kernel.releaseMemoryGroupWorkerReferences(plan.handle)) {
      if (observed) await kernel.waitForMemoryGroupReplicaQuiescence(plan.handle);
      options.discard(exact);
    }
    // The kernel's allocated-clone rollback now owns physical retirement.
    // Awaiting that clone's retirement here would wait on this same callback.
    throw error;
  }
}
