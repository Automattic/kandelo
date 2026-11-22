import { CentralizedKernelWorker, type CentralizedKernelCallbacks } from './kernel-worker';
import { computeProcessMemoryLayout } from './process-memory';
import { extractHeapBase } from './constants';
import * as G from './generated/program-extensions';
import { ERRNO } from './generated/abi';
import { ThreadPageAllocator } from './thread-allocator';
import { ForkExternrefProcessOwner } from './fork-externref-process-owner';
import { ForkHostImportOwnerRuntime } from './fork-host-import-runtime';
import type { PreparedGroupReplica, GroupReplicaLaunch } from './memory-group-image-store';
import type { WorkerAdapter } from './worker-adapter';
import { DeferredWorkerHandle } from './deferred-worker-handle';
import { GroupedExecWorkerOwnership, prepareGroupedExecWorker } from './grouped-exec-launch';
import { GroupedForkWorkerOwnership, launchGroupedForkWorker } from './grouped-fork-launch';
import { GroupedThreadWorkerOwnership, launchGroupedThreadWorker } from './grouped-thread-launch';
import { createGroupedWorkerPrepare, createGroupedWorkerLaunch, waitForGroupedWorkerReady } from './grouped-worker-initialization';
import { retryKernelEntryResult as retry } from './kernel-entry-retry';
import type { MemoryGroupUsage } from './memory-group-usage';
import type { CentralizedWorkerInitMessage } from './worker-protocol';

/** Explicit embedder-only opt-in. Compatible artifacts select the backend;
 * ordinary artifacts retain their ordinary path. Membership remains in Rust. */
export interface TrustedMemoryGroupOptions {
  maximumPages: number;
  /** SDK alternatives beside ordinary executables in the same image. */
  preparedPrograms?: import('./prepared-memory-group-programs').PreparedMemoryGroupPrograms;
  /** Optional embedder admission quota; omitted means the protocol's u32 ceiling. */
  maximumProcesses?: number;
  /** Includes pthreads and pending/retiring executions, not just processes. */
  maximumTasks?: number;
}
type Layout = ReturnType<typeof computeProcessMemoryLayout>;
type Ownership = GroupedExecWorkerOwnership | GroupedForkWorkerOwnership;
interface Process {
  pid: number;
  handle: PreparedGroupReplica;
  owner: Ownership;
  bytes: ArrayBuffer;
  module: WebAssembly.Module;
  layout: Layout;
  allocator: ThreadPageAllocator;
  retiring?: Promise<void>;
  replacing?: boolean;
}
type ForkRequest = Parameters<NonNullable<CentralizedKernelCallbacks['onGroupedFork']>>[0];
type CloneRequest = Parameters<NonNullable<CentralizedKernelCallbacks['onGroupedClone']>>[0];
type ExecRequest = Parameters<NonNullable<CentralizedKernelCallbacks['onGroupedExec']>>[0];

/** Lives solely in the disposable kernel Worker. Never publishes a Memory or
 * view to its embedding page. Existing grouped helpers own exact execution,
 * reference and native-wait retirement; this owner connects ordinary launch. */
