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
  it("returns the received Memory and terminates its construction realm", async () => {
    const revoke = setup();
    const factory = new BrowserProcessMemoryFactory();
    const allocated = factory.allocate(request);
    const worker = AllocationWorker.instances[0];
    expect(worker.posted).toEqual(request);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    worker.onmessage!({ data: { memory } } as MessageEvent);
    expect(await allocated).toBe(memory);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    factory.dispose();
    factory.dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:allocation-worker");
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

  it("retries native constructor exhaustion in its owner after terminating the worker", async () => {
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
    expect(memory.grow(3)).toBe(1);
    expect(() => memory.grow(1)).toThrow(RangeError);
    expect(AllocationWorker.instances).toHaveLength(1);
    factory.dispose();
  });

  it("propagates failure of the single owner attempt", async () => {
    setup();
    const factory = new BrowserProcessMemoryFactory();
    const exhausted = new RangeError("owner memory exhausted");
    const construct = vi.spyOn(WebAssembly, "Memory").mockImplementation(function () {
      throw exhausted;
    });
    const allocated = factory.allocate(request);
    const rejected = expect(allocated).rejects.toBe(exhausted);
    AllocationWorker.instances[0].onmessage!({ data: {
      error: "RangeError: Out of memory", constructorErrorName: "RangeError",
    } } as MessageEvent);
    await rejected;
    expect(construct).toHaveBeenCalledOnce();
    expect(AllocationWorker.instances[0].terminate).toHaveBeenCalledOnce();
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
