import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_ACTIVITY_SAMPLE_MS,
  AudioActivityLatch,
} from "../src/audio/audio-activity-latch";
import {
  PCM_CONTROL,
  PCM_CONTROL_BYTES,
  PcmStreamState,
  storeU32,
} from "../src/audio/pcm-transport";

function closedHeader(): Int32Array {
  const words = new Int32Array(new SharedArrayBuffer(PCM_CONTROL_BYTES));
  storeU32(words, PCM_CONTROL.generation, 0);
  storeU32(words, PCM_CONTROL.state, PcmStreamState.Closed);
  return words;
}

describe("AudioActivityLatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays inactive while no guest opens the device", () => {
    const latch = new AudioActivityLatch(closedHeader(), () => {});
    latch.start();
    vi.advanceTimersByTime(AUDIO_ACTIVITY_SAMPLE_MS * 20);
    expect(latch.active).toBe(false);
  });

  it("latches and notifies once when a guest opens the device", () => {
    const words = closedHeader();
    const onActivate = vi.fn();
    const latch = new AudioActivityLatch(words, onActivate);
    latch.start();
    vi.advanceTimersByTime(AUDIO_ACTIVITY_SAMPLE_MS);
    expect(latch.active).toBe(false);

    storeU32(words, PCM_CONTROL.generation, 1);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Stopped);
    vi.advanceTimersByTime(AUDIO_ACTIVITY_SAMPLE_MS);

    expect(latch.active).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("stops sampling once latched", () => {
    const words = closedHeader();
    storeU32(words, PCM_CONTROL.generation, 1);
    const latch = new AudioActivityLatch(words, () => {});
    latch.start();
    vi.advanceTimersByTime(AUDIO_ACTIVITY_SAMPLE_MS);
    expect(latch.active).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Review Focus 2: a subscriber may come and go. Because the signal is
  // latched and generation is monotonic, a later start() catches up on an
  // open that happened while nobody was watching.
  it("catches up on an open that happened while stopped", () => {
    const words = closedHeader();
    const latch = new AudioActivityLatch(words, () => {});
    latch.start();
    latch.stop();
    storeU32(words, PCM_CONTROL.generation, 7);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Closed);
    latch.start();
    expect(latch.active).toBe(true);
  });

  it("clears its timer on stop", () => {
    const latch = new AudioActivityLatch(closedHeader(), () => {});
    latch.start();
    expect(vi.getTimerCount()).toBe(1);
    latch.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