export class GroupedSessionRuntime {
  private readonly processes = new Map<number, Process>();
  private readonly threads = new Map<number, GroupedThreadWorkerOwnership>();
  private readonly threadRetirements = new Map<number, Promise<void>>();
  private readonly exitPublications = new Set<Promise<void>>();
  private readonly externrefs = new ForkExternrefProcessOwner();
  private readonly imports = new ForkHostImportOwnerRuntime(this.externrefs);
  private group?: Promise<number>;
  private backing?: Promise<number>;
  private closed = false;
  private closing = false;
  private readonly launches = new Set<Promise<void>>();
  private readonly options: Required<Pick<TrustedMemoryGroupOptions, 'maximumPages' | 'maximumProcesses' | 'maximumTasks'>>;
  constructor(private readonly kernel: CentralizedKernelWorker, private readonly adapter: WorkerAdapter,
    options: TrustedMemoryGroupOptions, private readonly joins: boolean,
    private readonly onExit: (pid: number, status: number, generation: number) => void,
    private readonly report: (pid: number, error: Error) => void,
    private readonly initialBackingPages = 1) {
    if (options.preparedPrograms) kernel.configurePreparedMemoryGroupPrograms(options.preparedPrograms);
    // WHY: a shared backing budget is the resource authority. A small default
    // count would refuse otherwise affordable desktops. Keep explicit quotas
    // for embedders/tests without preallocating any task or Worker capacity.
    const maximumTasks = options.maximumTasks ?? 0xffff_ffff;
    const maximumProcesses = options.maximumProcesses ?? maximumTasks;
    this.options = { maximumPages: options.maximumPages, maximumProcesses, maximumTasks };
    if (![options.maximumPages, maximumProcesses, maximumTasks].every(value => Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff)
        || maximumTasks < maximumProcesses
        || options.maximumPages < 2 || options.maximumPages > G.MEMORY_GROUP_MAXIMUM_PAGES
        || !Number.isSafeInteger(initialBackingPages) || initialBackingPages < 1
        || initialBackingPages > options.maximumPages) throw Error('Invalid trusted memory-group budgets');
  }

  accepts(module: WebAssembly.Module): boolean {
    return WebAssembly.Module.customSections(module, G.MEMORY_GROUP_SECTION).length > 0;
  }
  async usage(): Promise<MemoryGroupUsage | null> {
    // Do not turn a read into admission or a shared-memory reservation.
    if (!this.group) return null;
    const group = await this.group;
    return retry(() => {
      const result = this.kernel.inspectMemoryGroupUsage(group);
      if (result === -ERRNO.EAGAIN) throw Error('inspect memory-group usage: allocator busy (EAGAIN); retry later');
      if (typeof result === 'number') throw Error(`inspect memory-group usage: errno ${-result}`);
      return result;
    });
  }
  has(pid: number): boolean { return this.processes.has(pid); }
  private current(process: Process): boolean { return this.processes.get(process.pid) === process && !process.replacing && !process.retiring; }
  private number(value: number, operation: string): number {
    if (value < 0) throw Error(`${operation}: errno ${-value}`);
    return value;
  }
  private ensureGroup(): Promise<number> {
    return this.group ??= retry(() => {
      this.number(this.kernel.configureMemoryGroups(this.options.maximumPages, 1), 'configure memory group');
      const id = this.number(this.kernel.createMemoryGroup(this.options.maximumPages,
        this.options.maximumProcesses, this.options.maximumTasks), 'create memory group');
      return id;
    });
  }
  private ensureBacking(): Promise<number> {
    // Ordinary paths may validate under an opted-in host. They must not spend
    // a shared Memory reservation until a compatible program actually launches.
    return this.backing ??= this.ensureGroup().then(group => retry(() => {
      this.number(this.kernel.createMemoryGroupBacking(group, this.initialBackingPages), 'create memory group backing');
      return group;
    }));
  }
  /** Validation may precede initial exec's generation change. It reserves no
   * task/image: launch admits the resulting generation before any Worker. */
  async initialPathGroup(): Promise<number> {
    if (this.closed) throw Error('Grouped session is closed');
    return this.ensureGroup();
  }
  private allocator(layout: Layout): ThreadPageAllocator {
    return new ThreadPageAllocator({ firstSlotStartPage: layout.firstThreadSlotPage,
      maxPageExclusive: layout.threadArenaEndPage, reservedSlots: layout.threadSlotCount, ptrWidth: 4 });
  }
  private fault(process: Process, error: Error): void {
    if (!this.current(process)) return;
    this.report(process.pid, error);
    void retry(() => this.kernel.recordMemoryGroupCrash(process.handle, 11)).catch(failure => this.report(process.pid, failure));
  }
  private message(process: Process, message: any): void {
    if (!this.current(process)) return;
    if (message.type === 'error') this.fault(process, Error(message.message));
  }

