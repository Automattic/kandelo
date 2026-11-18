import { CAPTURED_STDIO, CentralizedKernelWorker, type CentralizedKernelCallbacks } from "../../src/kernel-worker";
import type { WorkerAdapter, WorkerHandle } from "../../src/worker-adapter";
import type { PlatformIO } from "../../src/types";
import { computeProcessMemoryLayout, createProcessMemory } from "../../src/process-memory";
import { extractHeapBase } from "../../src/constants";
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
  const threadAllocators = new Map<number, ThreadPageAllocator>();
  const childStates = new Map<number, { kernelExit?: number; processExit?: number; ready?: boolean }>();
  const diagnostics: string[] = [];
  const trace: string[] = [];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let result: Record<string, unknown>;
  try {
    const execution = new Promise<void>((resolve, reject) => {
      const maybeComplete = () => {
        if (kernelExit === undefined || processExit === undefined || !quiescent || !processReady
            || (options.joinOnExit && !rootJoined)) return;
        for (const [pid, child] of children) {
          const state = childStates.get(pid);
          if (state?.kernelExit === undefined || state.processExit === undefined || !state.ready || !child.quiescent
              || (options.joinOnExit && !child.hasJoined)) return;
        }
        for (const [tid, thread] of threads) {
          if (!threadExits.has(tid) || !thread.quiescent || (options.joinOnExit && !thread.hasJoined)) return;
        }
        resolve();
      };
      // The Node exit event joins the exact process Worker. The deadline is a
      // failure/containment boundary, never permission to reuse grouped pages.
      deadline = setTimeout(() => reject(new Error("guest execution deadline")), 60_000);
      const callbacks: CentralizedKernelCallbacks = {
        onExit: (pid, code) => {
          if (pid === rootPid) kernelExit = code;
          else childStates.set(pid, { ...childStates.get(pid), kernelExit: code });
          trace.push(...kernel.drainSyscallTrace().map(event => event.decoded ?? `syscall ${event.nr}`));
          maybeComplete();
        },
        onKernelFatal: error => reject(error),
        onGroupedClone: async attachment => {
          const processGeneration = attachment.pid === rootPid ? generation : children.get(attachment.pid)?.generation;
          if (!processGeneration || !processLayout) throw Error('Missing exact grouped pthread process image');
          let allocator = threadAllocators.get(attachment.pid);
          if (!allocator) {
            allocator = new ThreadPageAllocator({ firstSlotStartPage: processLayout.firstThreadSlotPage,
              maxPageExclusive: processLayout.threadArenaEndPage, reservedSlots: processLayout.threadSlotCount, ptrWidth: 4 });
            threadAllocators.set(attachment.pid, allocator);
          }
          await launchGroupedThreadWorker({ kernel, attachment, allocator, adapter, imports, generation: processGeneration,
            programBytes: options.programBytes, terminationProvesQuiescence: options.joinOnExit,
            isCurrent: thread => threads.get(thread.tid) === thread,
            retain: thread => threads.set(thread.tid, thread),
            onMessage: (message, thread) => {
              if (message.type === 'thread_exit') {
                if (message.pid !== thread.pid || message.tid !== thread.tid) return reject(Error('Wrong pthread exit'));
                threadExits.add(thread.tid);
              } else if (message.type === 'error') return reject(Error(message.message));
              maybeComplete();
            },
            onError: reject,
            onExit: (code, _thread) => { if (code !== 0) reject(Error(`pthread Worker exit ${code}`)); else maybeComplete(); },
          });
        },
        onGroupedFork: async request => {
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
                else if (message.type === 'error') return reject(Error(message.message));
                maybeComplete();
              },
              onError: error => reject(error),
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
          onStdout: bytes => { stdout += new TextDecoder().decode(bytes); },
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
            status(kernel.configureMemoryGroups(2048, 1), "configure groups");
            group = status(kernel.createMemoryGroup(2048, 4, 8), "create group");
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
        kernel.setStdinData(pid, new Uint8Array());
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
      retirement,
      threads: [...threads].map(([tid, thread]) => ({ pid: thread.pid, tid, exited: threadExits.has(tid), quiescent: thread.quiescent, joined: thread.hasJoined })),
      children: [...children].map(([pid, child]) => ({ pid, ...childStates.get(pid), quiescent: child.quiescent, joined: child.hasJoined })) };
  } catch (error) {
    trace.push(...(kernelForDiagnostics?.drainSyscallTrace() ?? []).map(event => event.decoded ?? `syscall ${event.nr}`));
    result = { grouped, stdout, stderr, kernelExit, processExit, quiescent, processReady, diagnostics, trace, memory: memoryEvidence(),
      threads: [...threads].map(([tid, thread]) => ({ pid: thread.pid, tid, exited: threadExits.has(tid), quiescent: thread.quiescent, joined: thread.hasJoined })),
      children: [...children].map(([pid, child]) => ({ pid, ...childStates.get(pid), quiescent: child.quiescent, joined: child.hasJoined })),
      failure: error instanceof Error ? error.stack : String(error) };
  } finally {
    if (deadline) clearTimeout(deadline);
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
