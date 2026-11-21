import { BrowserWorkerAdapter } from "../../src/worker-adapter-browser";
import { VirtualPlatformIO } from "../../src/vfs/vfs";
import { BrowserTimeProvider } from "../../src/vfs/time";
import { runSdkCycles, runSdkExecution } from "./grouped-sdk-execution";
import { installBrowserSetImmediatePolyfill } from "../../src/browser-immediate-polyfill";

installBrowserSetImmediatePolyfill();

// Fetch executable bytes inside this disposable kernel realm. The page only
// supplies a mode, and receives owned output/scalars after exact quiescence.
self.onmessage = async (event: MessageEvent<{ grouped: boolean; anonymousShared?: boolean; cycles?: number; physicalPages?: number; maximumVirtualPages?: number; rejectThreadLaunchCount?: number; rejectForkLaunchCount?: number; rejectForkStage?: 'registration' | 'replay'; uncertainThreadConstructor?: boolean; forcedLifecycle?: boolean; nativeWaitLifecycle?: boolean; execSignal?: 'commit' | 'stopped'; execSuccess?: boolean; execOldThreads?: boolean; execPrecommitFailure?: 'allocation' | 'callback' | 'virtual'; probe?: "dri-mapping-fork" | "dri-direct" | "fork-replay-rollback" | "fork-registration-rollback" | "shared-file" | "anonymous-shared" | "mapping" | "private-file" | "fork" | "pthread" | "pthread-churn" | "pthread-rollback" | "pthread-launch-rollback" | "pthread-constructor-failure" | "forced-exit" | "native-wait-exit" | "exec-allocation-rollback" | "exec-callback-rollback" | "exec-virtual-rollback" | "exec-handoff" | "exec-handoff-threads" | "exec-signal-commit" | "exec-signal-stopped" }>) => {
  self.onmessage = null;
  try {
    const grouped = event.data.grouped;
    const probe = event.data.probe ?? "mapping";
    if (probe !== "dri-mapping-fork" && probe !== "dri-direct" && probe !== "fork-replay-rollback" && probe !== "fork-registration-rollback" && probe !== "shared-file" && probe !== "anonymous-shared" && probe !== "mapping" && probe !== "private-file" && probe !== "fork" && probe !== "pthread" && probe !== "pthread-churn" && probe !== "pthread-rollback" && probe !== "pthread-launch-rollback" && probe !== "pthread-constructor-failure" && probe !== "forced-exit" && probe !== "native-wait-exit" && probe !== "exec-allocation-rollback" && probe !== "exec-callback-rollback" && probe !== "exec-virtual-rollback" && probe !== "exec-handoff" && probe !== "exec-handoff-threads" && probe !== "exec-signal-commit" && probe !== "exec-signal-stopped") throw new Error("unknown SDK probe");
    const read = async (path: string) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`fixture fetch ${path}: ${response.status}`);
      return response.arrayBuffer();
    };
    const [kernelBytes, imageModuleBytes, ordinaryBytes, programBytes] = await Promise.all([
      read("/kernel.wasm"), read("/image-module.wasm"), read(`/${probe}/ordinary.wasm`),
      read(`/${probe}/${grouped ? "grouped" : "ordinary"}.wasm`),
    ]);
    const execTargetBytes = probe === "exec-virtual-rollback" ? await read(`/${probe}/target.grouped.wasm`) : undefined;
    const options = { execTargetBytes, maximumVirtualPages: event.data.maximumVirtualPages, kernelBytes, imageModuleBytes, ordinaryBytes, programBytes, grouped, physicalPages: event.data.physicalPages, rejectThreadLaunchCount: event.data.rejectThreadLaunchCount, rejectForkLaunchCount: event.data.rejectForkLaunchCount, rejectForkStage: event.data.rejectForkStage, uncertainThreadConstructor: event.data.uncertainThreadConstructor, forcedLifecycle: event.data.forcedLifecycle, nativeWaitLifecycle: event.data.nativeWaitLifecycle, execPrecommitFailure: event.data.execPrecommitFailure, execSuccess: event.data.execSuccess, execOldThreads: event.data.execOldThreads, execSignal: event.data.execSignal, anonymousShared: event.data.anonymousShared,
      io: new VirtualPlatformIO([], new BrowserTimeProvider()),
      adapter: new BrowserWorkerAdapter(new URL("/process.mjs", self.location.href)), joinOnExit: false,
    };
    self.postMessage(await (event.data.cycles ? runSdkCycles(options, event.data.cycles) : runSdkExecution(options)));
  } catch (error) {
    self.postMessage({ failure: error instanceof Error ? error.stack : String(error) });
  } finally { self.close(); }
};
