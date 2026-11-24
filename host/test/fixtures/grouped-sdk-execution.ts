import { DeferredWorkerHandle } from '../../src/deferred-worker-handle';
import { GroupedWorkerObjects } from '../../src/grouped-worker-objects';
import { CAPTURED_STDIO, CentralizedKernelWorker, type CentralizedKernelCallbacks } from "../../src/kernel-worker";
import type { WorkerAdapter, WorkerHandle } from "../../src/worker-adapter";
import type { PlatformIO } from "../../src/types";
import { computeProcessMemoryLayout, createProcessMemory } from "../../src/process-memory";
import { extractHeapBase } from "../../src/constants";
import { ERRNO, ABI_SYSCALLS, MEMORY_GROUP_PROTOCOL } from "../../src/generated/abi";
import { ForkExternrefProcessOwner } from "../../src/fork-externref-process-owner";
import { ForkHostImportOwnerRuntime, type ForkHostImportOwnerWorker } from "../../src/fork-host-import-runtime";
import { createGroupedWorkerLaunch, createGroupedWorkerPrepare, waitForGroupedWorkerReady } from "../../src/grouped-worker-initialization";
import type { CentralizedWorkerInitMessage } from "../../src/worker-protocol";
import { retryKernelEntryResult } from "../../src/kernel-entry-retry";
import { MemoryGroupProtocolFault } from '../../src/memory-group-protocol';
import { MEMORY_GROUP_CONTROL } from '../../src/generated/program-extensions';
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { launchGroupedForkWorker } from '../../src/grouped-fork-launch';
import { GroupMemoryTransport, type PreparedGroupReplica, type GroupReplicaLaunch } from '../../src/group-memory-transport';
import { GroupMemoryResources, GroupMemoryResourceError } from '../../src/group-memory-resources';
import { launchGroupedThreadWorker } from '../../src/grouped-thread-launch';
import { prepareGroupedExecWorker } from '../../src/grouped-exec-launch';

// Invoke only inside a disposable kernel Worker. Results contain copied
// output/scalars, never a kernel/process Memory or a view of its backing.
export interface SdkExecutionOptions {
  kernelBytes: ArrayBuffer;
  programBytes: ArrayBuffer;
  ordinaryBytes: ArrayBuffer;
  imageModuleBytes: ArrayBuffer;
  grouped: boolean;
  io: PlatformIO;
  adapter: WorkerAdapter;
  joinOnExit: boolean;
  trace?: boolean;
  physicalPages?: number;
  maximumVirtualPages?: number;
  execTargetBytes?: ArrayBuffer;
  rejectThreadLaunchCount?: number;
  threadPoolRollback?: boolean;
  rejectForkLaunchCount?: number;
  rejectForkStage?: 'registration' | 'replay' | 'pool';
  uncertainThreadConstructor?: boolean;
  forcedLifecycle?: boolean;
  nativeWaitLifecycle?: boolean;
  execPrecommitFailure?: 'allocation' | 'callback' | 'virtual';
  execPoolRollback?: boolean;
  execPrecommitStop?: 'deactivate' | 'retire';
  execSuccess?: boolean;
  execOldThreads?: boolean;
  anonymousShared?: boolean;
  execSignal?: 'commit' | 'stopped';
  execTerminationPool?: boolean;
}
interface SdkExecutionMachine {
  kernel?: CentralizedKernelWorker;
  callbacks?: CentralizedKernelCallbacks;
  initialized?: boolean;
  group?: number;
}

// A cohort ends only after its Workers and image storage retire. Keeping this
// machine inside one disposable kernel realm proves allocator reuse without
// relying on a new Memory, a new kernel, or collection between launches.
export async function runSdkCycles(options: SdkExecutionOptions, count: number): Promise<Record<string, unknown>> {
  if (!options.grouped || !Number.isInteger(count) || count < 2 || count > 100) throw Error('Invalid grouped SDK cycle request');
  const machine: SdkExecutionMachine = {};
  const cycles: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index++) {
    const result = await runSdkExecution(options, machine);
    cycles.push(result);
    if (result.failure) return { failure: `SDK cycle ${index + 1}: ${result.failure}`, cycles };
  }
  return { cycles };
}

