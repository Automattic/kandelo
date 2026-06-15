/**
 * Regression spec for `instrumentAudioDriver`'s forwarding contract.
 *
 * Session 42 shipped a wrapper whose `start()` dropped the new
 * `getApplPtr` argument when delegating to the inner driver, which
 * silently disabled the AudioWorklet's producer-pointer gate and
 * cut the head off every spoken phrase. These tests pin every
 * `AudioDriver.start()` parameter so a future signature drift fails
 * loudly instead of producing silence.
 */
import { describe, it, expect, vi } from "vitest";
import { instrumentAudioDriver } from "../src/audio/instrumented-audio-driver";
import type { AudioDriver, AudioRing } from "../src/audio/audio-driver";

function makeMockInner(): AudioDriver & {
  startSpy: ReturnType<typeof vi.fn>;
  stopSpy: ReturnType<typeof vi.fn>;
} {
  const startSpy = vi.fn(async () => undefined);
  const stopSpy = vi.fn();
  return {
    start: startSpy as unknown as AudioDriver["start"],
    stop: stopSpy,
    startSpy,
    stopSpy,
  };
}

const fakeRing: AudioRing = {
  buffer: new ArrayBuffer(64 * 1024),
  byteOffset: 0,
  byteLength: 64 * 1024,
};

describe("instrumentAudioDriver", () => {
  it("forwards every start() argument to the inner driver", async () => {
    const inner = makeMockInner();
    const wrapper = instrumentAudioDriver(inner);
    const kernelTick = vi.fn();
    const getApplPtr = vi.fn(() => 4242);

    await wrapper.start(7, 22_050, 2, 1024, fakeRing, kernelTick, getApplPtr);

    expect(inner.startSpy).toHaveBeenCalledTimes(1);
    const args = inner.startSpy.mock.calls[0];
    expect(args[0]).toBe(7);
    expect(args[1]).toBe(22_050);
    expect(args[2]).toBe(2);
    expect(args[3]).toBe(1024);
    expect(args[4]).toBe(fakeRing);
    expect(typeof args[5]).toBe("function");
    expect(args[6]).toBe(getApplPtr);
  });

  it("preserves the getApplPtr reference identity (not wrapped)", async () => {
    const inner = makeMockInner();
    const wrapper = instrumentAudioDriver(inner);
    const sentinelApplPtr = vi.fn(() => 0);

    await wrapper.start(0, 48_000, 2, 1024, fakeRing, () => {}, sentinelApplPtr);

    const fwd = inner.startSpy.mock.calls[0][6];
    expect(fwd).toBe(sentinelApplPtr);
    expect(fwd(99)).toBe(0);
    expect(sentinelApplPtr).toHaveBeenCalledWith(99);
  });

  it("accumulates framesConsumed across inner ticks and exposes the running total", async () => {
    const inner = makeMockInner();
    const wrapper = instrumentAudioDriver(inner);
    let observed = -1;

    await wrapper.start(
      0,
      48_000,
      2,
      1024,
      fakeRing,
      (_id, frames) => {
        observed = frames;
      },
      () => 0,
    );

    const wrappedTick = inner.startSpy.mock.calls[0][5] as (
      id: number,
      frames: number,
    ) => void;

    wrappedTick(0, 1024);
    expect(wrapper.framesConsumed()).toBe(1024);
    expect(observed).toBe(1024);

    wrappedTick(0, 1024);
    expect(wrapper.framesConsumed()).toBe(2048);
  });

  it("notifies the observer with both the delta and the running total", async () => {
    const inner = makeMockInner();
    const observer = vi.fn();
    const wrapper = instrumentAudioDriver(inner, observer);

    await wrapper.start(0, 48_000, 2, 1024, fakeRing, () => {}, () => 0);
    const wrappedTick = inner.startSpy.mock.calls[0][5] as (
      id: number,
      frames: number,
    ) => void;

    wrappedTick(0, 256);
    expect(observer).toHaveBeenLastCalledWith(256, 256);
    wrappedTick(0, 768);
    expect(observer).toHaveBeenLastCalledWith(768, 1024);
  });

  it("delegates stop() to the inner driver", () => {
    const inner = makeMockInner();
    const wrapper = instrumentAudioDriver(inner);
    wrapper.stop(3);
    expect(inner.stopSpy).toHaveBeenCalledWith(3);
  });
});
