import { describe, expect, it } from "vitest";
import {
  ProcessMemoryAllocator,
  ProcessMemoryCapacityError,
  type ProcessMemoryAllocationRequest,
} from "../src/process-memory";
import { WASM_PAGE_SIZE } from "../src/constants";

const request: ProcessMemoryAllocationRequest = {
  ptrWidth: 4, initialPages: 1, maximumPages: 4,
};

function memory(pages = 1): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: pages, maximum: 4, shared: true });
}

function deferredMemory() {
  let resolve!: (value: WebAssembly.Memory) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<WebAssembly.Memory>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("asynchronous process memory admission", () => {
  it("charges pending allocations before a concurrent creator can enter", async () => {
    const pending = deferredMemory();
    let calls = 0;
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 1, maxTotalBytes: WASM_PAGE_SIZE,
      createMemoryAsync: () => { calls++; return pending.promise; },
    });
    const first = allocator.acquireWhenAvailable(request);
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 0, chargedMemories: 1, chargedBytes: WASM_PAGE_SIZE,
    });
    expect(() => allocator.clear()).toThrow(/pending allocations/);
    await expect(allocator.acquireWhenAvailable(request))
      .rejects.toBeInstanceOf(ProcessMemoryCapacityError);
    expect(calls).toBe(1);
    pending.resolve(memory());
    const lease = await first;
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 1, chargedMemories: 1, chargedBytes: WASM_PAGE_SIZE,
    });
    lease.release();
    allocator.clear();
  });

  it("returns admission when construction is cancelled or fails", async () => {
    const pending = deferredMemory();
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 1, maxTotalBytes: WASM_PAGE_SIZE,
      createMemoryAsync: () => pending.promise,
    });
    const allocation = allocator.acquireWhenAvailable(request);
    const rejected = expect(allocation).rejects.toThrow("cancelled");
    pending.reject(new Error("cancelled"));
    await rejected;
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 0, chargedMemories: 0, chargedBytes: 0,
    });
    allocator.clear();
  });

  it("captures fork bytes before a sibling can mutate and retire the parent", async () => {
    const pending = deferredMemory();
    let calls = 0;
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 2, maxTotalBytes: 3 * WASM_PAGE_SIZE,
      createMemoryAsync: () => ++calls === 1
        ? Promise.resolve(memory()) : pending.promise,
    });
    const parent = await allocator.acquireWhenAvailable(request);
    new Uint8Array(parent.memory.buffer).fill(7);
    const cloned = allocator.acquireForkClone(parent.memory, 4, 4);
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 1, chargedMemories: 2, chargedBytes: 3 * WASM_PAGE_SIZE,
    });
    new Uint8Array(parent.memory.buffer).fill(99);
    parent.release();
    pending.resolve(memory());
    const child = await cloned;
    expect(new Uint8Array(child.memory.buffer).every(byte => byte === 7)).toBe(true);
    expect(allocator.getRetirementStats().liveBytes).toBe(WASM_PAGE_SIZE);
    child.release();
    allocator.clear();
  });

  it("rejects fork admission when the temporary snapshot would exceed the budget", async () => {
    let calls = 0;
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 2, maxTotalBytes: 2 * WASM_PAGE_SIZE,
      createMemoryAsync: () => { calls++; return Promise.resolve(memory()); },
    });
    const parent = await allocator.acquireWhenAvailable(request);
    expect(() => allocator.acquireForkClone(parent.memory, 4, 4))
      .toThrow(ProcessMemoryCapacityError);
    expect(calls).toBe(1);
    expect(allocator.getRetirementStats().chargedBytes).toBe(WASM_PAGE_SIZE);
    parent.release();
    allocator.clear();
  });

  it("rechecks guest growth before publishing a pending address space", async () => {
    const pending = deferredMemory();
    let calls = 0;
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 2, maxTotalBytes: 2 * WASM_PAGE_SIZE,
      createMemoryAsync: () => ++calls === 1
        ? Promise.resolve(memory()) : pending.promise,
    });
    const parent = await allocator.acquireWhenAvailable(request);
    const allocation = allocator.acquireWhenAvailable(request);
    parent.memory.grow(1);
    const rejected = expect(allocation).rejects.toBeInstanceOf(ProcessMemoryCapacityError);
    pending.resolve(memory());
    await rejected;
    expect(allocator.getRetirementStats()).toMatchObject({
      liveMemories: 1, chargedMemories: 1, chargedBytes: 2 * WASM_PAGE_SIZE,
    });
    parent.release();
    allocator.clear();
  });

  it("rejects a reused address space and an incorrect initial size", async () => {
    const reused = memory();
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 2, maxTotalBytes: 4 * WASM_PAGE_SIZE,
      createMemoryAsync: () => Promise.resolve(reused),
    });
    const first = await allocator.acquireWhenAvailable(request);
    await expect(allocator.acquireWhenAvailable(request)).rejects.toThrow(/fresh process memory/);
    first.release();
    allocator.clear();
    await expect(allocator.acquireWhenAvailable(request)).rejects.toThrow(/fresh process memory/);
    expect(allocator.getRetirementStats().chargedBytes).toBe(0);

    const wrongSize = new ProcessMemoryAllocator({
      maxMemories: 1, maxTotalBytes: 4 * WASM_PAGE_SIZE,
      createMemoryAsync: () => Promise.resolve(memory(2)),
    });
    await expect(wrongSize.acquireWhenAvailable(request)).rejects.toThrow(/fresh process memory/);
    expect(wrongSize.getRetirementStats().chargedBytes).toBe(0);
    wrongSize.clear();
  });

  it("keeps the admitted descriptor stable across the construction await", async () => {
    const pending = deferredMemory();
    let admitted: Readonly<ProcessMemoryAllocationRequest> | undefined;
    const allocator = new ProcessMemoryAllocator({
      maxMemories: 1, maxTotalBytes: WASM_PAGE_SIZE,
      createMemoryAsync: value => { admitted = value; return pending.promise; },
    });
    const mutable = { ...request };
    const allocation = allocator.acquireWhenAvailable(mutable);
    mutable.initialPages = 2;
    expect(admitted?.initialPages).toBe(1);
    pending.resolve(memory());
    const lease = await allocation;
    lease.release();
    allocator.clear();
  });
});
