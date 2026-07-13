import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VM_INTERRUPT_TIMER_DELAY_MS,
  VmInterruptTimerManager,
  type VmInterruptTimerScheduler,
} from "../src/vm-interrupt-timer";

interface Generation {
  memory: WebAssembly.Memory;
}

function generation(shared = true): Generation {
  return {
    memory: new WebAssembly.Memory({
      initial: 1,
      maximum: 2,
      shared,
    }),
  };
}

function flag(generation: Generation, ptr: number): number {
  return Atomics.load(new Uint8Array(generation.memory.buffer), ptr);
}

describe("VmInterruptTimerManager", () => {
  let nowMs: number;
  let current: Map<number, Generation>;
  let delays: number[];
  let scheduler: VmInterruptTimerScheduler;
  let manager: VmInterruptTimerManager<Generation>;

  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 0;
    current = new Map();
    delays = [];
    scheduler = {
      now: () => nowMs,
      set: (callback, delayMs) => {
        delays.push(delayMs);
        return setTimeout(callback, delayMs);
      },
      clear: (handle) => clearTimeout(handle),
    };
    manager = new VmInterruptTimerManager((pid) => current.get(pid), scheduler);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number): void {
    nowMs += ms;
    vi.advanceTimersByTime(ms);
  }

  it("sets both flags at the exact monotonic deadline", () => {
    const process = generation();
    current.set(41, process);

    expect(manager.arm(41, process, {
      timedOutPtr: 12,
      vmInterruptPtr: 13,
      seconds: 1,
    })).toBe(true);

    advance(999);
    expect(flag(process, 12)).toBe(0);
    expect(flag(process, 13)).toBe(0);

    advance(1);
    expect(flag(process, 12)).toBe(1);
    expect(flag(process, 13)).toBe(1);
    expect(manager.activeCount).toBe(0);
  });

  it("re-arms from the new request time and suppresses the old callback", () => {
    const process = generation();
    current.set(42, process);

    manager.arm(42, process, {
      timedOutPtr: 20,
      vmInterruptPtr: 21,
      seconds: 1,
    });
    advance(500);
    manager.arm(42, process, {
      timedOutPtr: 20,
      vmInterruptPtr: 21,
      seconds: 2,
    });

    advance(500);
    expect(flag(process, 20)).toBe(0);
    advance(1_499);
    expect(flag(process, 20)).toBe(0);
    advance(1);
    expect(flag(process, 20)).toBe(1);
  });

  it("cancels through a non-positive runtime-hook request", () => {
    const process = generation();
    current.set(43, process);
    manager.arm(43, process, {
      timedOutPtr: 24,
      vmInterruptPtr: 25,
      seconds: 1,
    });

    expect(manager.handleRequest(43, process, {
      timedOutPtr: 24,
      vmInterruptPtr: 25,
      seconds: 0,
    })).toBe(true);
    advance(1_000);

    expect(flag(process, 24)).toBe(0);
    expect(flag(process, 25)).toBe(0);
    expect(manager.activeCount).toBe(0);
  });

  it("refuses a stale process generation without disturbing its replacement", () => {
    const oldProcess = generation();
    const newProcess = generation();
    current.set(44, oldProcess);
    manager.arm(44, oldProcess, {
      timedOutPtr: 28,
      vmInterruptPtr: 29,
      seconds: 1,
    });

    current.set(44, newProcess);
    manager.arm(44, newProcess, {
      timedOutPtr: 30,
      vmInterruptPtr: 31,
      seconds: 1,
    });
    expect(manager.cancel(44, oldProcess)).toBe(false);

    advance(1_000);
    expect(flag(oldProcess, 28)).toBe(0);
    expect(flag(newProcess, 30)).toBe(1);
    expect(flag(newProcess, 31)).toBe(1);
  });

  it("drops a queued callback when the PID generation changes", () => {
    const oldProcess = generation();
    const replacement = generation();
    current.set(45, oldProcess);
    manager.arm(45, oldProcess, {
      timedOutPtr: 32,
      vmInterruptPtr: 33,
      seconds: 1,
    });

    current.set(45, replacement);
    advance(1_000);

    expect(flag(oldProcess, 32)).toBe(0);
    expect(flag(replacement, 32)).toBe(0);
    expect(manager.activeCount).toBe(0);
  });

  it("chunks delays above the JavaScript signed-32-bit timer limit", () => {
    const process = generation();
    current.set(46, process);
    const tailMs = 2_500;
    manager.arm(46, process, {
      timedOutPtr: 36,
      vmInterruptPtr: 37,
      seconds: (MAX_VM_INTERRUPT_TIMER_DELAY_MS + tailMs) / 1_000,
    });

    expect(delays).toEqual([MAX_VM_INTERRUPT_TIMER_DELAY_MS]);
    advance(MAX_VM_INTERRUPT_TIMER_DELAY_MS);
    expect(flag(process, 36)).toBe(0);
    expect(delays).toEqual([MAX_VM_INTERRUPT_TIMER_DELAY_MS, tailMs]);

    advance(tailMs - 1);
    expect(flag(process, 36)).toBe(0);
    advance(1);
    expect(flag(process, 36)).toBe(1);
  });

  it("rejects out-of-bounds and non-shared flag storage", () => {
    const process = generation();
    current.set(47, process);
    expect(manager.arm(47, process, {
      timedOutPtr: process.memory.buffer.byteLength,
      vmInterruptPtr: 1,
      seconds: 1,
    })).toBe(false);

    const unshared = generation(false);
    current.set(48, unshared);
    expect(manager.arm(48, unshared, {
      timedOutPtr: 1,
      vmInterruptPtr: 2,
      seconds: 1,
    })).toBe(false);
    expect(manager.activeCount).toBe(0);
  });

  it("clears every process timer", () => {
    const first = generation();
    const second = generation();
    current.set(49, first);
    current.set(50, second);
    manager.arm(49, first, { timedOutPtr: 40, vmInterruptPtr: 41, seconds: 1 });
    manager.arm(50, second, { timedOutPtr: 42, vmInterruptPtr: 43, seconds: 1 });

    manager.clearAll();
    advance(1_000);

    expect(flag(first, 40)).toBe(0);
    expect(flag(second, 42)).toBe(0);
    expect(manager.activeCount).toBe(0);
  });

  it("cancels a timer whose scheduler handle is numeric zero", () => {
    const process = generation();
    const callbacks: Array<() => void> = [];
    const cleared: number[] = [];
    const zeroHandleScheduler: VmInterruptTimerScheduler<number> = {
      now: () => 0,
      set: (callback) => {
        callbacks.push(callback);
        return 0;
      },
      clear: (handle) => cleared.push(handle),
    };
    current.set(51, process);
    const zeroManager = new VmInterruptTimerManager<Generation, number>(
      (pid) => current.get(pid),
      zeroHandleScheduler,
    );

    zeroManager.arm(51, process, {
      timedOutPtr: 44,
      vmInterruptPtr: 45,
      seconds: 1,
    });
    expect(zeroManager.cancel(51, process)).toBe(true);
    expect(cleared).toEqual([0]);

    callbacks[0]();
    expect(flag(process, 44)).toBe(0);
    expect(flag(process, 45)).toBe(0);
  });
});
