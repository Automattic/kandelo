import { GroupedWorkerObjects } from './grouped-worker-objects';
import { CentralizedKernelWorker, type CentralizedKernelCallbacks } from './kernel-worker';
import type { ProcessMemoryLayout } from './process-memory';
import * as G from './generated/program-extensions';
import { ERRNO } from './generated/abi';
import { ForkExternrefProcessOwner } from './fork-externref-process-owner';
import { ForkHostImportOwnerRuntime } from './fork-host-import-runtime';
import type { GroupReplicaLaunch } from './group-memory-transport';
import type { WorkerAdapter } from './worker-adapter';
import { prepareGroupedExecWorker } from './grouped-exec-launch';
import { launchGroupedForkWorker } from './grouped-fork-launch';
import { launchGroupedThreadWorker } from './grouped-thread-launch';
import { retryKernelEntryResult as retry } from './kernel-entry-retry';
import type { MemoryGroupUsage } from './memory-group-usage';
import type { CentralizedWorkerInitMessage } from './worker-protocol';

/** Explicit embedder-only opt-in. Compatible artifacts select the backend;
 * ordinary artifacts retain their ordinary path. Membership remains in Rust. */
export interface TrustedMemoryGroupOptions {
  maximumPages: number;
  /** Optional embedder admission quota; omitted means the protocol's u32 ceiling. */
  maximumProcesses?: number;
  /** Includes pthreads and pending/retiring executions, not just processes. */
  maximumTasks?: number;
}
interface Process {
  owner: GroupedWorkerObjects;
  bytes: ArrayBuffer;
  module: WebAssembly.Module;
  layout: ProcessMemoryLayout;
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
  private readonly threads = new Map<number, GroupedWorkerObjects>();
  private readonly exitPublications = new Set<Promise<void>>();
  private readonly externrefs = new ForkExternrefProcessOwner();
  private readonly imports = new ForkHostImportOwnerRuntime(this.externrefs);
  private group?: Promise<number>;
  private backing?: Promise<number>;
  private closed = false;
  private closing = false;
  private shutdown?: Promise<void>;
  private readonly launches = new Set<Promise<void>>();
  private readonly options: Required<Pick<TrustedMemoryGroupOptions, 'maximumPages' | 'maximumProcesses' | 'maximumTasks'>>;
  constructor(private readonly kernel: CentralizedKernelWorker, private readonly adapter: WorkerAdapter,
    options: TrustedMemoryGroupOptions, private readonly joins: boolean,
    private readonly onExit: (pid: number, status: number, generation: number) => void,
    private readonly report: (pid: number, error: Error) => void,
    private readonly initialBackingPages = 1) {
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
  private current(process: Process): boolean { return this.processes.get(process.owner.pid) === process && !process.replacing && !process.retiring; }
  private number(value: number, operation: string): number {
    if (value < 0) throw Error(`${operation}: errno ${-value}`);
    return value;
  }
  private ensureGroup(): Promise<number> {
    return this.group ??= retry(() => {
      // An already requested group may finish after closing; shutdown owns
      // this same Promise and seals its actual kernel identity before draining.
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
    if (this.closing || this.closed) throw Error('Grouped session is closed');
    return this.ensureGroup();
  }
  private fault(process: Process, error: Error): void {
    if (!this.current(process)) return;
    const { pid, handle } = process.owner;
    this.report(pid, error);
    void retry(() => this.kernel.recordMemoryGroupCrash(handle, 11)).catch(failure => this.report(pid, failure));
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
    // Keep ordinary refusals before publication. Path/spawn commit already
    // owns the retained executable and its credentials.
    if (!committedExecutable) {
      this.number(await retry(() => this.kernel.attachProgram(pid, { bytes: new Uint8Array(bytes), name: argv[0] || 'program' })), 'attach grouped executable');
    }
    if (this.closing || this.closed) throw Error('Grouped root admission closed');
    const group = await this.ensureBacking();
    const prepared = await this.kernel.prepareMemoryGroupRoot(group, pid, maximumPages, defaultThreadSlots);
    if (typeof prepared === 'number') throw Error(`Grouped root preparation: errno ${-prepared}`);
    const { receipt, handle, layout } = prepared;
    const generation = this.externrefs.startGeneration(pid);
    let launch!: GroupReplicaLaunch;
    let init!: Omit<CentralizedWorkerInitMessage, 'memory'>;
    let observed = false;
    const owner = new GroupedWorkerObjects(handle, receipt, generation, {
      adapter: this.adapter,
      launch: () => {
        if (this.closed || !this.current(process)) throw Error('Grouped root admission closed');
        return launch;
      },
      readinessTimeoutMs: 10000,
    }, () => this.externrefs.releaseGeneration(generation));
    const { worker } = owner;
    const process: Process = { owner, bytes, module, layout };
    const bindWorker = () => {
      if (observed) return;
      this.kernel.observeMemoryGroupReplicaWorker(handle, worker, { terminationProvesQuiescence: this.joins,
        retireHostReferences: () => owner.disposeReferences() });
      observed = true;
      this.processes.set(pid, process);
    };
    await this.kernel.runMemoryGroupRootLaunch(handle, {
      publishTransport: result => { launch = result; },
      bindWorker,
      registerProcess: () => this.kernel.registerMemoryGroupProcess(handle, [layout.channelOffset], {
        ...layout, ptrWidth: 4, argv, env }),
      connectImports: () => {
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
        const exit = (code: number) => { if (code && this.current(process)) this.fault(process, Error(`Grouped Worker exit ${code}`)); };
        worker.on('message', message); worker.on('error', error); worker.on('exit', exit);
        owner.attach(endpoint, () => { worker.off('message', message); worker.off('error', error); worker.off('exit', exit); });
        init = { type: 'centralized_init', pid, programBytes: bytes, programModule: module,
          channelOffset: layout.channelOffset, secureExec, argv, env, ptrWidth: 4,
          externrefGenerationId: generation.id, forkHostImports: endpoint.init,
          kernelAbiVersion: this.kernel.getKernelAbiVersion(), kernelAbiContractDigest: this.kernel.getKernelAbiContractDigest() ?? undefined };
      },
      startWorker: () => {
        if (this.closed || !worker.start()) throw Error('Grouped root start cancelled');
      },
      waitReady: () => owner.waitReady(),
      deliverLaunch: () => {
        if (!this.current(process)) throw Error('Grouped root replaced before launch delivery');
        owner.deliverLaunch(init);
      },
      sealAbsence: () => {
        bindWorker();
        return this.kernel.sealMemoryGroupReplicaWorkerAbsence(handle, worker);
      },
      retireImage: async () => {
        this.number(await retry(() => this.kernel.retireMemoryGroupImage(handle)), 'retire grouped root');
      },
      discardTransport: () => { if (this.processes.get(pid) === process) this.processes.delete(pid); },
      containFailure: cause => this.kernel.containMemoryGroupLaunchFailure(cause),
    });
  }

  async fork(request: ForkRequest): Promise<void> {
    const parent = this.processes.get(request.parentPid);
    if (this.closed || !parent || parent.replacing) throw Error('Grouped fork lost its parent');
    let child!: Process;
    await launchGroupedForkWorker({ kernel: this.kernel, request, adapter: this.adapter, externrefs: this.externrefs,
      imports: this.imports, parentGeneration: parent.owner.generation, programBytes: parent.bytes, programModule: parent.module,
      maximumVirtualPages: parent.layout.maximumPages,
      terminationProvesQuiescence: this.joins,
      isCurrent: owner => this.processes.get(owner.pid)?.owner === owner,
      retain: owner => { child = { ...parent, owner,
        layout: { ...parent.layout, channelOffset: request.channelOffset }, retiring: undefined, replacing: false }; this.processes.set(owner.pid, child); },
      discard: owner => { if (this.processes.get(owner.pid)?.owner === owner) this.processes.delete(owner.pid); },
      onMessage: message => this.message(child, message), onError: error => this.fault(child, error),
      onExit: code => { if (code) this.fault(child, Error(`Grouped child Worker exit ${code}`)); },
    });
  }
  async clone(attachment: CloneRequest): Promise<void> {
    const process = this.processes.get(attachment.pid);
    if (this.closed || !process || process.replacing) throw Error('Grouped clone lost its image');
    await launchGroupedThreadWorker({ kernel: this.kernel, attachment,
      adapter: this.adapter, imports: this.imports, generation: process.owner.generation, programBytes: process.bytes,
      terminationProvesQuiescence: this.joins, isCurrent: thread => this.threads.get(thread.tid) === thread,
      retain: thread => this.threads.set(thread.tid, thread), discard: thread => this.threads.delete(thread.tid),
      onMessage: message => this.message(process, message),
      onError: error => this.fault(process, error), onExit: (code, thread) => { if (code && !thread.quiescent) this.fault(process, Error(`Grouped pthread Worker exit ${code}`)); },
    });
  }
  threadExit(pid: number, tid: number): boolean {
    const thread = this.threads.get(tid), process = this.processes.get(pid);
    if (!thread || thread.pid !== pid) return false;
    if (!process || thread.referencesDisposed) return true;
    // The kernel calls this once after logical SYS_EXIT. The later Worker
    // thread_exit message repeats it. Only the exact terminal fence proves stop.
    void (async () => {
      await this.kernel.waitForMemoryGroupReplicaQuiescence(thread.handle);
      this.number(await retry(() => this.kernel.retireMemoryGroupThread(thread.handle)), 'retire grouped pthread');
      this.threads.delete(tid);
    })().catch(error => this.fault(process, error));
    return true;
  }
  exec(request: ExecRequest): ReturnType<NonNullable<CentralizedKernelCallbacks['onGroupedExec']>> {
    const { pid } = request;
    const previous = this.processes.get(pid);
    if (!previous || this.closed || !request.groupedExec) return Promise.resolve(-95);
    return Promise.resolve(prepareGroupedExecWorker({ kernel: this.kernel, request, previousImage: previous.owner.handle,
      previousGeneration: previous.owner.generation, externrefs: this.externrefs, imports: this.imports, adapter: this.adapter,
      terminationProvesQuiescence: this.joins,
      isCurrent: owner => this.processes.get(owner.pid)?.owner === owner,
      onCommitted: () => { previous.replacing = true; },
      retirePreviousReferences: () => {
        for (const thread of this.threads.values()) {
          if (thread.generation === previous.owner.generation) this.threads.delete(thread.tid);
        }
      },
      retain: owner => {
        const layout = request.groupedExec!.layout;
        this.processes.set(owner.pid, { owner, bytes: request.targetBytes,
          module: request.targetModule, layout });
      },
      onTerminated: (_signal, status) => {
        this.processes.delete(pid);
        void this.publishRetiredExit(pid, status, previous.owner.generation.id)
          .catch(error => this.report(pid, error instanceof Error ? error : Error(String(error))));
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
      const retired = await retry(() => this.kernel.retireMemoryGroupImage(process.owner.handle));
      if (retired !== 0) throw Error(`Grouped image retirement pid=${pid}: errno ${-retired}`);
      for (const thread of members) this.threads.delete(thread.tid);
      if (this.processes.get(pid) === process) this.processes.delete(pid);
      await this.publishRetiredExit(pid, status, process.owner.generation.id);
    })();
    void process.retiring.catch(error => this.report(pid, error));
    return true;
  }
  /** Begin before platform creator draining: Rust closes real admission and
   * selects every current member, including pending/stopped native launches. */
  requestShutdown(): Promise<void> {
    this.closing = true;
    return this.shutdown ??= (async () => {
      const group = this.group;
      if (group) {
        const id = await group;
        this.number(await retry(() => this.kernel.stopMemoryGroup(id)), 'stop memory group');
      }
    })();
  }
  async destroy(): Promise<void> {
    await this.requestShutdown();
    await Promise.allSettled(this.launches);
    this.closed = true;
    const live = [...this.processes.values()];
    for (const process of live) {
      // The kernel publishes exit only after its exact all-replica stop fence.
      while (!process.retiring && this.processes.get(process.owner.pid) === process) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      await process.retiring;
    }
    await Promise.all(this.exitPublications);
  }
}