  private publishRetiredExit(pid: number, status: number, generation: number): Promise<void> {
    // A host-owned root has no guest parent to consume its zombie. Reap only
    // after exact image retirement; Rust leaves guest-owned wait status intact.
    const completion = retry(() => this.kernel.reapHostOwnedExitedProcess(pid))
      .then(() => { this.onExit(pid, status, generation); });
    // The execution image is already gone from the live map. A busy entry
    // can defer its reap, so destroy must still own this final publication.
    this.exitPublications.add(completion);
    void completion.then(
      () => { this.exitPublications.delete(completion); },
      () => { this.exitPublications.delete(completion); },
    );
    return completion;
  }

  launch(pid: number, bytes: ArrayBuffer, module: WebAssembly.Module, argv: string[], env: string[],
    maximumPages: number, defaultThreadSlots: number, secureExec: boolean, committedExecutable = false): Promise<void> {
    const pending = this.launchRoot(pid, bytes, module, argv, env, maximumPages, defaultThreadSlots, secureExec, committedExecutable);
    this.launches.add(pending);
    void pending.then(() => this.launches.delete(pending), () => this.launches.delete(pending));
    return pending;
  }

  private async launchRoot(pid: number, bytes: ArrayBuffer, module: WebAssembly.Module, argv: string[], env: string[],
    maximumPages: number, defaultThreadSlots: number, secureExec: boolean, committedExecutable: boolean): Promise<void> {
    if (this.closed || this.closing || this.processes.has(pid) || !this.accepts(module)) throw Error('Invalid grouped root launch');
    this.number(this.kernel.validateExecMetadata(argv, env, 4), 'grouped launch metadata');
    const sections = WebAssembly.Module.customSections(module, G.MEMORY_GROUP_SECTION);
    if (sections.length !== 1 || sections[0].byteLength > 4096) throw Error('Invalid grouped artifact declaration');
    const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sections[0]));
    if (!Number.isInteger(metadata.initialPages) || metadata.initialPages < 0) throw Error('Invalid grouped minimum');
    const layout = computeProcessMemoryLayout({ programBytes: bytes, ptrWidth: 4, maxPages: maximumPages,
      minPages: metadata.initialPages, heapBase: extractHeapBase(bytes), defaultThreadSlots });
    const allocator = this.allocator(layout);
    // Keep ordinary refusals before publication. Path/spawn commit already
    // owns the retained executable and its credentials.
    if (!committedExecutable) {
      this.number(await retry(() => this.kernel.attachProgram(pid, { bytes: new Uint8Array(bytes), name: argv[0] || 'program' })), 'attach grouped executable');
    }
    const group = await this.ensureBacking();
    const receipt = await retry(() => this.kernel.prepareMemoryGroupProcess(group, pid));
    if (typeof receipt === 'number') throw Error(`Grouped root admission: errno ${-receipt}`);
    const generation = this.externrefs.startGeneration(pid);
    let handle: PreparedGroupReplica | number;
    try {
      handle = await retry(() => this.kernel.prepareMemoryGroupImage(receipt, {
        initialVirtualPages: layout.initialPages, maximumVirtualPages: layout.maximumPages, scratchBytes: 65536 }));
      if (typeof handle === 'number') throw Error(`Grouped root image: errno ${-handle}`);
    } catch (cause) { this.externrefs.releaseGeneration(generation); throw cause; }
    let launch!: GroupReplicaLaunch;
    let expected!: Omit<GroupReplicaLaunch['expectation'], 'assertLive'>;
    let init!: Omit<CentralizedWorkerInitMessage, 'memory'>;
    let published = false, observed = false, launchComplete = false;
    const worker = new DeferredWorkerHandle(() => {
      if (this.closed || !this.current(process)) throw Error('Grouped root admission closed');
      const actual = this.adapter.createWorker(createGroupedWorkerPrepare(expected));
      void waitForGroupedWorkerReady(actual, expected).then(() => {
        if (!this.current(process)) throw Error('Grouped root replaced before readiness');
        actual.postMessage(createGroupedWorkerLaunch(init, launch.envelope));
      }).catch(error => {
        if (this.current(process)) this.kernel.containMemoryGroupLaunchFailure(error);
      });
      return actual;
    });
    const owner = new GroupedExecWorkerOwnership(pid, handle, receipt, generation, worker, this.externrefs, this.joins);
    const process: Process = { pid, handle, owner, bytes, module, layout, allocator };
    try {
      const result = await retry(() => this.kernel.publishMemoryGroupReplica(handle));
      if (typeof result === 'number') throw Error(`Grouped root publication: errno ${-result}`);
      launch = result; published = true;
      const { assertLive: _live, ...identity } = launch.expectation;
      expected = identity;
      // Bind exact absence/stop proof immediately after publication, before
      // registration or reference setup can fail. No constructor can run yet.
      await retry(() => this.kernel.observeMemoryGroupReplicaWorker(handle, worker, { terminationProvesQuiescence: this.joins }));
      observed = true;
      this.processes.set(pid, process);
      await retry(() => this.kernel.registerMemoryGroupProcess(handle, [layout.channelOffset], {
        ...layout, ptrWidth: 4, argv, env }));
      const endpoint = this.imports.createWorker({ pid, generationId: generation.id,
        authorizeSender: () => { if (!this.current(process)) throw Error('Stale grouped root sender'); },
        onDiagnostic: error => this.fault(process, error instanceof Error ? error : Error(String(error))) });
      const message = (value: any) => {
        try {
          if (value.type === 'fork_host_import') { if (!endpoint.dispatch(value.wake)) throw Error('Stale grouped root wake'); }
          else {
            if (value.type === 'memory_quiescent') owner.acceptQuiescence(value);
            this.message(process, value);
          }
        } catch (error) { this.fault(process, error instanceof Error ? error : Error(String(error))); }
      };
      const error = (error: Error) => this.fault(process, error);
      const exit = (code: number) => { owner.noteExit(); if (code && this.current(process)) this.fault(process, Error(`Grouped Worker exit ${code}`)); };
      worker.on('message', message); worker.on('error', error); worker.on('exit', exit);
      owner.attach(endpoint, () => { worker.off('message', message); worker.off('error', error); worker.off('exit', exit); });
      init = { type: 'centralized_init', pid, programBytes: bytes, programModule: module,
        channelOffset: layout.channelOffset, secureExec, argv, env, ptrWidth: 4,
        externrefGenerationId: generation.id, forkHostImports: endpoint.init,
        kernelAbiVersion: this.kernel.getKernelAbiVersion(), kernelAbiContractDigest: this.kernel.getKernelAbiContractDigest() ?? undefined };
      let startError: unknown;
      const cancel = () => {
        startError ??= Error('Grouped root start cancelled');
        if (launchComplete) void retry(() => this.kernel.sealMemoryGroupReplicaWorkerAbsence(handle, worker))
          .catch(error => this.kernel.containMemoryGroupLaunchFailure(error));
      };
      const started = await retry(() => this.kernel.startMemoryGroupProcessWorkerWhenRunnable(handle,
        () => { if (this.closed) cancel(); else worker.start(); }, cancel,
        error => {
          startError = error;
          if (launchComplete) this.kernel.containMemoryGroupLaunchFailure(error);
          return true;
        }));
      if (startError) throw startError;
      if (started === 'dead' || started === 'stale') throw Error(`Grouped root start ${started}`);
      launchComplete = true;
    } catch (cause) {
      if (!published) {
        this.number(await retry(() => this.kernel.cancelUnexposedMemoryGroupReplica(handle)), 'cancel grouped root');
        if (!owner.releaseAfterStop()) this.kernel.containMemoryGroupLaunchFailure(cause);
      } else if (process.retiring) {
        await process.retiring;
      } else {
        if (!observed || !await this.kernel.retireMemoryGroupUnstartedProcess(handle, worker, () => {
          if (!owner.releaseAfterStop()) throw Error('Unstarted grouped root lost its exact absence proof');
        })) this.kernel.containMemoryGroupLaunchFailure(cause);
        if (this.processes.get(pid) === process) this.processes.delete(pid);
      }
      throw cause;
    }
  }

  async fork(request: ForkRequest): Promise<number[]> {
    const parent = this.processes.get(request.parentPid);
    if (this.closed || !parent || parent.replacing) throw Error('Grouped fork lost its parent');
    let child!: Process;
    await launchGroupedForkWorker({ kernel: this.kernel, request, adapter: this.adapter, externrefs: this.externrefs,
      imports: this.imports, parentGeneration: parent.owner.generation, programBytes: parent.bytes, programModule: parent.module,
      channelOffset: parent.layout.channelOffset, maximumVirtualPages: parent.layout.maximumPages,
      terminationProvesQuiescence: this.joins,
      isCurrent: owner => this.processes.get(owner.pid)?.owner === owner,
      retain: owner => { child = { ...parent, pid: owner.pid, handle: request.childReplica, owner,
        allocator: this.allocator(parent.layout), retiring: undefined, replacing: false }; this.processes.set(owner.pid, child); },
      discard: owner => { if (this.processes.get(owner.pid)?.owner === owner) this.processes.delete(owner.pid); },
      onMessage: message => this.message(child, message), onError: error => this.fault(child, error),
      onExit: code => { if (code) this.fault(child, Error(`Grouped child Worker exit ${code}`)); },
    });
    return [parent.layout.channelOffset];
  }
  async clone(attachment: CloneRequest): Promise<void> {
    const process = this.processes.get(attachment.pid);
    if (this.closed || !process || process.replacing) throw Error('Grouped clone lost its image');
    await launchGroupedThreadWorker({ kernel: this.kernel, attachment, allocator: process.allocator,
      adapter: this.adapter, imports: this.imports, generation: process.owner.generation, programBytes: process.bytes,
      terminationProvesQuiescence: this.joins, isCurrent: thread => this.threads.get(thread.tid) === thread,
      retain: thread => this.threads.set(thread.tid, thread), discard: thread => this.threads.delete(thread.tid),
      onMessage: (message, thread) => { if (message.type === 'thread_exit') this.threadExit(thread.pid, thread.tid); else this.message(process, message); },
      onError: error => this.fault(process, error), onExit: (code, thread) => { if (code && !thread.quiescent) this.fault(process, Error(`Grouped pthread Worker exit ${code}`)); },
    });
  }
  threadExit(pid: number, tid: number): boolean {
    const thread = this.threads.get(tid), process = this.processes.get(pid);
    if (!thread || thread.pid !== pid) return false;
    if (!process || process.retiring || process.replacing || this.threadRetirements.has(tid)) return true;
    const retirement = (async () => {
      await this.kernel.waitForMemoryGroupReplicaQuiescence(thread.handle);
      if (this.joins) await thread.waitForNodeJoin();
      this.number(await retry(() => this.kernel.retireMemoryGroupThread(thread.handle, () => {
        if (!thread.releaseAfterStop()) throw Error('Grouped thread lacks exact stop proof');
      })), 'retire grouped pthread');
      await thread.contain(); this.threads.delete(tid);
    })();
    this.threadRetirements.set(tid, retirement);
    void retirement.catch(error => this.fault(process, error));
    return true;
  }
  exec(request: ExecRequest): ReturnType<NonNullable<CentralizedKernelCallbacks['onGroupedExec']>> {
    const previous = this.processes.get(request.pid);
    if (!previous || this.closed || !request.groupedExec) return Promise.resolve(-95);
    const oldThreads = [...this.threads.values()].filter(thread => thread.pid === request.pid);
    return Promise.resolve(prepareGroupedExecWorker({ kernel: this.kernel, request, previousImage: previous.handle,
      previousWorkers: [previous.owner.worker, ...oldThreads.map(thread => thread.worker)],
      previousGeneration: previous.owner.generation, externrefs: this.externrefs, imports: this.imports, adapter: this.adapter,
      terminationProvesQuiescence: this.joins,
      isCurrent: owner => this.processes.get(owner.pid)?.owner === owner,
      onCommitted: () => { previous.replacing = true; },
      retirePreviousReferences: async () => {
        for (const thread of oldThreads) {
          await this.threadRetirements.get(thread.tid);
          if (!thread.releaseAfterStop()) throw Error('Exec pthread lacks exact stop proof');
          this.threads.delete(thread.tid);
        }
        if (!previous.owner.releaseAfterStop()) throw Error('Exec predecessor lacks exact stop proof');
      },
      retain: owner => {
        const layout = request.groupedExec!.layout;
        this.processes.set(owner.pid, { pid: owner.pid, owner, handle: owner.handle, bytes: request.targetBytes,
          module: request.targetModule, layout, allocator: this.allocator(layout) });
      },
      onRetired: () => {},
      onTerminated: signal => {
        this.processes.delete(previous.pid);
        void this.publishRetiredExit(previous.pid, 128 + signal, previous.owner.generation.id)
          .catch(error => this.report(previous.pid, error instanceof Error ? error : Error(String(error))));
      },
      onMessage: (message, owner) => { const current = this.processes.get(owner.pid); if (current?.owner === owner) this.message(current, message); },
      onError: (error, owner) => { const current = this.processes.get(owner.pid); if (current?.owner === owner) this.fault(current, error); },
      onExit: (code, owner) => { const current = this.processes.get(owner.pid); if (code && current?.owner === owner) this.fault(current, Error(`Grouped exec Worker exit ${code}`)); },
    }));
  }
  exit(pid: number, status: number): boolean {
    const process = this.processes.get(pid);
    if (!process) return false;
    if (process.replacing || process.retiring) return true;
    process.retiring = (async () => {
      const members = [...this.threads.values()].filter(thread => thread.pid === pid);
      await this.kernel.waitForMemoryGroupReplicaQuiescence(process.handle);
      await Promise.all(members.map(thread => this.kernel.waitForMemoryGroupReplicaQuiescence(thread.handle)));
      await Promise.all([process.owner.contain(), ...members.map(thread => thread.contain())]);
      await Promise.all(members.map(thread => this.threadRetirements.get(thread.tid)));
      if (!await retry(() => this.kernel.deactivateMemoryGroupProcess(process.handle))) throw Error('Stopped grouped image cannot deactivate');
      for (;;) {
        const retired = await retry(() => this.kernel.retireMemoryGroupImage(process.handle, () => {
          for (const thread of members) if (!thread.releaseAfterStop()) throw Error('Exited pthread lacks stop proof');
          if (!process.owner.releaseAfterStop()) throw Error('Exited image lacks stop proof');
        }));
        if (!retired) break;
        if (retired !== -16) throw Error(`Grouped image retirement: errno ${-retired}`);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      for (const thread of members) { this.threads.delete(thread.tid); this.threadRetirements.delete(thread.tid); }
      if (this.processes.get(pid) === process) this.processes.delete(pid);
      await this.publishRetiredExit(pid, status, process.owner.generation.id);
    })();
    void process.retiring.catch(error => this.report(pid, error));
    return true;
  }
  async destroy(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.launches);
    this.closed = true;
    const live = [...this.processes.values()];
    for (const process of live) {
      await retry(() => this.kernel.sealMemoryGroupReplicaWorkerAbsence(process.handle, process.owner.worker));
      await retry(() => this.kernel.signalProcess(process.pid, 9));
    }
    for (const process of live) {
      // The kernel publishes exit only after its exact all-replica stop fence.
      while (!process.retiring && this.processes.get(process.pid) === process) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      await process.retiring;
    }
    await Promise.all(this.exitPublications);
  }
}
