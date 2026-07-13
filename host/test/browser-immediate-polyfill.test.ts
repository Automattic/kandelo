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
    const target = {
      MessageChannel: ManualMessageChannel as unknown as typeof MessageChannel,
      setImmediate,
    };

    expect(installBrowserSetImmediatePolyfill(target)).toBeNull();
    expect(target.setImmediate).toBe(setImmediate);
  });
});
