import { describe, expect, it, vi } from "vitest";
import { ProcessMemoryAllocator } from "../src/process-memory";
import { registerProcessBacking, registerProcessForkSnapshot } from "../src/process-memory-backing";

const PAGE = 65536;
const request = { ptrWidth: 4 as const, initialPages: 1, maximumPages: 4 };
const allocator = () => new ProcessMemoryAllocator({ maxMemories: 4, maxTotalBytes: 16 * PAGE, retirementBackpressureMs: 0 });

describe("process backing ownership", () => {
  it.each([false, true])("waits for the final alias and preserves forced taint (%s)", forced => {
    const a = allocator(), lease = a.acquire(request), memory = lease.memory;
    const alias = lease.retainAlias(), commit = vi.fn(), prepare = vi.fn(() => commit);
    registerProcessBacking(memory, { prepareRetirement: prepare });
    if (forced) lease.releaseAfterForcedTermination(); else lease.release();
    expect(prepare).not.toHaveBeenCalled();
    alias.release();
    expect(prepare).toHaveBeenCalledExactlyOnceWith(forced ? "forced" : "quiescent");
    expect(commit).toHaveBeenCalledOnce();
    expect(() => alias.release()).toThrow("already consumed");
    expect(commit).toHaveBeenCalledOnce();
  });

  it("keeps an exact lease retryable after backing preflight fails", () => {
    const a = allocator(), lease = a.acquire(request), memory = lease.memory;
    const commit = vi.fn(), prepare = vi.fn().mockImplementationOnce(() => { throw Error("unsettled snapshot"); }).mockReturnValue(commit);
    registerProcessBacking(memory, { prepareRetirement: prepare });
    expect(() => lease.release()).toThrow("unsettled snapshot");
    expect(lease.memory).toBe(memory);
    expect(a.getRetirementStats().liveMemories).toBe(1);
    lease.release();
    expect(commit).toHaveBeenCalledOnce();
    expect(a.getRetirementStats().liveMemories).toBe(0);
  });

  it("returns a source-owned unpublished backing after async admission refuses its size", async () => {
    const rejected = vi.fn();
    const a = new ProcessMemoryAllocator({maxMemories: 2, maxTotalBytes: 16 * PAGE,
      createMemoryAsync: async () => {
        const memory = new WebAssembly.Memory({initial: 2, maximum: 4, shared: true});
        registerProcessBacking(memory, {prepareRetirement: () => () => {}, prepareRejectedAllocation: () => rejected});
        return memory;
      }});
    await expect(a.acquireWhenAvailable(request)).rejects.toThrow("requested fresh process memory");
    expect(rejected).toHaveBeenCalledOnce();
    expect(a.getRetirementStats()).toMatchObject({liveMemories:0,chargedMemories:0,chargedBytes:0});
  });

  it("never rejects a live admitted backing returned again by a broken async factory", async () => {
    const memory = new WebAssembly.Memory({initial: 1, maximum: 4, shared: true}), rejected = vi.fn(), retired = vi.fn();
    registerProcessBacking(memory, {prepareRetirement: () => retired, prepareRejectedAllocation: () => rejected});
    const a = new ProcessMemoryAllocator({maxMemories: 2,maxTotalBytes: 16 * PAGE,createMemoryAsync: async () => memory});
    const lease = await a.acquireWhenAvailable(request);
    await expect(a.acquireWhenAvailable(request)).rejects.toThrow("requested fresh process memory");
    expect(rejected).not.toHaveBeenCalled();expect(retired).not.toHaveBeenCalled();
    expect(lease.memory).toBe(memory);lease.release();expect(retired).toHaveBeenCalledOnce();
  });

  it.each(["success", "factory", "copy"])("disposes exact asynchronous fork pins on %s", async failure => {
    const parent = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    const dispose = vi.fn();
    const a = new ProcessMemoryAllocator({ maxMemories: 4, maxTotalBytes: 16 * PAGE, retirementBackpressureMs: 0,
      createMemoryAsync: async () => {
        if (failure === "factory") throw Error("factory refused");
        return new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
      } });
    let calls = 0;
    a.copyForkAddressSpace = (destination) => {
      if (++calls === 1) registerProcessForkSnapshot(destination, dispose);
      else if (failure === "copy") throw Error("copy refused");
    };
    const result = a.acquireForkClone(parent, 4, 4);
    if (failure === "success") (await result).release();
    else await expect(result).rejects.toThrow(failure === "copy" ? "copy refused" : "factory refused");
    expect(dispose).toHaveBeenCalledOnce();
    const stats = a.getRetirementStats();
    expect(stats.chargedMemories).toBe(stats.retirementBacklogMemories);
    expect(stats.chargedBytes).toBe(stats.retirementBacklogBytes);
    expect(stats.liveMemories).toBe(0);
  });
});
