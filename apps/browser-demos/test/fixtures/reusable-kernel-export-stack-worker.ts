import { createWasmPosixKernelTestHarness } from "../../../../host/src/kernel";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { BrowserTimeProvider } from "../../../../host/src/vfs/time";
import { VirtualPlatformIO } from "../../../../host/src/vfs/vfs";

interface ReusableKernelExports extends WebAssembly.Exports {
  kernel_commit_process_exit(status: number): number;
  kernel_create_process(): number;
  kernel_get_stack_pointer(): number;
  kernel_reap_process(pid: number): number;
  kernel_set_current_tid(pid: number, tid: number): number;
}

interface StackProbeRequest {
  kernelWasmUrl: string;
  iterations: number;
}

interface StackProbeResult {
  baselineStackPointer: number;
  finalStackPointer: number;
  iterations: number;
}

const workerScope = globalThis as unknown as {
  close(): void;
  onmessage: ((event: MessageEvent<StackProbeRequest>) => void) | null;
  postMessage(message: StackProbeResult | { error: string }): void;
};

workerScope.onmessage = (event) => {
  void runProbe(event.data).then(
    (result) => {
      workerScope.postMessage(result);
      workerScope.close();
    },
    (error) => {
      workerScope.postMessage({
        error: error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error),
      });
      workerScope.close();
    },
  );
};

async function runProbe({
  kernelWasmUrl,
  iterations,
}: StackProbeRequest): Promise<StackProbeResult> {
  const response = await fetch(kernelWasmUrl);
  if (!response.ok) {
    throw new Error(
      `kernel fetch failed: ${response.status} ${response.url}`,
    );
  }
  const kernelBytes = new Uint8Array(await response.arrayBuffer());
  if (
    kernelBytes.length < 4
    || kernelBytes[0] !== 0x00
    || kernelBytes[1] !== 0x61
    || kernelBytes[2] !== 0x73
    || kernelBytes[3] !== 0x6d
  ) {
    // WHY: Vite and reverse proxies can return an HTML fallback with status
    // 200 for a missing asset. Diagnose that provenance failure explicitly
    // instead of reporting a misleading WebAssembly compiler error.
    throw new Error(
      "kernel fetch returned non-Wasm bytes: " +
        `${response.status} ` +
        `${response.headers.get("content-type") ?? "unknown content type"} ` +
        response.url,
    );
  }

  const rootfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  const capture: { instance: WebAssembly.Instance | null } = {
    instance: null,
  };
  const kernel = createWasmPosixKernelTestHarness({
    config: {
      maxWorkers: 1,
      dataBufferSize: 65_536,
      useSharedMemory: true,
    },
    io: new VirtualPlatformIO(
      [{ mountPoint: "/", backend: rootfs }],
      new BrowserTimeProvider(),
    ),
    engine: {
      compile: (bytes) => WebAssembly.compile(bytes),
      instantiate: async (module, imports) => {
        const instance = await WebAssembly.instantiate(module, imports);
        capture.instance = instance;
        return instance;
      },
    },
  });
  await kernel.init(kernelBytes);

  // WHY: this dedicated test Worker must call the real returning export to
  // observe whether the Wasm epilogue restores its shadow stack. The
  // module-secret harness engine captures the raw instance only for this
  // regression; production still publishes only the gated kernel facade.
  const instance = capture.instance;
  if (instance === null) throw new Error("test engine did not instantiate");
  const exports = instance.exports as ReusableKernelExports;
  const baselineStackPointer = exports.kernel_get_stack_pointer();

  for (let iteration = 0; iteration < iterations; iteration++) {
    const pid = exports.kernel_create_process();
    if (pid <= 0) {
      throw new Error(`create process ${iteration} failed: ${pid}`);
    }
    const bindResult = exports.kernel_set_current_tid(pid, pid);
    if (bindResult !== 0) {
      throw new Error(`bind process ${iteration} failed: ${bindResult}`);
    }

    // A kernel instance is reusable for the lifetime of the machine. The
    // host adapter must commit process exit through Rust's returning Wasm
    // epilogue so repeated short-lived children cannot consume its shadow
    // stack. The separate guest kernel_exit boundary intentionally traps to
    // preserve _exit's non-returning contract.
    const committedStatus = exports.kernel_commit_process_exit(0);
    if (committedStatus !== 0) {
      throw new Error(
        `exit process ${iteration} returned ${committedStatus}`,
      );
    }
    const stackPointer = exports.kernel_get_stack_pointer();
    if (stackPointer !== baselineStackPointer) {
      throw new Error(
        `kernel stack changed after exit ${iteration}: ` +
          `${baselineStackPointer} -> ${stackPointer}`,
      );
    }
    const reapResult = exports.kernel_reap_process(pid);
    if (reapResult !== 0) {
      throw new Error(`reap process ${iteration} failed: ${reapResult}`);
    }
  }

  return {
    baselineStackPointer,
    finalStackPointer: exports.kernel_get_stack_pointer(),
    iterations,
  };
}
