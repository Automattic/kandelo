import { describe, expect, it, vi } from "vitest";
import { installBrowserSetImmediatePolyfill } from "../src/browser-immediate-polyfill";

class FakePort {
  onmessage: (() => void) | null = null;
  peer: FakePort | null = null;

  postMessage(_value: unknown): void {
    setTimeout(() => this.peer?.onmessage?.(), 0);
  }
}

class FakeMessageChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

function makeGlobal() {
  return { MessageChannel: FakeMessageChannel as unknown as typeof MessageChannel };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("installBrowserSetImmediatePolyfill", () => {
  it("ignores clearImmediate for timeout-style numeric handles", async () => {
    const globalObject = makeGlobal();
    installBrowserSetImmediatePolyfill(globalObject);

    const fn = vi.fn();
    const handle = (globalObject as any).setImmediate(fn);

    (globalObject as any).clearImmediate(1);
    await nextTurn();

    expect(handle).toEqual(expect.objectContaining({ __kandeloBrowserImmediate: true }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("treats clearImmediate after callback delivery as a no-op", async () => {
    const globalObject = makeGlobal();
    installBrowserSetImmediatePolyfill(globalObject);

    const fn = vi.fn();
    const handle = (globalObject as any).setImmediate(fn);
    await nextTurn();

    for (let i = 0; i < 10_000; i++) {
      (globalObject as any).clearImmediate(handle);
      (globalObject as any).clearImmediate(i);
    }

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancels pending immediate handles", async () => {
    const globalObject = makeGlobal();
    installBrowserSetImmediatePolyfill(globalObject);

    const fn = vi.fn();
    const handle = (globalObject as any).setImmediate(fn);
    (globalObject as any).clearImmediate(handle);
    await nextTurn();

    expect(fn).not.toHaveBeenCalled();
  });
});
