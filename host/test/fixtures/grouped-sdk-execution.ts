import { CAPTURED_STDIO, CentralizedKernelWorker } from "../../src/kernel-worker";
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
export async function runSdkExecution(options: SdkExecutionOptions): Promise<Record<string, unknown>> {
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
  const children = new Map<number, GroupedForkWorkerOwnership>();
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
        resolve();
      };
      // The Node exit event joins the exact process Worker. The deadline is a
      // failure/containment boundary, never permission to reuse grouped pages.
      deadline = setTimeout(() => reject(new Error("guest execution deadline")), 60_000);
      const kernel = new CentralizedKernelWorker({ maxWorkers: 4, dataBufferSize: 65536,
        useSharedMemory: true, kernelMaxPages: 1024 }, options.io, {
        onExit: (pid, code) => {
          if (pid === rootPid) kernelExit = code;
          else childStates.set(pid, { ...childStates.get(pid), kernelExit: code });
          trace.push(...kernel.drainSyscallTrace().map(event => event.decoded ?? `syscall ${event.nr}`));
          maybeComplete();
        },
        onKernelFatal: error => reject(error),
        onGroupedFork: async request => {
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
      });
      void (async () => {
        // Compose through the normal image writer, inside this disposable
        // realm. A real root namespace is needed to reach kernel tmpfs on both
        // hosts; an empty browser host adapter cannot stand in for `/`.
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
        let rootHandle: PreparedGroupReplica | undefined;
        if (grouped) {
          status(kernel.configureMemoryGroups(2048, 1), "configure groups");
          const group = status(kernel.createMemoryGroup(2048, 4, 8), "create group");
          status(kernel.createMemoryGroupBacking(group), "create backing");
          const receipt = kernel.prepareMemoryGroupProcess(group, pid);
          if (typeof receipt === "number") throw new Error(`prepare process: ${receipt}`);
          const handle = kernel.prepareMemoryGroupImage(receipt, { initialVirtualPages: layout.initialPages,
            maximumVirtualPages: layout.maximumPages, scratchBytes: 65536 });
          if (typeof handle === "number") throw new Error(`prepare image: ${handle}`);
          rootHandle = handle;
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
    result = { grouped, stdout, stderr, kernelExit, processExit, quiescent, processReady, diagnostics, trace,
      children: [...children].map(([pid, child]) => ({ pid, ...childStates.get(pid), quiescent: child.quiescent, joined: child.hasJoined })) };
  } catch (error) {
    result = { grouped, stdout, stderr, kernelExit, processExit, quiescent, processReady, diagnostics, trace,
      children: [...children].map(([pid, child]) => ({ pid, ...childStates.get(pid), quiescent: child.quiescent, joined: child.hasJoined })),
      failure: error instanceof Error ? error.stack : String(error) };
  } finally {
    if (deadline) clearTimeout(deadline);
    await processWorker?.terminate();
    for (const child of children.values()) { await child.contain(); child.releaseAfterStop(); }
    importWorker?.close();
    if (generation) owner.releaseGeneration(generation);
  }
  return result;
}
