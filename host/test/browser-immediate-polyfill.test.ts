import { describe, expect, it, vi } from "vitest";
import {
  installBrowserSetImmediatePolyfill,
  type BrowserImmediatePolyfillTarget,
} from "../src/browser-immediate-polyfill";

type MessageTask = () => void;

class ManualPort {
  onmessage: (() => void) | null = null;
  peer: ManualPort | null = null;

  constructor(private readonly enqueue: (task: MessageTask) => void) {}

  postMessage(_value: unknown): void {
    this.enqueue(() => this.peer?.onmessage?.());
  }
}

class ManualMessageChannel {
  static instances: ManualMessageChannel[] = [];

  readonly port1: ManualPort;
  readonly port2: ManualPort;
  private readonly tasks: MessageTask[] = [];

  constructor() {
    const enqueue = (task: MessageTask) => this.tasks.push(task);
    this.port1 = new ManualPort(enqueue);
    this.port2 = new ManualPort(enqueue);
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
    ManualMessageChannel.instances.push(this);
  }

  flushNext(): void {
    const task = this.tasks.shift();
    expect(task, "expected a queued MessageChannel task").toBeDefined();
    task!();
  }

  pendingTurns(): number {
    return this.tasks.length;
  }
}

function makeTarget(): BrowserImmediatePolyfillTarget {
  ManualMessageChannel.instances = [];
  return {
    MessageChannel: ManualMessageChannel as unknown as typeof MessageChannel,
    performance: { now: () => 0 },
    setTimeout: (callback, delay) => setTimeout(callback, delay),
  };
}

function installedChannel(): ManualMessageChannel {
  expect(ManualMessageChannel.instances).toHaveLength(1);
  return ManualMessageChannel.instances[0]!;
}

