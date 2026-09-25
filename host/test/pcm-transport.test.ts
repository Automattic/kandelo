import { describe, expect, it } from "vitest";
import { PCM_SHARED_CONTROL_FIELDS } from "../src/generated/abi";
import {
  PCM_CONTROL,
  PCM_CONTROL_BYTES,
  PcmStreamState,
  pcmGuestAudioActivity,
  readRingBytes,
  readSeqlockedU64,
  signalPcmConsumerProgress,
  storeU32,
  writeSeqlockedU64,
} from "../src/audio/pcm-transport";

describe("PCM shared transport", () => {
  it("derives every AudioWorklet word index from generated ABI offsets", () => {
    for (const key of Object.keys(PCM_CONTROL) as Array<keyof typeof PCM_CONTROL>) {
      expect(PCM_CONTROL[key]).toBe(PCM_SHARED_CONTROL_FIELDS[key].offset / 4);
      expect(PCM_SHARED_CONTROL_FIELDS[key].size).toBe(4);
    }
  });

  it("reads and writes 64-bit cursors through 32-bit seqlocks", () => {
    const words = new Int32Array(new SharedArrayBuffer(16));
    const value = 0x1234_5678_abcd_ef01n;
    writeSeqlockedU64(words, 0, 1, 2, value);
    expect(readSeqlockedU64(words, 0, 1, 2)).toBe(value);
    expect(Atomics.load(words, 0) & 1).toBe(0);
  });

  it("copies bytes across a bounded ring wrap", () => {
    const ring = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...readRingBytes(ring, 6n, 5)]).toEqual([6, 7, 0, 1, 2]);
  });

  it("wakes every waiter on a one-shot consumer transition", async () => {
    const words = new Int32Array(new SharedArrayBuffer(256));
    const observed = Atomics.load(words, PCM_CONTROL.wakeSeq);
    const waiters = [
      Atomics.waitAsync(words, PCM_CONTROL.wakeSeq, observed),
      Atomics.waitAsync(words, PCM_CONTROL.wakeSeq, observed),
    ];
    expect(waiters.every((waiter) => waiter.async)).toBe(true);

    signalPcmConsumerProgress(words);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wokeAll = await Promise.race([
      Promise.all(waiters.map((waiter) => Promise.resolve(waiter.value))).then(
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 100);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    // Clean up the remaining waiter if this assertion ever regresses.
    Atomics.notify(words, PCM_CONTROL.wakeSeq);

    expect(wokeAll).toBe(true);
  });

  it("reports no guest audio for a transport the host merely claimed", () => {
    const words = new Int32Array(new SharedArrayBuffer(PCM_CONTROL_BYTES));
    storeU32(words, PCM_CONTROL.generation, 0);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Closed);
    expect(pcmGuestAudioActivity(words)).toBe(false);
  });

  it("reports guest audio once a stream is open", () => {
    const words = new Int32Array(new SharedArrayBuffer(PCM_CONTROL_BYTES));
    storeU32(words, PCM_CONTROL.generation, 1);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Stopped);
    expect(pcmGuestAudioActivity(words)).toBe(true);
  });

  // Review Focus 1: a program that plays a short sound and exits leaves the
  // state back at CLOSED. The monotonic generation is what records that it
  // happened, so a sampler cannot miss it.
  it("still reports guest audio after the stream closes again", () => {
    const words = new Int32Array(new SharedArrayBuffer(PCM_CONTROL_BYTES));
    storeU32(words, PCM_CONTROL.generation, 3);
    storeU32(words, PCM_CONTROL.state, PcmStreamState.Closed);
    expect(pcmGuestAudioActivity(words)).toBe(true);
  });
});
