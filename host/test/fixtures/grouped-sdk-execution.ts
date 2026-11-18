import { CAPTURED_STDIO, CentralizedKernelWorker, type CentralizedKernelCallbacks } from "../../src/kernel-worker";
import type { WorkerAdapter, WorkerHandle } from "../../src/worker-adapter";
import type { PlatformIO } from "../../src/types";
import { computeProcessMemoryLayout, createProcessMemory } from "../../src/process-memory";
import { extractHeapBase } from "../../src/constants";
import { ABI_SYSCALLS } from "../../src/generated/abi";
import { ForkExternrefProcessOwner } from "../../src/fork-externref-process-owner";
import { ForkHostImportOwnerRuntime, type ForkHostImportOwnerWorker } from "../../src/fork-host-import-runtime";
import { createGroupedWorkerLaunch, createGroupedWorkerPrepare, waitForGroupedWorkerReady } from "../../src/grouped-worker-initialization";
import type { CentralizedWorkerInitMessage } from "../../src/worker-protocol";
import { retryKernelEntryResult } from "../../src/kernel-entry-retry";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { launchGroupedForkWorker, type GroupedForkWorkerOwnership } from '../../src/grouped-fork-launch';
import type { PreparedGroupReplica } from '../../src/memory-group-image-store';
import { ThreadPageAllocator } from '../../src/thread-allocator';
import { launchGroupedThreadWorker, type GroupedThreadWorkerOwnership } from '../../src/grouped-thread-launch';

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
  rejectThreadLaunchCount?: number;
  uncertainThreadConstructor?: boolean;
  forcedLifecycle?: boolean;
  nativeWaitLifecycle?: boolean;
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
  const imageHandles = new Map<number, PreparedGroupReplica>();
  const memoryEvidence = () => ({ group: admittedGroup, pid: rootPid, initialVirtualPages: processLayout?.initialPages,
    maximumVirtualPages: processLayout?.maximumPages, declaredThreadSlots: processLayout?.threadSlotCount,
    backing: admittedGroup === undefined ? undefined : kernelForDiagnostics?.inspectMemoryGroupBacking(admittedGroup) });
  const children = new Map<number, GroupedForkWorkerOwnership>();
  const threads = new Map<number, GroupedThreadWorkerOwnership>();
  const threadExits = new Set<number>();
  const logicalThreadExits = new Set<number>();
  const stoppedWithProcess = new Set<number>();
  const threadRetirements = new Map<number, Promise<void>>();
  const processDeactivations: Promise<void>[] = [];
  const retiredThreads = new Set<number>();
  const threadRetirementMemory: Record<string, unknown>[] = [];
  const threadAllocators = new Map<number, ThreadPageAllocator>();
  const childStates = new Map<number, { kernelExit?: number; processExit?: number; ready?: boolean }>();
  const diagnostics: string[] = [];
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
      const retireThread = (tid: number, thread: GroupedThreadWorkerOwnership) => {
        if (threadRetirements.has(tid)) return;
        const retirement = (async () => {
          await kernel.waitForMemoryGroupReplicaQuiescence(thread.handle);
          if (options.joinOnExit) await thread.waitForNodeJoin();
          const result = await retryKernelEntryResult(() => kernel.retireMemoryGroupThread(thread.handle, () => {
            if (!thread.releaseAfterStop()) throw Error('Thread references have no stop proof');
          }));
          if (result !== 0) throw Error(`Thread retirement refused: ${result}`);
          await thread.contain();
          retiredThreads.add(tid); threadRetirementMemory.push({ tid, ...memoryEvidence() });
          maybeComplete();
        })();
        threadRetirements.set(tid, retirement); void retirement.catch(reject);
      };
      const maybeComplete = () => {
        for (const [tid, thread] of threads) {
          if (logicalThreadExits.has(tid) || threadExits.has(tid) || stoppedWithProcess.has(tid)) retireThread(tid, thread);
        }
        if (kernelExit === undefined || processExit === undefined || !quiescent || !processReady
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
      const callbacks: CentralizedKernelCallbacks = {
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
          if (pid === rootPid) kernelExit = code;
          else {
            childStates.set(pid, { ...childStates.get(pid), kernelExit: code });
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
          let allocator = threadAllocators.get(attachment.pid);
          if (!allocator) {
            allocator = new ThreadPageAllocator({ firstSlotStartPage: processLayout.firstThreadSlotPage,
              maxPageExclusive: processLayout.threadArenaEndPage, reservedSlots: processLayout.threadSlotCount, ptrWidth: 4 });
            threadAllocators.set(attachment.pid, allocator);
          }
          const before = memoryEvidence();
          try { await launchGroupedThreadWorker({ kernel, attachment, allocator, adapter: threadAdapter, imports, generation: processGeneration,
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
            onExit: (code, _thread) => { if (code !== 0) reject(Error(`pthread Worker exit ${code}`)); else maybeComplete(); },
          }); } catch (error) {
            if (options.uncertainThreadConstructor) {
              const thread = threads.get(attachment.tid);
              if (thread) failedThreadWorkers.push({ tid: thread.tid, executionAbsent: thread.executionAbsent, quiescent: thread.quiescent, joined: thread.hasJoined });
            }
            failedThreadLaunches.push({ before, after: memoryEvidence(), cause: String(error) });
            throw error;
          }
        },
        onGroupedFork: async request => {
          const expectedCrash = options.forcedLifecycle && children.size === 2;
          const recordCrash = (pid: number, message: string) => {
            if (!expectedCrash || !/unreachable/i.test(message)) throw Error(message);
            void retryKernelEntryResult(() => kernel.recordMemoryGroupCrash(request.childReplica)).then(status => {
              if (status !== 0) return reject(Error(`Exact crash refused: ${status}`));
              lifecycleEvidence.push({ kind: 'actual-wasm-crash', pid, message }); maybeComplete();
            }, reject);
          };
          imageHandles.set(request.childPid, request.childReplica);
          try {
            const parentGeneration = request.parentPid === rootPid ? generation : children.get(request.parentPid)?.generation;
            if (!parentGeneration || !processLayout) throw Error('Missing exact grouped fork parent');
            await launchGroupedForkWorker({ kernel, request, adapter, externrefs: owner, imports, parentGeneration,
              programBytes: options.programBytes, channelOffset: processLayout.channelOffset,
              maximumVirtualPages: processLayout.maximumPages, terminationProvesQuiescence: options.joinOnExit,
              isCurrent: child => children.get(child.pid) === child,
              retain: child => { children.set(child.pid, child); if (!childStates.has(child.pid)) childStates.set(child.pid, {}); },
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
            return [processLayout.channelOffset];
          } catch (error) { reject(error); throw error; }
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
            if (lifecycleEnabled) queueMicrotask(() => { void advanceLifecycle().catch(reject); });
          },
          onStderr: bytes => { stderr += new TextDecoder().decode(bytes); },
        });
        const { programBytes, ordinaryBytes: ordinary } = options;
        const layout = computeProcessMemoryLayout({ ptrWidth: 4, maxPages: 2048,
          programBytes: ordinary, heapBase: extractHeapBase(ordinary) });
        processLayout = layout;
        const pid = status(kernel.createProcess(CAPTURED_STDIO), "create process");
        rootPid = pid;
        const argv = ["grouped-sdk-mapping", grouped ? "grouped" : "ordinary"], env = ["PATH=/bin"];
        const registration = { ...layout, ptrWidth: 4 as const, argv, env };
        let launch: ReturnType<CentralizedKernelWorker["publishMemoryGroupReplica"]> | undefined;
        if (grouped) {
          let group = machine?.group;
          if (group === undefined) {
            status(kernel.configureMemoryGroups(options.physicalPages ?? 2048, 1), "configure groups");
            group = status(kernel.createMemoryGroup(options.physicalPages ?? 2048, 4, 8), "create group");
            status(kernel.createMemoryGroupBacking(group), "create backing");
            if (machine) machine.group = group;
          }
          admittedGroup = group;
          const receipt = kernel.prepareMemoryGroupProcess(group, pid);
          if (typeof receipt === "number") throw new Error(`prepare process: ${receipt}`);
          const handle = kernel.prepareMemoryGroupImage(receipt, { initialVirtualPages: layout.initialPages,
            maximumVirtualPages: layout.maximumPages, scratchBytes: 65536 });
          if (typeof handle === "number") throw new Error(`prepare image: ${handle}`);
          rootHandle = handle;
          imageHandles.set(pid, handle);
          launch = kernel.publishMemoryGroupReplica(handle);
          if (typeof launch === "number") throw new Error(`publish replica: ${launch}`);
          kernel.registerMemoryGroupProcess(handle, [layout.channelOffset], registration);
        } else kernel.registerProcess(pid, createProcessMemory(4, layout), [layout.channelOffset], registration);
        status(kernel.attachProgram(pid, { bytes: new Uint8Array(programBytes), name: argv[0] }), "attach executable");
        const secureExec = await retryKernelEntryResult(() => kernel.processSecureExec(pid));
        kernel.installHostStdinPipe(pid);
        if (lifecycleEnabled) kernel.appendStdinData(pid, new Uint8Array());
        else kernel.setStdinData(pid, new Uint8Array());
        generation = owner.startGeneration(pid);
        const currentGeneration = generation;
        importWorker = imports.createWorker({ pid, generationId: generation.id,
          authorizeSender: () => {
            if (!processWorker || generation !== currentGeneration) throw new Error("stale fixture sender");
          }, onDiagnostic: error => diagnostics.push(String(error)) });
        const init: Omit<CentralizedWorkerInitMessage, "memory"> = {
          type: "centralized_init", pid, programBytes, channelOffset: layout.channelOffset,
          secureExec, argv, env, ptrWidth: 4,
          externrefGenerationId: generation.id, forkHostImports: importWorker.init,
          kernelAbiVersion: kernel.getKernelAbiVersion(),
          kernelAbiContractDigest: kernel.getKernelAbiContractDigest() ?? undefined,
        };
        if (launch && typeof launch !== "number") {
          const { assertLive: _live, ...expected } = launch.expectation;
          processWorker = adapter.createWorker(createGroupedWorkerPrepare(expected));
          // Install ordinary message handling after readiness: that protocol has
          // its own exact receipt check and permits no unrelated message.
          await waitForGroupedWorkerReady(processWorker, expected);
          await retryKernelEntryResult(() => kernel.observeMemoryGroupReplicaWorker(rootHandle!, processWorker!,
            { terminationProvesQuiescence: options.joinOnExit }));
        } else {
          const memory = kernel.getProcessMemory(pid);
          if (!memory) throw new Error("ordinary process registration lost Memory");
          processWorker = adapter.createWorker({ ...init, memory });
        }
        processWorker.on("message", (message: any) => {
          if (message.type === "fork_host_import") {
            if (!importWorker!.dispatch(message.wake)) reject(new Error("stale host-import wake"));
          } else if (message.type === "ready") processReady = message.pid === pid;
          else if (message.type === "exit") processExit = message.status;
          else if (message.type === "error") reject(new Error(message.message));
          else if (message.type === "memory_quiescent") {
            if (message.pid !== pid || message.tid !== undefined) return reject(new Error("wrong terminal Worker"));
            if (launch && typeof launch !== "number") {
              for (const key of ["group", "pid", "tid", "serial", "generation"] as const) {
                if (message.memoryGroup?.[key] !== launch.expectation.receipt[key]) return reject(new Error("wrong terminal group receipt"));
              }
            }
            quiescent = true;
          }
          maybeComplete();
        });
        processWorker.on("error", reject);
        processWorker.on("exit", code => { if (code !== 0) reject(new Error(`process Worker exit ${code}`)); else { rootJoined = options.joinOnExit; maybeComplete(); } });
        if (launch && typeof launch !== "number") processWorker.postMessage(createGroupedWorkerLaunch(init, launch.envelope));
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
    let retirement: Record<string, unknown> | undefined;
    if (grouped) {
      const before = memoryEvidence();
      const statuses: number[] = [];
      for (const [pid, handle] of imageHandles) {
        const releaseReferences = () => {
          for (const thread of threads.values()) if (thread.pid === pid && !thread.releaseAfterStop()) throw Error('Pthread reference retirement is unproven');
          const child = children.get(pid);
          if (child && !child.releaseAfterStop()) throw Error('Child reference retirement is unproven');
          if (pid === rootPid) { importWorker?.close(); if (generation) owner.releaseGeneration(generation); }
        };
        const status = await retryKernelEntryResult(() => kernelForDiagnostics!.retireMemoryGroupImage(handle, releaseReferences));
        statuses.push(status);
        if (status !== 0) throw Error(`Image retirement refused: ${status}`);
      }
      retirement = { before, after: memoryEvidence(), statuses };
    }
    result = { grouped, stdout, stderr, kernelExit, processExit, quiescent, processReady, diagnostics, trace, memory: memoryEvidence(),
      retirement, threadRetirementMemory, lifecycleEvidence, parkedCalls, failedThreadLaunches, failedThreadWorkers, threadConstructionAttempts,
      threads: [...threads].map(([tid, thread]) => ({ pid: thread.pid, tid, exited: threadExits.has(tid), logicalExited: logicalThreadExits.has(tid), stoppedWithProcess: stoppedWithProcess.has(tid), quiescent: thread.quiescent, joined: thread.hasJoined, retired: retiredThreads.has(tid) })),
      children: [...children].map(([pid, child]) => ({ pid, ...childStates.get(pid), quiescent: child.quiescent, joined: child.hasJoined })) };
  } catch (error) {
    if (!kernelFailed) trace.push(...(kernelForDiagnostics?.drainSyscallTrace() ?? []).map(event => event.decoded ?? `syscall ${event.nr}`));
    result = { grouped, stdout, stderr, kernelExit, processExit, quiescent, processReady, diagnostics, trace, memory: memoryEvidence(),
      lifecycleEvidence, parkedCalls, failedThreadLaunches, failedThreadWorkers, threadConstructionAttempts,
      threads: [...threads].map(([tid, thread]) => ({ pid: thread.pid, tid, exited: threadExits.has(tid), logicalExited: logicalThreadExits.has(tid), stoppedWithProcess: stoppedWithProcess.has(tid), quiescent: thread.quiescent, joined: thread.hasJoined, retired: retiredThreads.has(tid) })),
      children: [...children].map(([pid, child]) => ({ pid, ...childStates.get(pid), quiescent: child.quiescent, joined: child.hasJoined })),
      failureMessage: error instanceof Error ? error.message : String(error),
      failure: error instanceof Error ? error.stack : String(error) };
  } finally {
    lifecycleActive = false;
    if (deadline) clearTimeout(deadline);
    if (probeTimer) clearTimeout(probeTimer);
    await processWorker?.terminate();
    for (const thread of threads.values()) { await thread.contain(); thread.releaseAfterStop(); }
    for (const child of children.values()) { await child.contain(); child.releaseAfterStop(); }
    importWorker?.close();
    if (generation) owner.releaseGeneration(generation);
    if (machine?.callbacks) {
      for (const key of Object.keys(machine.callbacks) as (keyof CentralizedKernelCallbacks)[]) delete machine.callbacks[key];
      machine.kernel?.setOutputCallbacks({});
    }
  }
  return result;
}