export async function runSdkExecution(options: SdkExecutionOptions, machine?: SdkExecutionMachine): Promise<Record<string, unknown>> {
  const { grouped, adapter } = options;
  const status = (value: number, label: string): number => {
    if (value < 0) throw new Error(`${label}: errno ${-value}`);
    return value;
  };
  const owner = new ForkExternrefProcessOwner();
  const imports = new ForkHostImportOwnerRuntime(owner);
  let processWorker: WorkerHandle | undefined;
  let processWorkerConstructionAttempts = 0;
  const processAdapter: WorkerAdapter = { createWorker: init => {
    processWorkerConstructionAttempts++; return adapter.createWorker(init);
  } };
  let importWorker: ForkHostImportOwnerWorker | undefined;
  let generation: ReturnType<ForkExternrefProcessOwner["startGeneration"]> | undefined;
  let stdout = "", stderr = "";
  let kernelExit: number | undefined, processExit: number | undefined;
  let quiescent = false, processReady = false;
  let rootPid: number | undefined, rootJoined = false;
  let processLayout: ReturnType<typeof computeProcessMemoryLayout> | undefined;
  let kernelForDiagnostics: CentralizedKernelWorker | undefined;
  let admittedGroup: number | undefined;
  let rootHandle: PreparedGroupReplica | undefined;
  let rollbackPoolMemory: WebAssembly.Memory | undefined;
  const imageHandles = new Map<number, PreparedGroupReplica>();
  const execPreparations: Record<string, unknown>[] = [];
  const execReturns: Record<string, unknown>[] = [];
  const execHandoffs: Record<string, unknown>[] = [];
  let execHandoff = false;
  let currentExecWorker: GroupedWorkerObjects | undefined;
  const execRetiringThreads = new WeakSet<GroupedWorkerObjects>();
  let execThreadProbe: { step: number; busy: number; ready32: number; ready64: number; returned: number; firstBusy?: number; released: boolean } | undefined;
  let execProbeActive = false;
  let execTermination: { signal: number } | undefined;
  let execReplacementPublications = 0;
  let execPrecommitStopFinished = false;
  const memoryEvidence = async () => ({ group: admittedGroup, pid: rootPid, initialVirtualPages: processLayout?.initialPages,
    maximumVirtualPages: processLayout?.maximumPages, declaredThreadSlots: processLayout?.threadSlotCount,
    backing: admittedGroup === undefined ? undefined : await retryKernelEntryResult(() => kernelForDiagnostics?.inspectMemoryGroupBacking(admittedGroup!)) });
  const rolledBackPids: number[] = [];
  const evidenceWork: Promise<void>[] = [];
  const children = new Map<number, GroupedWorkerObjects>();
  const threads = new Map<number, GroupedWorkerObjects>();
  const threadExits = new Set<number>();
  const logicalThreadExits = new Set<number>();
  const stoppedWithProcess = new Set<number>();
  const threadRetirements = new Map<number, Promise<void>>();
  const processDeactivations: Promise<void>[] = [];
  const retiredThreads = new Set<number>();
  const threadRetirementMemory: Record<string, unknown>[] = [];
  const failedControlInitializations = new Set<number>();
  let restoreThreadInitializationFault: (() => void) | undefined;
  const childStates = new Map<number, { kernelExit?: number; processExit?: number; ready?: boolean }>();
  const diagnostics: string[] = [];
  const rolledBackForks: Record<string, unknown>[] = [];
  let injectedForkRefusals = 0, forkWorkerConstructionAttempts = 0;
  let threadPreparationAttempts = 0;
  const failedThreadLaunches: Record<string, unknown>[] = [];
  const failedThreadWorkers: Record<string, unknown>[] = [];
  let retainedThreadLaunches = 0, injectedThreadRefusals = 0, threadConstructionAttempts = 0;
  const threadAdapter: WorkerAdapter = { createWorker: init => {
    threadConstructionAttempts++;
    if (options.uncertainThreadConstructor) throw Error("fixture uncertain thread constructor");
    return adapter.createWorker(init);
  } };
  const lifecycleEvidence: Record<string, unknown>[] = [];
  const lifecycleEnabled = options.forcedLifecycle || options.nativeWaitLifecycle;
  let nativeKillReleased = false, nativeSurvivorReleased = false;
  const parkedCalls: { pid: number; tid: number; syscallNr: number; firstArgument: number; owner: 'kernel' | 'pipe-read' | 'pipe-write' }[] = [];
  let blockedReleased = false, busyReleased = false, busyFirst: number | undefined, busyStopValue: number | undefined;
  let busyProbe: { pid: number; address: number } | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let lifecycleActive = true;
  const trace: string[] = [];
  let kernelFailed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let result: Record<string, unknown>;
  try {
    const execution = new Promise<void>((resolve, reject) => {
      const retireThread = (tid: number, thread: GroupedWorkerObjects) => {
        if (retiredThreads.has(tid)) return;
        if (threadRetirements.has(tid)) return;
        const retirement = (async () => {
          await kernel.waitForMemoryGroupReplicaQuiescence(thread.handle);
          if (options.joinOnExit) await thread.waitForNodeJoin();
          const result = await retryKernelEntryResult(() => kernel.retireMemoryGroupThread(thread.handle));
          if (result !== 0) throw Error(`Thread retirement refused: ${result}`);
          await thread.contain();
          retiredThreads.add(tid); threadRetirementMemory.push({ tid, ...await memoryEvidence() });
          maybeComplete();
        })();
        threadRetirements.set(tid, retirement); void retirement.catch(reject);
      };
      const maybeComplete = () => {
        for (const [tid, thread] of threads) {
          if (logicalThreadExits.has(tid) || threadExits.has(tid) || stoppedWithProcess.has(tid)) retireThread(tid, thread);
        }
        if (kernelExit === undefined || processExit === undefined && !execTermination && !options.execPrecommitStop || options.execPrecommitStop && !execPrecommitStopFinished || !quiescent || !processReady
            || (options.joinOnExit && !rootJoined) || options.forcedLifecycle && busyReleased && busyStopValue === undefined) return;
        for (const [pid, child] of children) {
          const state = childStates.get(pid);
          if (state?.kernelExit === undefined || (state.processExit === undefined && !(lifecycleEnabled && (state.kernelExit ?? 0) >= 128)) || !state.ready || !child.quiescent
              || (options.joinOnExit && !child.hasJoined)) return;
        }
        for (const [tid, thread] of threads) {
          if (!(logicalThreadExits.has(tid) || threadExits.has(tid) || stoppedWithProcess.has(tid)) || !thread.quiescent || !retiredThreads.has(tid) || (options.joinOnExit && !thread.hasJoined)) return;
        }
        resolve();
      };
      let anonymousChildRetired!: () => void;
      const anonymousRetirement = new Promise<void>(resolve => { anonymousChildRetired = resolve; });
      const anonymousPhases = new Set<number>();
      // The Node exit event joins the exact process Worker. The deadline is a
      // failure/containment boundary, never permission to reuse grouped pages.
      deadline = setTimeout(() => reject(new Error("guest execution deadline")), 60_000);
      const advanceLifecycle = async () => {
        if (!lifecycleEnabled || rootPid === undefined || !lifecycleActive) return;
        if (options.nativeWaitLifecycle) {
          await advanceNativeWaitLifecycle(); return;
        }
        const blocked = /blocked-ready pid=(\d+) fd=(\d+)/.exec(stdout);
        if (blocked && !blockedReleased) {
          const pid = Number(blocked[1]), fd = Number(blocked[2]);
          const parked = parkedCalls.find(call => call.pid === pid && call.syscallNr === ABI_SYSCALLS.Read && call.firstArgument === fd);
          if (parked) {
            blockedReleased = true; lifecycleEvidence.push({ kind: 'blocked-park', ...parked });
            kernel.appendStdinData(rootPid, Uint8Array.of(107));
          }
        }
        const busy = /busy-ready pid=(\d+) address=(\d+)/.exec(stdout);
        if (busy && !busyReleased) {
          const pid = Number(busy[1]), address = Number(busy[2]), handle = imageHandles.get(pid);
          if (!handle) throw Error('Missing exact busy child image');
          const value = await retryKernelEntryResult(() => kernel.inspectMemoryGroupWord(handle, address));
          if (!lifecycleActive || busyReleased) return;
          if (value < 0) throw Error(`Busy word inspection refused: ${value}`);
          if (busyFirst === undefined) busyFirst = value;
          else if (value !== busyFirst && value > 0) {
            busyReleased = true; busyProbe = { pid, address };
            lifecycleEvidence.push({ kind: 'busy-progress', pid, before: busyFirst, after: value });
            kernel.appendStdinData(rootPid, Uint8Array.of(107));
          }
          if (!busyReleased && probeTimer === undefined) probeTimer = setTimeout(() => {
            probeTimer = undefined; void advanceLifecycle().catch(reject);
          }, 0);
        }
      };
      const advanceNativeWaitLifecycle = async () => {
        const match = /native-ready victim=(\d+) survivor=(\d+) ready32=(\d+) ready64=(\d+) returned=(\d+)/.exec(stdout);
        if (!match || !lifecycleActive || nativeSurvivorReleased) return;
        const victim = Number(match[1]), survivor = Number(match[2]);
        const observe = async (pid: number) => {
          const handle = imageHandles.get(pid), members = [...threads.values()].filter(thread => thread.pid === pid);
          if (!handle || members.length !== 2) return false;
          const scalars = await retryKernelEntryResult(() => [3, 4, 5].map(index => kernel.inspectMemoryGroupWord(handle, Number(match[index]))));
          if (scalars.some(value => value < 0)) throw Error(`Native wait ready inspection refused: ${scalars}`);
          if (scalars[0] !== 1 || scalars[1] !== 1 || scalars[2] !== 0) return false;
          const states = await retryKernelEntryResult(() => members.map(thread => kernel.inspectMemoryGroupReplicaWait(thread.handle)));
          if (states.some(value => typeof value === 'number')) throw Error(`Native queue inspection refused: ${states}`);
          return states.every(state => state === 'waiting');
        };
        if (!nativeKillReleased && await observe(victim) && await observe(survivor)) {
          if (!lifecycleActive || nativeKillReleased) return;
          nativeKillReleased = true;
          lifecycleEvidence.push({ kind: 'native-waits-registered', victim, survivor, threads: [...threads.values()].map(thread => ({ pid: thread.pid, tid: thread.tid })) });
          kernel.appendStdinData(rootPid!, Uint8Array.of(107));
        } else if (nativeKillReleased && stdout.includes('native-victim-reaped') && !nativeSurvivorReleased) {
          const victims = [...threads.values()].filter(thread => thread.pid === victim);
          if (victims.length === 2 && victims.every(thread => retiredThreads.has(thread.tid)) && await observe(survivor)) {
            if (!lifecycleActive || nativeSurvivorReleased) return;
            nativeSurvivorReleased = true;
            lifecycleEvidence.push({ kind: 'native-survivor-preserved', victim, survivor, retiredVictimThreads: victims.map(thread => thread.tid) });
            kernel.appendStdinData(rootPid!, Uint8Array.of(119));
          }
        }
        if (!nativeSurvivorReleased && lifecycleActive && probeTimer === undefined) probeTimer = setTimeout(() => {
          probeTimer = undefined; void advanceLifecycle().catch(reject);
        }, 0);
      };
      const advanceExecThreads = async () => {
        const probe = execThreadProbe, handle = rootHandle;
        if (!probe || probe.released || !handle || execHandoff || !lifecycleActive || execProbeActive) return;
        execProbeActive = true;
        try {
          const members = [...threads.values()].filter(thread => thread.pid === rootPid && !retiredThreads.has(thread.tid));
          const words = await retryKernelEntryResult(() => [probe.busy, probe.ready32, probe.ready64, probe.returned]
            .map(address => kernel.inspectMemoryGroupWord(handle, address)));
          if (words.some(word => word < 0)) throw Error(`Cannot inspect exec predecessor: ${words}`);
          if (members.length === 3 && words[1] === 1 && words[2] === 1 && words[3] === 0) {
            const states = await retryKernelEntryResult(() => members.map(thread => kernel.inspectMemoryGroupReplicaWait(thread.handle)));
            if (probe === execThreadProbe && handle === rootHandle && !execHandoff
                && states.filter(state => state === 'waiting').length === 2 && probe.firstBusy !== undefined && words[0] !== probe.firstBusy) {
              probe.released = true;
              lifecycleEvidence.push({ kind: 'exec-old-threads-observed', step: probe.step, states, busyBefore: probe.firstBusy, busyAfter: words[0] });
              kernel.appendStdinData(rootPid!, Uint8Array.of(107));
            }
          }
          probe.firstBusy = words[0];
        } finally { execProbeActive = false; }
        if (!probe.released && lifecycleActive && probeTimer === undefined) probeTimer = setTimeout(() => {
          probeTimer = undefined; void advanceExecThreads().catch(reject);
        }, 0);
      };
      const callbacks: CentralizedKernelCallbacks = {
        onChildLaunchRolledBack: pid => { rolledBackPids.push(pid); },
        onGroupedExec: options.execSuccess ? async request => {
          if (!request.groupedExec || !rootHandle || !processWorker || !generation) throw Error('Missing exact exec predecessor');
          const previousImport = importWorker, previousExec = currentExecWorker, previousRoot = rootHandle, probe = execThreadProbe;
          const previousThreads = [...threads.values()].filter(thread => thread.pid === request.pid && !retiredThreads.has(thread.tid));
          const signal = () => {
            const stopped = previousThreads.filter(thread => thread.quiescent).length;
            if (options.execSignal === 'commit' && stopped === previousThreads.length) throw Error('Commit signal missed live predecessor');
            if (!kernel.signalProcess(request.pid, 9)) throw Error('Kernel refused exec signal');
            lifecycleEvidence.push({ kind: 'exec-signal-sent', stage: options.execSignal, stopped });
          };
          return prepareGroupedExecWorker({ kernel, request, adapter: processAdapter, externrefs: owner, imports,
            previousImage: rootHandle, previousWorkers: [processWorker, ...previousThreads.map(thread => thread.worker)],
            previousGeneration: generation, terminationProvesQuiescence: options.joinOnExit,
            onCommitted: () => {
              execHandoff = true;
              for (const thread of previousThreads) execRetiringThreads.add(thread);
              if (options.execSignal === 'commit') void retryKernelEntryResult(signal).catch(reject);
            },
            onStopped: options.execOldThreads ? async () => {
              if (!probe?.released || previousThreads.length !== 3 || previousThreads.some(thread => !thread.quiescent)) {
                throw Error('Exec predecessor lacks three exact pthread stop fences');
              }
              const returned = await retryKernelEntryResult(() => kernel.inspectMemoryGroupWord(previousRoot, probe.returned));
              const busy = await retryKernelEntryResult(() => kernel.inspectMemoryGroupWord(previousRoot, probe.busy));
              await new Promise<void>(resolve => setTimeout(resolve, 0));
              const after = await retryKernelEntryResult(() => kernel.inspectMemoryGroupWord(previousRoot, probe.busy));
              if (returned !== 0 || busy !== after) throw Error('Exec predecessor executed after its stop fence');
              lifecycleEvidence.push({ kind: 'exec-old-threads-stopped', step: probe.step, returned, busy, after,
                joined: previousThreads.map(thread => thread.hasJoined) });
              if (options.execSignal === 'stopped') await retryKernelEntryResult(signal);
              if (options.execTerminationPool) {
                if (!rollbackPoolMemory) throw Error('Missing actual terminated exec backing');
                const lock = new Int32Array(rollbackPoolMemory.buffer, MEMORY_GROUP_CONTROL, 1);
                if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) throw Error('Terminated exec fixture did not acquire its pool lock');
                setTimeout(() => {
                  try { lifecycleEvidence.push({ kind: 'terminated-exec-pool-lock-released', admission: kernel.inspectMemoryGroup(admittedGroup!) }); }
                  catch (error) { reject(error); }
                  finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
                }, 0);
              }
            } : undefined,
            onTerminated: signal => {
              if (options.execSignal) {
                if (kernel.recordMemoryGroupCrash(previousRoot, 11) !== -3) throw Error('Retired exec accepted a late crash');
                kernel.finalizeExecHandoffTermination(request.pid);
                lifecycleEvidence.push({ kind: 'exec-late-exit-finished', code: kernelExit });
              }
              for (const thread of previousThreads) { stoppedWithProcess.add(thread.tid); retiredThreads.add(thread.tid); }
              execTermination = { signal }; quiescent = true; rootJoined = options.joinOnExit;
              imageHandles.delete(request.pid); rootHandle = undefined; generation = undefined;
              currentExecWorker = undefined; processWorker = undefined; importWorker = undefined;
              execHandoff = false; maybeComplete();
            },
            retirePreviousReferences: async () => {
              // This async closer is joined by physical retirement. Real
              // public ingress runs after deactivation, while old pages are
              // still owned; it must not publish or replace the cached signal.
              if (options.execSignal) {
                const signal = await retryKernelEntryResult(() => kernel.finalizeExecHandoffTermination(request.pid));
                kernel.notifyHostProcessCrashed(request.pid, 11);
                const repeated = await retryKernelEntryResult(() => kernel.finalizeExecHandoffTermination(request.pid));
                const backing = (await memoryEvidence()).backing;
                if (signal !== 9 || repeated !== 9 || kernelExit !== undefined || backing?.images !== 1) {
                  throw Error(`Late retirement ingress lost exec ownership: ${signal}/${repeated}/${kernelExit}/${backing?.images}`);
                }
                lifecycleEvidence.push({ kind: 'exec-late-exit-held', signal, repeated, backing });
              }
              previousImport?.close();

            },
            onRetired: async () => {
              for (const thread of previousThreads) { stoppedWithProcess.add(thread.tid); retiredThreads.add(thread.tid); }
              execHandoffs.push({ step: execHandoffs.length + 1, ...await memoryEvidence() });
            },
            isCurrent: worker => currentExecWorker === worker,
            retain: worker => {
              if (!lifecycleActive) throw Error('Exec cannot publish into a retired embedding');
              execReplacementPublications++;
              currentExecWorker = worker; processWorker = worker.worker; generation = worker.generation;
              rootHandle = worker.handle; imageHandles.set(request.pid, worker.handle);
              importWorker = undefined; processLayout = request.groupedExec!.layout;
              processReady = false; processExit = undefined; quiescent = false; rootJoined = false; execHandoff = false;
            },
            onMessage: (message, worker) => {
              if (currentExecWorker !== worker || execHandoff) return;
              if (message.type === 'ready') processReady = message.pid === worker.pid;
              else if (message.type === 'exit') processExit = message.status;
              else if (message.type === 'memory_quiescent') quiescent = worker.quiescent;
              else if (message.type === 'error') reject(Error(message.message));
              maybeComplete();
            },
            onError: reject,
            onExit: (code, worker) => {
              if (currentExecWorker !== worker || execHandoff) return;
              if (code !== 0) reject(Error(`Exec Worker exit ${code}`));
              else { rootJoined = worker.hasJoined; maybeComplete(); }
            },
          });
        } : options.execPrecommitFailure ? async request => {
          if (!request.groupedExec) throw Error('Grouped exec lost opaque preparation');
          execPreparations.push({ layout: request.groupedExec.layout, ...await memoryEvidence() });
          if (options.execPrecommitStop) {
            const stop = (async () => {
              if (!rootHandle || !rollbackPoolMemory) throw Error('Missing actual precommit predecessor');
              const premature = await retryKernelEntryResult(() => options.execPrecommitStop === 'retire'
                ? kernel.retireMemoryGroupImage(rootHandle!, () => { throw Error('Live predecessor released references'); })
                : kernel.deactivateMemoryGroupProcess(rootHandle!));
              if (premature !== (options.execPrecommitStop === 'retire' ? -16 : false)) throw Error('Live precommit predecessor was deactivated');
              lifecycleEvidence.push({ kind: 'precommit-live-refused', ...await memoryEvidence() });
              if (!await retryKernelEntryResult(() => kernel.signalProcess(request.pid, 9))) throw Error('Precommit SIGKILL refused');
              await kernel.waitForMemoryGroupReplicaQuiescence(rootHandle);
              if (options.joinOnExit && !rootJoined) await new Promise<void>((resolve, fail) => {
                processWorker!.on('exit', code => code === 0 ? resolve() : fail(Error(`Precommit Worker exit ${code}`)));
              });
              const lock = new Int32Array(rollbackPoolMemory.buffer, MEMORY_GROUP_CONTROL, 1);
              if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) throw Error('Precommit fixture did not acquire pool lock');
              setTimeout(() => {
                try { lifecycleEvidence.push({ kind: 'precommit-stop-pool-lock-released', admission: kernel.inspectMemoryGroup(admittedGroup!) }); }
                catch (error) { reject(error); }
                finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
              }, 0);
              if (options.execPrecommitStop === 'retire') {
                const retired = await retryKernelEntryResult(() => kernel.retireMemoryGroupImage(rootHandle!, () => {
                  importWorker?.close(); if (generation) owner.releaseGeneration(generation);
                  lifecycleEvidence.push({ kind: 'precommit-host-references-released' });
                }));
                if (retired !== 0) throw Error(`Stopped precommit predecessor retirement refused: ${retired}`);
              } else {
                const deactivated = await retryKernelEntryResult(() => kernel.deactivateMemoryGroupProcess(rootHandle!));
                if (!deactivated) throw Error('Stopped precommit predecessor deactivation refused');
              }
              lifecycleEvidence.push({ kind: 'precommit-stopped-image-deactivated', ...await memoryEvidence() });
              execPrecommitStopFinished = true; maybeComplete();
            })();
            evidenceWork.push(stop); await stop;
          }
          if (options.execPoolRollback) {
            if (!rollbackPoolMemory) throw Error('Missing actual grouped exec backing');
            const lock = new Int32Array(rollbackPoolMemory.buffer, MEMORY_GROUP_CONTROL, 1);
            if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) throw Error('Exec fixture did not acquire its pool lock');
            setTimeout(() => {
              try { lifecycleEvidence.push({ kind: 'exec-pool-lock-released', admission: kernel.inspectMemoryGroup(admittedGroup!) }); }
              catch (error) { reject(error); }
              finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
            }, 0);
          }
          return -13; // deliberate embedding refusal after real physical preparation
        } : undefined,
        onThreadExit: (pid, tid, _channelOffset) => {
          const thread = threads.get(tid);
          if (!thread || thread.pid !== pid) return false;
          // Register before another clone can reserve a fresh control row.
          // Actual cleanup still awaits the exact stop and real Node join.
          logicalThreadExits.add(tid); retireThread(tid, thread); return true;
        },
        onSyscallBlocked: lifecycleEnabled ? (pid, tid, syscallNr, firstArgument, owner) => {
          parkedCalls.push({ pid, tid, syscallNr, firstArgument: Number(firstArgument), owner });
          queueMicrotask(() => { void advanceLifecycle().catch(reject); });
        } : undefined,
        onExit: (pid, code) => {
          if (pid === rootPid) {
            kernelExit = code;
            if (options.execSignal) {
              const sample = (async () => {
                const backing = (await memoryEvidence()).backing;
                if (backing?.images !== 0 || [...threads.values()].some(thread => !thread.quiescent)) {
                  throw Error('Exec signal notification preceded exact image retirement');
                }
                lifecycleEvidence.push({ kind: 'exec-termination-published', code, backing });
                maybeComplete();
              })();
              evidenceWork.push(sample); void sample.catch(reject); return;
            }
            kernelExit = code;
          }
          else {
            childStates.set(pid, { ...childStates.get(pid), kernelExit: code });
            if (options.anonymousShared) {
              const child = children.get(pid);
              if (!child?.quiescent) return reject(Error('Shared child exit preceded its exact fence'));
              const handle = imageHandles.get(pid);
              if (!handle) return reject(Error('Shared child lost its exact image capability'));
              const retirement = (async () => {
                for (;;) {
                  const status = await retryKernelEntryResult(() => kernel.retireMemoryGroupImage(handle, async () => {

                    // Its real terminal fence preceded this callback. Detach
                    // embedding observers before intentional realm termination;
                    // physical retirement still joins the actual Node stop.
                    await child.contain();
                  }));
                  if (status === 0) break;
                  if (status !== -16) throw Error(`Shared child retirement refused: ${status}`);
                  await new Promise<void>(resolve => setTimeout(resolve, 0));
                }
                imageHandles.delete(pid);
                lifecycleEvidence.push({ ...await memoryEvidence(), kind: 'shared-child-retired', pid, code });
                anonymousChildRetired(); maybeComplete();
              })();
              processDeactivations.push(retirement); void retirement.catch(reject);
            }
            if (lifecycleEnabled) {
              const child = children.get(pid);
              if (!child?.quiescent) return reject(Error('Grouped signal exit preceded exact Worker fence'));
              lifecycleEvidence.push({ kind: 'kernel-exit-after-stop', pid, code, quiescent: child.quiescent });
              if (options.nativeWaitLifecycle) {
                const members = [...threads.values()].filter(thread => thread.pid === pid);
                if (members.some(thread => !thread.quiescent)) return reject(Error('Grouped process exit preceded a pthread stop fence'));
                const handle = imageHandles.get(pid);
                if (!handle) return reject(Error('Stopped process lost its exact image'));
                // Process death ends transport ownership before individual
                // thread-control recycling. This deactivates only that image;
                // its pages and real wait/observer fences remain charged.
                const deactivation = retryKernelEntryResult(() => kernel.deactivateMemoryGroupProcess(handle)).then(deactivated => {
                  if (!deactivated) throw Error('Exact stopped process deactivation refused');
                  for (const thread of members) if (!threadExits.has(thread.tid)) stoppedWithProcess.add(thread.tid);
                  lifecycleEvidence.push({ kind: 'stopped-image-deactivated', pid }); maybeComplete();
                });
                processDeactivations.push(deactivation); void deactivation.catch(reject);
              }
              if (busyProbe?.pid === pid) {
                const address = busyProbe.address;
                void retryKernelEntryResult(() => kernel.inspectMemoryGroupWord(imageHandles.get(pid)!, address)).then(value => {
                  if (value < 0) return reject(Error(`Stopped word inspection refused: ${value}`));
                  busyStopValue = value; lifecycleEvidence.push({ kind: 'busy-stopped-word', pid, value }); maybeComplete();
                }, reject);
              }
            }
          }
          trace.push(...kernel.drainSyscallTrace().map(event => event.decoded ?? `syscall ${event.nr}`));
          maybeComplete();
        },
        onKernelFatal: error => { kernelFailed = true; reject(error); },
        onGroupedClone: async attachment => {
          await Promise.all(threadRetirements.values());
          const processGeneration = attachment.pid === rootPid ? generation : children.get(attachment.pid)?.generation;
          if (!processGeneration || !processLayout) throw Error('Missing exact grouped pthread process image');
          const before = await memoryEvidence();
          const failBeforePublication = options.threadPoolRollback && ++threadPreparationAttempts % 2 === 1;
          if (failBeforePublication) failedControlInitializations.add(attachment.tid);
          if (options.threadPoolRollback && !restoreThreadInitializationFault) {
            // Refuse the real foreign fill issued by Rust initialization, with
            // the allocator lock held until the next actual Worker turn.
            const operation = GroupMemoryTransport.prototype.operation;
            const fill = GroupMemoryResources.prototype.fill;
            const preparingThreads = new Map<bigint, number>();
            let preparingThread: number | undefined;
            GroupMemoryTransport.prototype.operation = function(this: GroupMemoryTransport, ...args: Parameters<typeof operation>) {
              const request = args[5], protocol = MEMORY_GROUP_PROTOCOL.driver;
              const thread = request?.kind === protocol.kinds.threadPrepare ? request.thread : preparingThreads.get(args[2]);
              preparingThread = thread;
              try {
                const result = operation.apply(this, args);
                if (result && thread !== undefined) preparingThreads.set(result.operation, thread);
                if (args[1] === protocol.commands.ack) preparingThreads.delete(args[2]);
                return result;
              } finally { preparingThread = undefined; }
            };
            GroupMemoryResources.prototype.fill = function(this: GroupMemoryResources, ...args: Parameters<typeof fill>) {
              if (preparingThread !== undefined && failedControlInitializations.has(preparingThread)
                  && this.memory(args[0]) === rollbackPoolMemory) {
                const lock = new Int32Array(rollbackPoolMemory!.buffer, MEMORY_GROUP_CONTROL, 1);
                // Reservation now belongs to this same driver. Leave its
                // mutex-protected page allocation intact; fail the subsequent
                // unlocked control initialization and hold the mutex afterward.
                if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) return fill.apply(this, args);
                failedControlInitializations.delete(preparingThread);
                const attempt = ++injectedThreadRefusals;
                setTimeout(() => {
                  try { lifecycleEvidence.push({ kind: 'thread-pool-lock-released', attempt,
                    admission: kernel.inspectMemoryGroup(admittedGroup!) }); }
                  catch (error) { reject(error); }
                  finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
                }, 0);
                throw new GroupMemoryResourceError(ERRNO.ENOMEM);
              }
              return fill.apply(this, args);
            };
            restoreThreadInitializationFault = () => {
              GroupMemoryTransport.prototype.operation = operation;
              GroupMemoryResources.prototype.fill = fill;
            };
          }
          try { await launchGroupedThreadWorker({ kernel, attachment, adapter: threadAdapter, imports, generation: processGeneration,
            programBytes: options.programBytes, terminationProvesQuiescence: options.joinOnExit,
            isCurrent: thread => threads.get(thread.tid) === thread,
            retain: thread => {
              threads.set(thread.tid, thread); retainedThreadLaunches++;
              if (retainedThreadLaunches % 2 === 1 && injectedThreadRefusals < (options.rejectThreadLaunchCount ?? 0)) {
                injectedThreadRefusals++; throw Error('fixture refusal after thread publication');
              }
            },
            discard: thread => {
              failedThreadWorkers.push({ tid: thread.tid, executionAbsent: thread.executionAbsent, quiescent: thread.quiescent, joined: thread.hasJoined });
              if (threads.get(thread.tid) === thread) threads.delete(thread.tid);
            },
            onMessage: (message, thread) => {
              if (message.type === 'thread_exit') {
                if (message.pid !== thread.pid || message.tid !== thread.tid) return reject(Error('Wrong pthread exit'));
                threadExits.add(thread.tid);
              } else if (message.type === 'error') return reject(Error(message.message));
              maybeComplete();
            },
            onError: reject,
            onExit: (code, thread) => {
              // The shared exec helper joins this exact old Worker only
              // after all image fences. Node terminate() may then report 1;
              // that host-realm outcome is not a guest pthread failure.
              if (code !== 0 && !(execRetiringThreads.has(thread) && thread.quiescent)) reject(Error(`pthread Worker exit ${code}`));
              else maybeComplete();
            },
          }); } catch (error) {
            if (options.uncertainThreadConstructor) {
              const thread = threads.get(attachment.tid);
              if (thread) failedThreadWorkers.push({ tid: thread.tid, executionAbsent: thread.executionAbsent, quiescent: thread.quiescent, joined: thread.hasJoined });
            }
            failedThreadLaunches.push({ before, after: await memoryEvidence(), cause: String(error) });
            throw error;
          }
        },
        onGroupedFork: async request => {
          if (options.rejectForkStage === 'pool' && injectedForkRefusals < options.rejectForkLaunchCount!) {
            if (!rollbackPoolMemory) throw Error('Missing actual grouped rollback backing');
            const lock = new Int32Array(rollbackPoolMemory.buffer, MEMORY_GROUP_CONTROL, 1);
            if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) throw Error('Fixture did not acquire its pool lock');
            const attempt = ++injectedForkRefusals;
            // This fixture owns Q. Rejection must retain the exact child until
            // a later Worker turn releases Q; elapsed time is not stop proof.
            setTimeout(() => {
              try {
                const admission = kernel.inspectMemoryGroup(admittedGroup!);
                lifecycleEvidence.push({ kind: 'fork-pool-lock-released', attempt, admission });
              } catch (error) { reject(error); }
              finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
            }, 0);
            throw Error('fixture grouped fork pool refusal');
          }
          const expectedCrash = options.forcedLifecycle && children.size === 2;
          const recordCrash = (pid: number, message: string) => {
            if (!expectedCrash || !/unreachable/i.test(message)) throw Error(message);
            void retryKernelEntryResult(() => kernel.recordMemoryGroupCrash(request.childReplica)).then(status => {
              if (status !== 0) return reject(Error(`Exact crash refused: ${status}`));
              lifecycleEvidence.push({ kind: 'actual-wasm-crash', pid, message }); maybeComplete();
            }, reject);
          };
          imageHandles.set(request.childPid, request.childReplica);
          let refused: Error | undefined;
          // A test-owned facade routes normal operations to the real kernel.
          // Its refusal happens after publication, before registration or replay commit;
          // no production method/prototype or source is replaced.
          const forkKernel = options.rejectForkLaunchCount ? Object.fromEntries([
            'runMemoryGroupForkLaunch', 'observeMemoryGroupReplicaWorker', 'sealMemoryGroupReplicaWorkerAbsence', 'registerMemoryGroupProcess',
            'processSecureExec', 'getKernelAbiVersion', 'getKernelAbiContractDigest',
            'startMemoryGroupProcessWorkerWhenRunnable', 'shouldLaunchPendingChild',
            'requestMemoryGroupReplicaWorkerStop', 'waitForMemoryGroupReplicaQuiescence', 'deactivateMemoryGroupProcess', 'releaseMemoryGroupWorkerReferences',
          ].map(name => [name, (...args: any[]) => {
            if (name === 'runMemoryGroupForkLaunch' && options.rejectForkStage === 'replay') {
              const [request, platform] = args as Parameters<CentralizedKernelWorker['runMemoryGroupForkLaunch']>;
              return kernel.runMemoryGroupForkLaunch(request, { ...platform, waitReplay: async () => {
                await platform.waitReplay();
                if (injectedForkRefusals < options.rejectForkLaunchCount!) {
                  injectedForkRefusals++; refused = Error('fixture grouped fork replay refusal'); throw refused;
                }
              } });
            }
            if (options.rejectForkStage !== 'replay' && name === 'registerMemoryGroupProcess' && args[0] === request.childReplica
                && injectedForkRefusals < options.rejectForkLaunchCount!) {
              injectedForkRefusals++; refused = Error('fixture grouped fork registration refusal'); throw refused;
            }
            return Reflect.apply((kernel as any)[name], kernel, args);
          }])) as unknown as CentralizedKernelWorker : kernel;
          try {
            const parentGeneration = request.parentPid === rootPid ? generation : children.get(request.parentPid)?.generation;
            if (!parentGeneration || !processLayout) throw Error('Missing exact grouped fork parent');
            await launchGroupedForkWorker({ kernel: forkKernel, request, adapter: { createWorker: init => { forkWorkerConstructionAttempts++; return adapter.createWorker(init); } }, externrefs: owner, imports, parentGeneration,
              programBytes: options.programBytes,
              maximumVirtualPages: processLayout.maximumPages, terminationProvesQuiescence: options.joinOnExit,
              isCurrent: child => children.get(child.pid) === child,
              retain: child => { children.set(child.pid, child); if (!childStates.has(child.pid)) childStates.set(child.pid, {}); },
              discard: child => { if (children.get(child.pid) === child) { children.delete(child.pid); childStates.delete(child.pid); imageHandles.delete(child.pid); } },
              onMessage: (message, child) => {
                const state = childStates.get(child.pid)!;
                if (message.type === 'ready') state.ready = message.pid === child.pid;
                else if (message.type === 'exit') { if (message.pid !== child.pid) return reject(Error('Wrong child exit')); state.processExit = message.status; }
                else if (message.type === 'error') recordCrash(child.pid, String(message.message));
                maybeComplete();
              },
              onError: (error, child) => { try { recordCrash(child.pid, error.message); } catch (failure) { reject(failure); } },
              onExit: (code, _child) => { if (code !== 0) reject(Error(`Child Worker exit ${code}`)); else maybeComplete(); },
            });
            return;
          } catch (error) { if (error !== refused) reject(error); throw error; }
        },
      };
      const kernel = machine?.kernel ?? new CentralizedKernelWorker({ maxWorkers: 4, dataBufferSize: 65536,
        useSharedMemory: true, kernelMaxPages: 1024 }, options.io, callbacks);
      if (machine) {
        if (machine.callbacks) Object.assign(machine.callbacks, callbacks);
        else { machine.kernel = kernel; machine.callbacks = callbacks; }
      }
      kernelForDiagnostics = kernel;
      void (async () => {
        // Compose through the normal image writer, inside this disposable
        // realm. A real root namespace is needed to reach kernel tmpfs on both
        // hosts; an empty browser host adapter cannot stand in for `/`.
        if (!machine?.initialized) {
          const imageBytes = await (async () => {
            const image = KandeloImageFs.create(new Uint8Array(options.imageModuleBytes));
            image.mkdir("/tmp", 0o1777);
            if (options.execPrecommitFailure || options.execSuccess) {
              image.mkdir('/bin', 0o755);
              image.writeFile('/bin/grouped-exec-target', new Uint8Array(options.execTargetBytes ?? options.programBytes), 0o755);
            }
            try { return await image.saveImage(); } finally { image.reset(); }
          })();
          kernel.configureRootfsOverlay(() => -2, [], false, imageBytes.byteLength, (offset, output) => {
            const count = Math.min(output.length, Math.max(0, imageBytes.byteLength - offset));
            output.set(imageBytes.subarray(offset, offset + count)); return count;
          });
          await kernel.init(options.kernelBytes);
          if (options.trace) kernel.enableSyscallTrace();
          if (machine) machine.initialized = true;
        }
        kernel.setOutputCallbacks({
          onStdout: bytes => {
            stdout += new TextDecoder().decode(bytes);
            if (options.anonymousShared) {
              const match = /anonymous-phase (\d+)\n$/.exec(stdout);
              if (match && !anonymousPhases.has(Number(match[1]))) {
                const phase = Number(match[1]); anonymousPhases.add(phase);
                void (async () => {
                  if (phase === 5) await anonymousRetirement;
                  lifecycleEvidence.push({ kind: 'anonymous-shared-phase', phase, ...await memoryEvidence() });
                  kernel.appendStdinData(rootPid!, Uint8Array.of(107));
                })().catch(reject);
              }
            }
            if (options.execOldThreads) {
              const match = /exec-ready step=(\d+) busy=(\d+) ready32=(\d+) ready64=(\d+) returned=(\d+)\n$/.exec(stdout);
              if (match) {
                execThreadProbe = { step: Number(match[1]), busy: Number(match[2]), ready32: Number(match[3]),
                  ready64: Number(match[4]), returned: Number(match[5]), released: false };
                queueMicrotask(() => { void advanceExecThreads().catch(reject); });
              }
            }
            if (options.execPrecommitFailure && /exec-returned \d+\n$/.test(stdout)) {
              const attempt = Number(/exec-returned (\d+)\n$/.exec(stdout)![1]);
              const sample = (async () => {
                execReturns.push({ attempt, ...await memoryEvidence() });
                kernel.appendStdinData(rootPid!, Uint8Array.of(107));
              })();
              evidenceWork.push(sample); void sample.catch(reject);
            }
            if (options.rejectForkStage && /fork-rollback-sample \d+\n$/.test(stdout)) {
              const pid = rolledBackPids.shift();
              if (pid === undefined) throw Error('Rollback checkpoint has no exact child event');
              const sample = (async () => {
                let evidence = await memoryEvidence();
                while (evidence.backing?.nativeObservers) {
                  await new Promise<void>(resolve => setTimeout(resolve, 0));
                  evidence = await memoryEvidence();
                }
                rolledBackForks.push({ ...evidence, pid });
                kernel.appendStdinData(rootPid!, Uint8Array.of(107));
              })();
              evidenceWork.push(sample); void sample.catch(reject);
            }
            if (lifecycleEnabled) queueMicrotask(() => { void advanceLifecycle().catch(reject); });
          },
          onStderr: bytes => { stderr += new TextDecoder().decode(bytes); },
        });
        const { programBytes, ordinaryBytes: ordinary } = options;
        let layout!: ReturnType<typeof computeProcessMemoryLayout>;
        const pid = status(kernel.createProcess(CAPTURED_STDIO), "create process");
        rootPid = pid;
        const argv = ["grouped-sdk-mapping", grouped ? "grouped" : "ordinary",
          ...(options.execPrecommitFailure ? [options.execPrecommitFailure] : options.execSuccess ? ['success'] : [])], env = ["PATH=/bin"];
        status(await retryKernelEntryResult(() => kernel.attachProgram(pid, { bytes: new Uint8Array(programBytes), name: argv[0] })), "attach executable");
        const registration = () => ({ ...layout, ptrWidth: 4 as const, argv, env });
        let launch: GroupReplicaLaunch | undefined;
        if (grouped) {
          let group = machine?.group;
          if (group === undefined) {
            status(kernel.configureMemoryGroups(options.physicalPages ?? 2048, 1), "configure groups");
            group = status(kernel.createMemoryGroup(options.physicalPages ?? 2048, 4, 8), "create group");
            status(kernel.createMemoryGroupBacking(group), "create backing");
            if (machine) machine.group = group;
          }
          admittedGroup = group;
          const prepared = await kernel.prepareMemoryGroupRoot(group, pid, options.maximumVirtualPages ?? 2048, 1024);
          if (typeof prepared === 'number') throw new Error(`prepare root: ${prepared}`);
          const { handle } = prepared; layout = prepared.layout;
          rootHandle = handle;
          imageHandles.set(pid, handle);

        } else {
          layout = computeProcessMemoryLayout({ ptrWidth: 4, maxPages: options.maximumVirtualPages ?? 2048,
            programBytes: ordinary, heapBase: extractHeapBase(ordinary) });
          kernel.registerProcess(pid, createProcessMemory(4, layout), [layout.channelOffset], registration());
        }
        processLayout = layout;
        const secureExec = await retryKernelEntryResult(() => kernel.processSecureExec(pid));
        let init!: Omit<CentralizedWorkerInitMessage, "memory">;
        const connectImports = () => {
          kernel.installHostStdinPipe(pid);
          if (lifecycleEnabled || options.execPrecommitFailure || options.execOldThreads || options.anonymousShared || options.rejectForkStage) kernel.appendStdinData(pid, new Uint8Array());
          else kernel.setStdinData(pid, new Uint8Array());
          generation = owner.startGeneration(pid);
          const currentGeneration = generation;
          importWorker = imports.createWorker({ pid, generationId: generation.id,
            authorizeSender: () => {
              if (!processWorker || generation !== currentGeneration) throw new Error("stale fixture sender");
            }, onDiagnostic: error => diagnostics.push(String(error)) });
          init = { type: "centralized_init", pid, programBytes, channelOffset: layout.channelOffset,
            secureExec, argv, env, ptrWidth: 4, externrefGenerationId: generation.id, forkHostImports: importWorker.init,
            kernelAbiVersion: kernel.getKernelAbiVersion(), kernelAbiContractDigest: kernel.getKernelAbiContractDigest() ?? undefined };
        };
        const attachListeners = () => {
        const initialWorker = processWorker!;
        initialWorker.on("message", (message: any) => {
          if (processWorker !== initialWorker || execHandoff) return;
          if (message.type === "fork_host_import") {
            if (!importWorker!.dispatch(message.wake)) reject(new Error("stale host-import wake"));
          } else if (message.type === "ready") processReady = message.pid === pid;
          else if (message.type === "exit") processExit = message.status;
          else if (message.type === "error") reject(new Error(message.message));
          else if (message.type === "memory_quiescent") {
            if (message.pid !== pid || message.tid !== undefined) return reject(new Error("wrong terminal Worker"));
            if (launch) {
              for (const key of ["group", "pid", "tid", "serial", "generation"] as const) {
                if (message.memoryGroup?.[key] !== launch.expectation.receipt[key]) return reject(new Error("wrong terminal group receipt"));
              }
            }
            quiescent = true;
          }
          maybeComplete();
        });
        initialWorker.on("error", reject);
        initialWorker.on("exit", code => {
          if (processWorker !== initialWorker || execHandoff) return;
          if (code !== 0) reject(new Error(`process Worker exit ${code}`)); else { rootJoined = options.joinOnExit; maybeComplete(); }
        });
        };
        if (grouped) {
          let native!: WorkerHandle, readiness!: Promise<void>;
          const worker = new DeferredWorkerHandle(() => {
            if (!launch) throw Error('Root fixture lacks kernel publication');
            const { assertLive: _live, ...expected } = launch.expectation;
            native = processAdapter.createWorker(createGroupedWorkerPrepare(expected));
            readiness = waitForGroupedWorkerReady(native, expected);
            void readiness.catch(() => {});
            return native;
          });
          processWorker = worker;
          await kernel.runMemoryGroupRootLaunch(rootHandle!, {
            publishTransport: value => {
              launch = value;
              if (options.rejectForkStage === 'pool' || options.threadPoolRollback || options.execPoolRollback || options.execTerminationPool || options.execPrecommitStop) rollbackPoolMemory = value.envelope.memory;
            },
            bindWorker: () => kernel.observeMemoryGroupReplicaWorker(rootHandle!, worker, { terminationProvesQuiescence: options.joinOnExit }),
            registerProcess: () => kernel.registerMemoryGroupProcess(rootHandle!, [layout.channelOffset], registration()),
            connectImports: () => { connectImports(); attachListeners(); },
            startWorker: () => { if (!worker.start()) throw Error('Root fixture start cancelled'); },
            waitReady: () => readiness,
            deliverLaunch: () => {
              if (!launch) throw Error('Root fixture lost kernel publication');
              native.postMessage(createGroupedWorkerLaunch(init, launch.envelope));
            },
            sealAbsence: () => kernel.sealMemoryGroupReplicaWorkerAbsence(rootHandle!, worker),
            retireImage: async () => { status(await retryKernelEntryResult(() => kernel.retireMemoryGroupImage(rootHandle!)), 'retire fixture root'); },
            discardTransport: () => { imageHandles.delete(pid); },
            containFailure: cause => kernel.containMemoryGroupLaunchFailure(cause),
          });
        } else {
          connectImports();
          const memory = kernel.getProcessMemory(pid);
          if (!memory) throw new Error("ordinary process registration lost Memory");
          processWorker = processAdapter.createWorker({ ...init, memory });
          attachListeners();
        }
      })().catch(reject);
    });
    await execution;
    // An exit callback can precede a deferred exact-image deactivation. Join
    // every owner before releasing images or beginning another cohort.
    await Promise.all(processDeactivations);
    lifecycleActive = false;
    if (busyProbe && busyStopValue !== undefined) {
      const value = kernelForDiagnostics!.inspectMemoryGroupWord(imageHandles.get(busyProbe.pid)!, busyProbe.address);
      if (value !== busyStopValue) throw Error('Busy child changed its word after published stop');
      lifecycleEvidence.push({ kind: 'busy-still-stopped', pid: busyProbe.pid, value });
    }
    let execLedger: unknown;
    if (options.execPrecommitFailure) {
      await kernelForDiagnostics!.waitForMemoryGroupReplicaQuiescence(rootHandle!);
      execLedger = await retryKernelEntryResult(() => kernelForDiagnostics!.inspectMemoryGroup(admittedGroup!));
    } else if (options.execSignal) {
      execLedger = await retryKernelEntryResult(() => kernelForDiagnostics!.inspectMemoryGroup(admittedGroup!));
    }
    await Promise.all(evidenceWork);
    let retirement: Record<string, unknown> | undefined;
    if (grouped) {
      const before = await memoryEvidence();
      const statuses: number[] = [];
      for (const [pid, handle] of imageHandles) {
        const releaseReferences = () => {

          if (pid === rootPid) {

            importWorker?.close(); if (generation) owner.releaseGeneration(generation);
          }
        };
        const status = await retryKernelEntryResult(() => kernelForDiagnostics!.retireMemoryGroupImage(handle, releaseReferences));
        statuses.push(status);
        if (status !== 0) throw Error(`Image retirement refused: ${status}`);
      }
      retirement = { before, after: await memoryEvidence(), statuses };
    }
    result = { grouped, stdout, stderr, kernelExit, processExit, quiescent, processReady, diagnostics, trace, execPreparations, execReturns, execHandoffs, execTermination, execReplacementPublications, processWorkerConstructionAttempts, execLedger, memory: await memoryEvidence(),
      retirement, threadRetirementMemory, rolledBackForks, injectedForkRefusals, forkWorkerConstructionAttempts, lifecycleEvidence, parkedCalls, failedThreadLaunches, failedThreadWorkers, threadConstructionAttempts,
      threads: [...threads].map(([tid, thread]) => ({ pid: thread.pid, tid, exited: threadExits.has(tid), logicalExited: logicalThreadExits.has(tid), stoppedWithProcess: stoppedWithProcess.has(tid), quiescent: thread.quiescent, joined: thread.hasJoined, retired: retiredThreads.has(tid) })),
      children: [...children].map(([pid, child]) => ({ pid, ...childStates.get(pid), quiescent: child.quiescent, joined: child.hasJoined })) };
  } catch (error) {
    const failureCauses: string[] = [];
    for (let cause = error; cause instanceof Error && failureCauses.length < 8; cause = cause.cause) {
      failureCauses.push(`${cause.name}: ${cause.message}`);
    }
    if (!kernelFailed) trace.push(...(kernelForDiagnostics?.drainSyscallTrace() ?? []).map(event => event.decoded ?? `syscall ${event.nr}`));
    let failedMemory: Record<string, unknown>;
    try { failedMemory = await memoryEvidence(); }
    catch (inspectionError) {
      failedMemory = { group: admittedGroup, pid: rootPid, inspectionError: String(inspectionError),
        ...(error instanceof MemoryGroupProtocolFault && error.retainedBacking
          ? { backing: error.retainedBacking, snapshot: 'before-fatal-latch' } : {}) };
    }
    result = { grouped, stdout, stderr, kernelExit, processExit, quiescent, processReady, diagnostics, trace, execPreparations, execReturns, execHandoffs, execTermination, execReplacementPublications, processWorkerConstructionAttempts, memory: failedMemory,
      rolledBackForks, injectedForkRefusals, forkWorkerConstructionAttempts, lifecycleEvidence, parkedCalls, failedThreadLaunches, failedThreadWorkers, threadConstructionAttempts,
      threads: [...threads].map(([tid, thread]) => ({ pid: thread.pid, tid, exited: threadExits.has(tid), logicalExited: logicalThreadExits.has(tid), stoppedWithProcess: stoppedWithProcess.has(tid), quiescent: thread.quiescent, joined: thread.hasJoined, retired: retiredThreads.has(tid) })),
      children: [...children].map(([pid, child]) => ({ pid, ...childStates.get(pid), quiescent: child.quiescent, joined: child.hasJoined })),
      failureCauses, failureMessage: error instanceof Error ? error.message : String(error),
      failure: error instanceof Error ? error.stack : String(error) };
  } finally {
    restoreThreadInitializationFault?.();
    lifecycleActive = false;
    if (deadline) clearTimeout(deadline);
    if (probeTimer) clearTimeout(probeTimer);
    await processWorker?.terminate();

    for (const thread of threads.values()) { await thread.contain();  }
    for (const child of children.values()) { await child.contain();  }
    importWorker?.close();
    if (generation) owner.releaseGeneration(generation);
    if (machine?.callbacks) {
      for (const key of Object.keys(machine.callbacks) as (keyof CentralizedKernelCallbacks)[]) delete machine.callbacks[key];
      machine.kernel?.setOutputCallbacks({});
    }
  }
  return result;
}
