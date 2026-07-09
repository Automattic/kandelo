/**
 * Wraps any `AudioDriver` so callers can observe accumulated frames
 * played by the underlying worklet without reaching inside the
 * driver. The Playwright spec for `/?demo=espeak` uses this to assert
 * non-zero playback (`window.__alsaFramesConsumed`).
 *
 * The forwarding has bit us once: session 42 shipped a wrapper whose
 * `start()` dropped the new `getApplPtr` parameter when calling
 * `inner.start()`, silently disabling the producer-pointer gate that
 * prevents head-truncation. The regression spec
 * (`host/test/instrumented-audio-driver.test.ts`) pins forwarding of
 * every argument the `AudioDriver` interface declares.
 */
import type {
  AudioApplPtrSab,
  AudioDriver,
  AudioRing,
} from "./audio-driver.js";

export interface InstrumentedAudioDriver extends AudioDriver {
  framesConsumed(): number;
}

export function instrumentAudioDriver(
  inner: AudioDriver,
  onFramesConsumed?: (frames: number, total: number) => void,
): InstrumentedAudioDriver {
  let total = 0;
  return {
    async start(
      pcmId: number,
      sampleRate: number,
      channels: number,
      periodFrames: number,
      ring: AudioRing,
      kernelTick: (id: number, frames: number) => void,
      getApplPtr: (id: number) => number,
      applPtrSab?: AudioApplPtrSab,
    ): Promise<void> {
      await inner.start(
        pcmId,
        sampleRate,
        channels,
        periodFrames,
        ring,
        (id, frames) => {
          total += frames;
          onFramesConsumed?.(frames, total);
          kernelTick(id, frames);
        },
        getApplPtr,
        applPtrSab,
      );
    },
    stop(pcmId: number): void {
      inner.stop(pcmId);
    },
    framesConsumed(): number {
      return total;
    },
  };
}
