import { describe, expect, it, vi } from "vitest";
import {
  installSetImmediatePolyfill,
  type ImmediatePolyfillTarget,
} from "../src/set-immediate-polyfill";

function makeTarget(): ImmediatePolyfillTarget {
  return {
    MessageChannel,
  };
}

function waitForImmediate(target: ImmediatePolyfillTarget): Promise<void> {
  return new Promise((resolve) => {
    target.setImmediate!(resolve);
  });
}

describe("browser setImmediate polyfill", () => {
  it("runs queued callbacks and clears pending state after flush", async () => {
    const target = makeTarget();
    const state = installSetImmediatePolyfill(target)!;
    const fn = vi.fn();

    target.setImmediate!(fn, "value");
    await waitForImmediate(target);

    expect(fn).toHaveBeenCalledWith("value");
    expect(state.pendingCount()).toBe(0);
    expect(state.queueLength()).toBe(0);
  });

  it("cancels only pending immediates", async () => {
    const target = makeTarget();
    const state = installSetImmediatePolyfill(target)!;
    const cancelled = vi.fn();
    const kept = vi.fn();

    const id = target.setImmediate!(cancelled);
    target.clearImmediate!(id);
    target.setImmediate!(kept);
    await waitForImmediate(target);

    expect(cancelled).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
    expect(state.pendingCount()).toBe(0);
    expect(state.queueLength()).toBe(0);
  });

  it("does not retain unknown or already-fired clearImmediate handles", async () => {
    const target = makeTarget();
    const state = installSetImmediatePolyfill(target)!;
    const fired = target.setImmediate!(() => {});

    await waitForImmediate(target);
    for (let id = fired; id < fired + 100_000; id++) {
      target.clearImmediate!(id);
    }

    expect(state.pendingCount()).toBe(0);
    expect(state.queueLength()).toBe(0);
  });
});