describe("browser setImmediate polyfill", () => {
  it("keeps callbacks added during a flush for the next macrotask", () => {
    const target = makeTarget();
    const state = installBrowserSetImmediatePolyfill(target)!;
    const order: string[] = [];

    (target.setImmediate as any)(() => {
      order.push("first");
      (target.setImmediate as any)(() => order.push("nested"));
    });
    (target.setImmediate as any)((value: string) => order.push(value), "second");

    const channel = installedChannel();
    expect(channel.pendingTurns()).toBe(1);
    channel.flushNext();

    expect(order).toEqual(["first", "second"]);
    expect(state.pendingCount()).toBe(1);
    expect(state.queueLength()).toBe(1);
    expect(channel.pendingTurns()).toBe(1);

    channel.flushNext();
    expect(order).toEqual(["first", "second", "nested"]);
    expect(state.pendingCount()).toBe(0);
    expect(state.queueLength()).toBe(0);
  });

  it("yields a continuous immediate chain through the timer queue", () => {
    const target = makeTarget();
    let now = 0;
    const timers: Array<() => void> = [];
    target.performance = { now: () => now };
    target.setTimeout = callback => { timers.push(callback); };
    const state = installBrowserSetImmediatePolyfill(target)!;
    let calls = 0;
    const tick = () => {
      calls++;
      now += 2;
      (target.setImmediate as any)(tick);
    };
    (target.setImmediate as any)(tick);
    const channel = installedChannel();
    channel.flushNext();
    channel.flushNext();
    expect(calls).toBe(2);
    expect(channel.pendingTurns()).toBe(0);
    expect(timers).toHaveLength(1);
    expect(state.pendingCount()).toBe(1);
    timers.shift()!();
    channel.flushNext();
    expect(calls).toBe(3);
    expect(channel.pendingTurns()).toBe(1);
  });

  it("retains the yield budget when callbacks arrive between flushes", () => {
    const target = makeTarget();
    let now = 0;
    const timers: Array<() => void> = [];
    target.performance = { now: () => now };
    target.setTimeout = callback => { timers.push(callback); };
    installBrowserSetImmediatePolyfill(target);
    const callback = vi.fn();
    const channel = installedChannel();
    (target.setImmediate as any)(callback);
    channel.flushNext();
    now = 2;
    (target.setImmediate as any)(callback);
    channel.flushNext();
    now = 4;
    (target.setImmediate as any)(callback);
    expect(channel.pendingTurns()).toBe(0);
    expect(timers).toHaveLength(1);
    expect(callback).toHaveBeenCalledTimes(2);
    timers.shift()!();
    channel.flushNext();
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("keeps pending callbacks cancellable during a native scheduler yield", async () => {
    const target = makeTarget();
    let now = 0;
    let resume!: () => void;
    target.performance = { now: () => now };
    target.scheduler = { yield: vi.fn(() => new Promise<void>(resolve => { resume = resolve; })) };
    target.setTimeout = vi.fn();
    const state = installBrowserSetImmediatePolyfill(target)!;
    const kept = vi.fn();
    const cancelled = vi.fn();
    now = 4;
    (target.setImmediate as any)(kept);
    const handle = (target.setImmediate as any)(cancelled);
    (target.clearImmediate as any)(handle);
    const channel = installedChannel();
    expect(target.scheduler.yield).toHaveBeenCalledTimes(1);
    expect(target.setTimeout).not.toHaveBeenCalled();
    expect(channel.pendingTurns()).toBe(0);
    expect(state.pendingCount()).toBe(1);
    now = 10;
    resume();
    await Promise.resolve();
    channel.flushNext();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    (target.setImmediate as any)(kept);
    expect(target.scheduler.yield).toHaveBeenCalledTimes(1);
    channel.flushNext();
    expect(kept).toHaveBeenCalledTimes(2);
  });

  it("falls back to a timer when the scheduler yield rejects", async () => {
    const target = makeTarget();
    let now = 0;
    const timers: Array<() => void> = [];
    target.performance = { now: () => now };
    target.scheduler = { yield: () => Promise.reject(new Error("scheduler unavailable")) };
    target.setTimeout = callback => { timers.push(callback); };
    const state = installBrowserSetImmediatePolyfill(target)!;
    now = 4;
    const callback = vi.fn();
    (target.setImmediate as any)(callback);
    await Promise.resolve();
    expect(timers).toHaveLength(1);
    expect(state.pendingCount()).toBe(1);
    expect(installedChannel().pendingTurns()).toBe(0);
    timers.shift()!();
    installedChannel().flushNext();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(state.pendingCount()).toBe(0);
  });

  it("cancels only a matching pending immediate", () => {
    const target = makeTarget();
    const state = installBrowserSetImmediatePolyfill(target)!;
    const kept = vi.fn();
    const cancelled = vi.fn();

    (target.setImmediate as any)(kept);
    (target.clearImmediate as any)(1);
    const cancelledHandle = (target.setImmediate as any)(cancelled);
    (target.clearImmediate as any)(cancelledHandle);

    installedChannel().flushNext();

    expect(kept).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    expect(state.pendingCount()).toBe(0);
    expect(state.queueLength()).toBe(0);
  });

  it("does not retain unknown or already-delivered handles", () => {
    const target = makeTarget();
    const state = installBrowserSetImmediatePolyfill(target)!;

    (target.clearImmediate as any)(1);
    (target.clearImmediate as any)({ id: 1 });
    const delivered = (target.setImmediate as any)(() => {});
    installedChannel().flushNext();

    for (let i = 0; i < 10_000; i++) {
      (target.clearImmediate as any)(delivered);
      (target.clearImmediate as any)(i);
      (target.clearImmediate as any)({ id: i });
    }

    expect(state.pendingCount()).toBe(0);
    expect(state.queueLength()).toBe(0);
  });

  it("does not replace a host-provided setImmediate", () => {
    const setImmediate = vi.fn();
    const target = { ...makeTarget(), setImmediate };

    expect(installBrowserSetImmediatePolyfill(target)).toBeNull();
    expect(target.setImmediate).toBe(setImmediate);
  });
});
