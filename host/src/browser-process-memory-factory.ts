import type { ProcessMemoryAllocationRequest } from "./process-memory";

// Both realms use the same admitted descriptor. Keep this function independent
// of modules and retained generations so its source can enter the worker blob.
function createProcessMemory(request: ProcessMemoryAllocationRequest): WebAssembly.Memory {
  return new WebAssembly.Memory(request.ptrWidth === 8
    ? {
        initial: BigInt(request.initialPages),
        maximum: BigInt(request.maximumPages),
        shared: true,
        address: "i64",
      } as unknown as WebAssembly.MemoryDescriptor
    : {
        initial: request.initialPages,
        maximum: request.maximumPages,
        shared: true,
      });
}

// This function runs in a fresh realm with the constructor supplied as source.
function allocateMemoryWorkerMain(construct: typeof createProcessMemory): void {
  self.onmessage = (event: MessageEvent<ProcessMemoryAllocationRequest>) => {
    let memory: WebAssembly.Memory;
    try {
      memory = construct(event.data);
    } catch (error) {
      self.postMessage({
        error: String(error),
        constructorErrorName: error instanceof Error ? error.name : undefined,
      });
      return;
    }
    // Clone/transport failures must not be mistaken for constructor exhaustion.
    self.postMessage({ memory });
  };
}

/**
 * WebKit's synchronous Wasm-memory collection can stall the long-lived
 * kernel realm. Construct each fresh address space in a disposable realm;
 * transfer its shared Memory wrapper back before terminating that worker.
 * The session allocator still owns admission, copying and lease retirement.
 */
export class BrowserProcessMemoryFactory {
  private scriptUrl: string | undefined;
  private disposed = false;
  private readonly pending = new Set<(error: Error) => void>();

  constructor(private readonly timeoutMs = 30_000) {}

  allocate(
    request: Readonly<ProcessMemoryAllocationRequest>,
  ): Promise<WebAssembly.Memory> {
    if (this.disposed) {
      return Promise.reject(new Error("Process memory factory is closed"));
    }
    return new Promise((resolve, reject) => {
      let worker: Worker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = (
        error?: Error,
        memory?: WebAssembly.Memory,
        retryInOwnerRealm = false,
      ) => {
        if (finished) return;
        finished = true;
        this.pending.delete(cancel);
        if (timer !== undefined) clearTimeout(timer);
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          try {
            worker.terminate();
          } catch (terminationError) {
            error ??= terminationError instanceof Error
              ? terminationError : new Error(String(terminationError));
            retryInOwnerRealm = false;
          }
        }
        if (retryInOwnerRealm) {
          // JavaScriptCore retries native allocation by collecting the caller's
          // VM. A disposable VM cannot collect retired wrappers in the owning
          // kernel VM. Make one final attempt there, after the worker is gone;
          // admission, ceilings, freshness and rollback remain the allocator's.
          try {
            memory = createProcessMemory(request);
            error = undefined;
          } catch (ownerError) {
            error = ownerError instanceof Error
              ? ownerError : new Error(String(ownerError));
          }
        }
        if (error) reject(error);
        else resolve(memory!);
      };
      const cancel = (error: Error) => finish(error);
      this.pending.add(cancel);
      try {
        this.scriptUrl ??= URL.createObjectURL(new Blob([
          `(${allocateMemoryWorkerMain.toString()})(${createProcessMemory.toString()});`,
        ], { type: "application/javascript" }));
        worker = new Worker(this.scriptUrl);
        worker.onmessage = (event: MessageEvent) => {
          if (event.data?.memory instanceof WebAssembly.Memory) {
            finish(undefined, event.data.memory);
          } else {
            finish(new Error(typeof event.data?.error === "string"
              ? event.data.error : "Invalid process memory reply"), undefined,
              typeof event.data?.error === "string"
                && event.data.constructorErrorName === "RangeError");
          }
        };
        worker.onerror = (event) => finish(new Error(event.message));
        worker.onmessageerror = () => finish(new Error("Cannot receive process memory"));
        timer = setTimeout(() => {
          finish(new Error("Process memory construction timed out"));
        }, this.timeoutMs);
        worker.postMessage({ ...request });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of this.pending) {
      cancel(new Error("Process memory factory was destroyed"));
    }
    if (this.scriptUrl !== undefined) URL.revokeObjectURL(this.scriptUrl);
    this.scriptUrl = undefined;
  }
}
