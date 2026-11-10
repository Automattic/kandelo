import { ProcessMemoryCreatorGate, isProcessMemoryCreatorAdmissionClosed } from "../src/process-memory-creator-gate";
import { ProcessMemoryAllocator } from "../src/process-memory";
import { lookupComparisonMemoryShape } from "../src/process-snapshot-comparator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProcessMemoryFactory } from "../src/browser-process-memory-factory";

class AllocationWorker {
  static instances: AllocationWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown;
  terminate = vi.fn();
  constructor() { AllocationWorker.instances.push(this); }
  postMessage(message: unknown) { this.posted = message; }
}

function setup() {
  AllocationWorker.instances = [];
  vi.stubGlobal("Worker", AllocationWorker);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:allocation-worker");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return revoke;
}

const request = { ptrWidth: 4 as const, initialPages: 1, maximumPages: 4 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser process memory allocation realm", () => {
  it("keeps termination failure visible during an admitted cancellation", async () => {
    setup();
    const gate = new ProcessMemoryCreatorGate();
    const factory = new BrowserProcessMemoryFactory();
    const allocated = gate.run("fork construction", () => factory.allocate(request));
    const outcome = allocated.catch(error => error);
    const worker = AllocationWorker.instances[0];
    worker.terminate.mockImplementationOnce(() => { throw new Error("termination failed"); });
    const drained = gate.closeAndWait();
    const cancellation = gate.closedAdmissionCancellation("pending memory construction");
    factory.dispose(cancellation);
    const failure = await outcome;
    await drained;
    expect(isProcessMemoryCreatorAdmissionClosed(failure)).toBe(false);
    expect(failure.message).toContain("termination failed");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("mints cancellation only after admission closes", async () => {
    const gate = new ProcessMemoryCreatorGate();
    expect(() => gate.closedAdmissionCancellation("memory construction")).toThrow("still open");
    await gate.closeAndWait();
    const cancellation = gate.closedAdmissionCancellation("memory construction");
    expect(isProcessMemoryCreatorAdmissionClosed(cancellation)).toBe(true);
    expect(isProcessMemoryCreatorAdmissionClosed(new Error(cancellation.message))).toBe(false);
  });

  it("preserves terminal admission cancellation while draining pending fork and exec allocation", async () => {
    const revoke = setup();
    const gate = new ProcessMemoryCreatorGate();
    const factory = new BrowserProcessMemoryFactory();
    const allocator = new ProcessMemoryAllocator({ maxMemories: 4, maxTotalBytes: 8 * 65536,
      createMemoryAsync: request => factory.allocate(request) });
    const parent = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    const fork = gate.run("fork construction", () => allocator.acquireForkClone(parent, 4, 4));
    const exec = gate.run("exec construction", () => allocator.acquireWhenAvailable(request));
    const forkOutcome = fork.catch(error => error);
    const execOutcome = exec.catch(error => error);
    expect(AllocationWorker.instances).toHaveLength(2);
    const lateReply = AllocationWorker.instances[0].onmessage!;
    const sweep = vi.fn(() => {
      expect(allocator.getRetirementStats()).toMatchObject({ liveMemories: 0, chargedMemories: 0, chargedBytes: 0 });
      allocator.clear();
    });
    const destroyed = gate.closeAndRunAfterDrain(sweep);
    expect(sweep).not.toHaveBeenCalled();
    const cancellation = gate.closedAdmissionCancellation("pending memory construction");
    expect(isProcessMemoryCreatorAdmissionClosed(cancellation)).toBe(true);
    factory.dispose(cancellation);
    const results = await Promise.all([forkOutcome, execOutcome]);
    await destroyed;
    expect(sweep).toHaveBeenCalledOnce();
    for (const worker of AllocationWorker.instances) {
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.onmessage).toBeNull();
    }
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:allocation-worker");
    const lateMemory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    lateReply({ data: { memory: lateMemory } } as MessageEvent);
    expect(lookupComparisonMemoryShape(lateMemory)).toBeUndefined();
    expect(allocator.getRetirementStats()).toMatchObject({ liveMemories: 0, chargedBytes: 0 });
    for (const result of results) {
      expect(result).toBe(cancellation);
      expect(isProcessMemoryCreatorAdmissionClosed(result)).toBe(true);
    }
  });

  it("keeps an earlier construction failure distinct from terminal cancellation", async () => {
    setup();
    const gate = new ProcessMemoryCreatorGate();
    const factory = new BrowserProcessMemoryFactory();
    const pending = gate.run("fork construction", () => factory.allocate(request));
    const outcome = pending.catch(error => error);
    AllocationWorker.instances[0].onerror!({ message: "Process memory factory was destroyed" } as ErrorEvent);
    const destroyed = gate.closeAndRunAfterDrain(() => {});
    const cancellation = gate.closedAdmissionCancellation("pending memory construction");
    factory.dispose(cancellation);
    const failure = await outcome;
    await destroyed;
    expect(failure.message).toBe("Process memory factory was destroyed");
    expect(failure).not.toBe(cancellation);
    expect(isProcessMemoryCreatorAdmissionClosed(failure)).toBe(false);
  });

  it("returns the received Memory and terminates its construction realm", async () => {
    const revoke = setup();
    const factory = new BrowserProcessMemoryFactory();
    const allocated = factory.allocate(request);
    const worker = AllocationWorker.instances[0];
    expect(worker.posted).toEqual(request);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    worker.onmessage!({ data: { memory } } as MessageEvent);
    expect(await allocated).toBe(memory);
    expect(lookupComparisonMemoryShape(memory)).toEqual({ addressWidth: 4, shared: true, maximumPages: 4 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    factory.dispose();
    factory.dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:allocation-worker");
  });

  it("records the admitted descriptor even if the caller changes its request while waiting", async () => {
    setup();
    const factory = new BrowserProcessMemoryFactory();
    const mutable = { ...request };
    const allocated = factory.allocate(mutable);
    mutable.maximumPages = 8;
    const worker = AllocationWorker.instances[0];
    expect(worker.posted).toEqual(request);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    worker.onmessage!({ data: { memory } } as MessageEvent);
    expect(await allocated).toBe(memory);
    expect(lookupComparisonMemoryShape(memory)?.maximumPages).toBe(4);
    factory.dispose();
  });

  it("cancels every pending realm when its machine is destroyed", async () => {
    setup();
    const factory = new BrowserProcessMemoryFactory();
    const first = expect(factory.allocate(request)).rejects.toThrow(/destroyed/);
    const second = expect(factory.allocate(request)).rejects.toThrow(/destroyed/);
    factory.dispose();
    await Promise.all([first, second]);
    expect(AllocationWorker.instances).toHaveLength(2);
    for (const worker of AllocationWorker.instances) {
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
    await expect(factory.allocate(request)).rejects.toThrow(/closed/);
    expect(AllocationWorker.instances).toHaveLength(2);
  });

  it("reports constructor errors without leaving an allocation worker alive", async () => {
    setup();
    const factory = new BrowserProcessMemoryFactory();
    const rejected = expect(factory.allocate(request)).rejects.toThrow("out of memory");
    const worker = AllocationWorker.instances[0];
    worker.onmessage!({ data: { error: "out of memory" } } as MessageEvent);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    factory.dispose();
  });

  it("bounds a native constructor stall and releases the worker", async () => {
    setup();
    vi.useFakeTimers();
    const factory = new BrowserProcessMemoryFactory(50);
    const rejected = expect(factory.allocate(request)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(AllocationWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    factory.dispose();
  });

  it("retries constructor exhaustion once in the owner after terminating the worker", async () => {
    setup();
    const factory = new BrowserProcessMemoryFactory();
    const allocated = factory.allocate(request);
    const worker = AllocationWorker.instances[0];
    const NativeMemory = WebAssembly.Memory;
    const construct = vi.spyOn(WebAssembly, "Memory").mockImplementation(function (descriptor) {
      expect(worker.terminate).toHaveBeenCalledOnce();
      return new NativeMemory(descriptor);
    });
    worker.onmessage!({ data: {
      error: "RangeError: Out of memory", constructorErrorName: "RangeError",
    } } as MessageEvent);
    const memory = await allocated;
    expect(construct).toHaveBeenCalledExactlyOnceWith({
      initial: 1, maximum: 4, shared: true,
    });
    expect(memory.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(AllocationWorker.instances).toHaveLength(1);
    factory.dispose();
  });

  it("can allocate again after native construction fails", async () => {
    setup();
    const factory = new BrowserProcessMemoryFactory();
    const construct = vi.spyOn(WebAssembly, "Memory").mockImplementationOnce(function () {
      throw new RangeError("Out of memory");
    });
    const allocated = factory.allocate(request);
    const rejected = expect(allocated).rejects.toThrow("Out of memory");
    AllocationWorker.instances[0].onmessage!({ data: {
      error: "RangeError: Out of memory", constructorErrorName: "RangeError",
    } } as MessageEvent);
    await rejected;
    expect(AllocationWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(construct).toHaveBeenCalledOnce();
    construct.mockRestore();
    const next = factory.allocate(request);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    AllocationWorker.instances[1].onmessage!({ data: { memory } } as MessageEvent);
    expect(await next).toBe(memory);
    expect(AllocationWorker.instances[1].terminate).toHaveBeenCalledOnce();
    factory.dispose();
  });

  it("does not retry allocation when terminating the construction realm fails", async () => {
    setup();
    const factory = new BrowserProcessMemoryFactory();
    const allocated = factory.allocate(request);
    const rejected = expect(allocated).rejects.toThrow("Out of memory");
    const worker = AllocationWorker.instances[0];
    worker.terminate.mockImplementationOnce(() => { throw new Error("termination failed"); });
    const construct = vi.spyOn(WebAssembly, "Memory");
    worker.onmessage!({ data: {
      error: "RangeError: Out of memory", constructorErrorName: "RangeError",
    } } as MessageEvent);
    await rejected;
    expect(construct).not.toHaveBeenCalled();
    factory.dispose();
  });

  it("does not recover from malformed or transport error replies", async () => {
    setup();
    const factory = new BrowserProcessMemoryFactory();
    const construct = vi.spyOn(WebAssembly, "Memory");
    for (const data of [
      { constructorErrorName: "RangeError" },
      { error: "cannot clone memory", constructorErrorName: "DataCloneError" },
    ]) {
      const rejected = expect(factory.allocate(request)).rejects.toThrow();
      AllocationWorker.instances.at(-1)!.onmessage!({ data } as MessageEvent);
      await rejected;
    }
    expect(construct).not.toHaveBeenCalled();
    factory.dispose();
  });

  it("does not allocate after shutdown even if an old error callback arrives", async () => {
    setup();
    const factory = new BrowserProcessMemoryFactory();
    const construct = vi.spyOn(WebAssembly, "Memory");
    const rejected = expect(factory.allocate(request)).rejects.toThrow(/destroyed/);
    const onmessage = AllocationWorker.instances[0].onmessage!;
    factory.dispose();
    onmessage({ data: {
      error: "RangeError: Out of memory", constructorErrorName: "RangeError",
    } } as MessageEvent);
    await rejected;
    expect(construct).not.toHaveBeenCalled();
  });

  it("cleans up after an initial postMessage failure", async () => {
    setup();
    vi.spyOn(AllocationWorker.prototype, "postMessage").mockImplementation(() => {
      throw new Error("cannot clone request");
    });
    const factory = new BrowserProcessMemoryFactory();
    await expect(factory.allocate(request)).rejects.toThrow(/cannot clone request/);
    expect(AllocationWorker.instances[0].terminate).toHaveBeenCalledOnce();
    factory.dispose();
  });
});
