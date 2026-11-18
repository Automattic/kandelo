import type { CentralizedKernelWorker, GroupedThreadChannelAttachment, GroupedThreadLaunch } from './kernel-worker';
import type { ForkExternrefGeneration } from './fork-reference-broker';
import type { ForkHostImportOwnerRuntime, ForkHostImportOwnerWorker } from './fork-host-import-runtime';
import { DeferredWorkerHandle } from './deferred-worker-handle';
import { createGroupedWorkerLaunch, createGroupedWorkerPrepare, waitForGroupedWorkerReady } from './grouped-worker-initialization';
import { retryKernelEntryResult } from './kernel-entry-retry';
import type { MemoryGroupTaskReceipt } from './memory-group-protocol';
import type { CentralizedThreadInitMessage } from './worker-protocol';
import type { ThreadPageAllocator } from './thread-allocator';
import type { WorkerAdapter } from './worker-adapter';

export interface GroupedThreadWorkerOptions {
  readonly kernel: CentralizedKernelWorker;
  readonly attachment: GroupedThreadChannelAttachment;
  readonly allocator: ThreadPageAllocator;
  readonly adapter: WorkerAdapter;
  readonly imports: ForkHostImportOwnerRuntime;
  readonly generation: ForkExternrefGeneration;
  readonly programBytes: ArrayBuffer;
  readonly terminationProvesQuiescence: boolean;
  readonly isCurrent: (thread: GroupedThreadWorkerOwnership) => boolean;
  readonly retain: (thread: GroupedThreadWorkerOwnership) => void;
  readonly onMessage: (message: any, thread: GroupedThreadWorkerOwnership) => void;
  readonly onError: (error: Error, thread: GroupedThreadWorkerOwnership) => void;
  readonly onExit: (code: number, thread: GroupedThreadWorkerOwnership) => void;
}

/** Thread realm custody shares the process's externref generation. Its import
 * endpoint ends independently; neither process generation nor slots/pages are
 * released here. Exact observer/channel retirement remains a separate gate. */
export class GroupedThreadWorkerOwnership {
  private stopped = false;
  private joined = false;
  private released = false;
  private endpoint?: ForkHostImportOwnerWorker;
  private cleanup?: () => void;
  readonly receipt: MemoryGroupTaskReceipt;
  constructor(readonly pid: number, readonly tid: number, plan: GroupedThreadLaunch,
    readonly worker: DeferredWorkerHandle, private readonly joins: boolean) {
    this.receipt = plan.launch.expectation.receipt;
  }
  get quiescent(): boolean { return this.stopped; }
  get hasJoined(): boolean { return this.joined; }
  attach(endpoint: ForkHostImportOwnerWorker, cleanup: () => void): void {
    this.endpoint = endpoint; this.cleanup = cleanup;
  }
  acceptQuiescence(message: any): void {
    if (message.pid !== this.pid || message.tid !== this.tid) throw Error('Wrong terminal grouped pthread');
    for (const key of ['group', 'pid', 'tid', 'serial', 'generation'] as const) {
      if (message.memoryGroup?.[key] !== this.receipt[key]) throw Error('Wrong terminal grouped pthread receipt');
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
    this.released = true; return true;
  }
}

/** Shared production thread launch. Only this exact clone capability selects
 * the image; physical Memory is transported solely to its disposable Worker. */
export async function launchGroupedThreadWorker(options: GroupedThreadWorkerOptions): Promise<GroupedThreadWorkerOwnership> {
  const { kernel, attachment } = options;
  options.allocator.assertCanAllocate();
  const control = await retryKernelEntryResult(() => kernel.reserveMemoryGroupThreadControl(attachment));
  if (control < 0) throw Error(`Cannot reserve grouped pthread controls: errno ${-control}`);
  let plan: GroupedThreadLaunch;
  for (;;) {
    const prepared = await retryKernelEntryResult(() => kernel.prepareMemoryGroupThreadLaunch(attachment, options.allocator));
    if (typeof prepared === 'number') throw Error(`Cannot prepare grouped pthread: errno ${-prepared}`);
    if (prepared.status === 'waiting') { await prepared.progress; continue; }
    plan = prepared; break;
  }
  const secureExec = await retryKernelEntryResult(() => kernel.processSecureExec(attachment.pid));
  let ownership!: GroupedThreadWorkerOwnership;
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
  ownership = new GroupedThreadWorkerOwnership(attachment.pid, attachment.tid, plan, worker, options.terminationProvesQuiescence);
  const exact = ownership;
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
    fnPtr: attachment.fnPtr, argPtr: attachment.argPtr, stackPtr: attachment.stackPtr, tlsPtr: attachment.tlsPtr,
    ctidPtr: attachment.ctidPtr, tlsOffset: plan.allocation.tlsOffset, tlsAllocAddr: plan.allocation.tlsOffset,
    ptrWidth: 4, kernelAbiVersion: kernel.getKernelAbiVersion(),
    kernelAbiContractDigest: kernel.getKernelAbiContractDigest() ?? undefined };
  options.retain(exact);
  try {
    await retryKernelEntryResult(() => kernel.observeMemoryGroupReplicaWorker(plan.handle, worker,
      { terminationProvesQuiescence: options.terminationProvesQuiescence }));
    let startError: unknown;
    const disposition = await retryKernelEntryResult(() => kernel.startMemoryGroupThreadWorkerWhenRunnable(plan.handle,
      () => worker.start(), () => { startError ??= Error('Grouped thread start cancelled'); },
      error => { startError = error; return true; }));
    if (startError) throw startError;
    if (disposition === 'stale' || disposition === 'dead') throw Error(`Grouped thread is ${disposition}`);
    return exact;
  } catch (error) {
    await exact.contain(); exact.releaseAfterStop(); throw error;
  }
}
