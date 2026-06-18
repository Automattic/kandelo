/**
 * `BrowserAudioDriver` — pulls S16-interleaved frames from a
 * kernel-memory SAB ring on every `AudioWorklet` quantum (128 frames)
 * and routes them to a `WebAudio` `AudioContext` for playback. After
 * every `periodFrames` worth of consumed frames it invokes the bound
 * `kernel_audio_period_tick` proxy so the kernel can advance
 * `mmap_status.hw_ptr` and wake `POLLOUT` waiters.
 *
 * The worklet runs on the audio thread and can't call kernel exports
 * directly; instead it posts a `{ framesConsumed }` message on each
 * quantum. The main thread accumulates those quanta and calls
 * `kernelTick` once per ALSA period.
 *
 * The ring lives inside the kernel's `WebAssembly.Memory` (a
 * `SharedArrayBuffer` in the shared-memory build) so the worklet and
 * the kernel see the same bytes. The kernel registered the
 * `(base, len)` window via `kernel_audio_init_sab` at boot; the host
 * just forwards it into the worklet's `processorOptions`.
 */

import type {
  AudioApplPtrSab,
  AudioDriver,
  AudioRing,
} from "./audio-driver.js";

/** Public for tests: URL the worklet processor is registered at.
 * Apps embedding this driver are expected to host the worklet js at
 * this path (the file ships next to this module). */
export const WPK_AUDIO_WORKLET_URL = "/audio/wpk-audio-worklet.js";

interface PcmContext {
  audioCtx: AudioContext;
  worklet: AudioWorkletNode;
  ring: AudioRing;
  sampleRate: number;
  channels: number;
  periodFrames: number;
  framesSinceTick: number;
  /** Cumulative frames played by the worklet (sum of all per-quantum
   * `framesConsumed`). Used by `stop()` to estimate how much tail is
   * still buffered in the ring so it can wait that long before closing
   * the AudioContext — without this, the last word of a phrase gets
   * truncated. */
  totalFramesConsumed: number;
  /** Latest `appl_ptr` observed at `stop()` time, used by the drain
   * math (legacy poll path also writes this on every interval tick). */
  lastApplPtr: number;
  kernelTick: (pcmId: number, frames: number) => void;
  getApplPtr: (pcmId: number) => number;
  /** Legacy poll handle (10 ms `setInterval` pushing `appl_ptr` into
   * the worklet via `postMessage`). Armed only when no
   * `applPtrSab` is bound — with the SAB in place the worklet reads
   * the value directly via `Atomics.load` and this stays `null`. */
  applPtrPollHandle: ReturnType<typeof setInterval> | null;
}

export class BrowserAudioDriver implements AudioDriver {
  private contexts = new Map<number, PcmContext>();

  constructor(private workletUrl: string = WPK_AUDIO_WORKLET_URL) {}

  async start(
    pcmId: number,
    sampleRate: number,
    channels: number,
    periodFrames: number,
    ring: AudioRing,
    kernelTick: (pcmId: number, framesConsumed: number) => void,
    getApplPtr: (pcmId: number) => number,
    applPtrSab?: AudioApplPtrSab,
  ): Promise<void> {
    if (this.contexts.has(pcmId)) return;

    const audioCtx = new AudioContext({ sampleRate });
    await audioCtx.audioWorklet.addModule(this.workletUrl);
    const worklet = new AudioWorkletNode(audioCtx, "wpk-pcm-pull", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: {
        buffer: ring.buffer,
        byteOffset: ring.byteOffset,
        byteLength: ring.byteLength,
        channels,
        // SAB-backed `appl_ptr` mirror — the kernel writes the live
        // producer pointer here on every WRITEI; the worklet reads it
        // via `Atomics.load(int32, 0)` on every quantum with no
        // postMessage / poll latency. Missing fields fall back to the
        // legacy 10 ms poll path armed below.
        applPtrBuffer: applPtrSab?.buffer,
        applPtrByteOffset: applPtrSab?.byteOffset,
      },
    });
    worklet.connect(audioCtx.destination);

    const ctx: PcmContext = {
      audioCtx,
      worklet,
      ring,
      sampleRate,
      channels,
      periodFrames,
      framesSinceTick: 0,
      totalFramesConsumed: 0,
      lastApplPtr: 0,
      kernelTick,
      getApplPtr,
      applPtrPollHandle: null,
    };
    if (!applPtrSab) {
      // Legacy path: 10 ms poll → `postMessage(applPtr)` to the
      // worklet. Only used when the host hasn't bound an `applPtrSab`
      // (older tests, or hosts that opted out). The new SAB path is
      // zero-latency and is the default in `BrowserKernel`. Without
      // gating here, the worklet's local `hwPtr` ticks at
      // AudioContext rate from the moment the node connects (~5 ms
      // after this call), and any userspace setup latency before the
      // first WRITEI (espeak-ng spends ~500 ms loading data files
      // before its first synth chunk lands) becomes a chunk of the
      // head audio buried at ring offsets the worklet has already
      // passed.
      ctx.applPtrPollHandle = setInterval(() => {
        const applPtr = getApplPtr(pcmId);
        ctx.lastApplPtr = applPtr;
        worklet.port.postMessage({ applPtr });
      }, 10);
    }
    worklet.port.onmessage = (
      e: MessageEvent<{ framesConsumed?: number }>,
    ) => {
      const data = e.data;
      if (typeof data.framesConsumed !== "number") return;
      ctx.framesSinceTick += data.framesConsumed;
      ctx.totalFramesConsumed += data.framesConsumed;
      while (ctx.framesSinceTick >= ctx.periodFrames) {
        ctx.kernelTick(pcmId, ctx.periodFrames);
        ctx.framesSinceTick -= ctx.periodFrames;
      }
    };
    this.contexts.set(pcmId, ctx);
  }

  /**
   * Drain the buffered tail before closing the AudioContext. When
   * `stop()` is called, the kernel's `appl_ptr` typically leads the
   * worklet's `totalFramesConsumed` by up to one ring's worth of
   * frames — userspace `WRITEI` can fill ahead of realtime playback up
   * to the SAB ring capacity. Closing the AudioContext immediately
   * truncates that tail. Instead, we keep polling appl_ptr until it
   * stops growing (producer done), then sleep just long enough for the
   * worklet to play the residual delta, and only then close.
   * Synchronous return — the actual teardown happens on a timer.
   */
  stop(pcmId: number): void {
    const ctx = this.contexts.get(pcmId);
    if (!ctx) return;
    this.contexts.delete(pcmId);
    // Stop pushing applPtr into the worklet (legacy poll path).
    // Under the SAB-backed path this is a no-op — the kernel stopped
    // mirroring `appl_ptr` once the producer drained, so the
    // worklet's next Atomics.load returns the same value.
    if (ctx.applPtrPollHandle !== null) {
      clearInterval(ctx.applPtrPollHandle);
    }

    const finalApplPtr = ctx.getApplPtr(pcmId);
    if (finalApplPtr > ctx.lastApplPtr) {
      ctx.lastApplPtr = finalApplPtr;
      // Push the final value so the worklet can play it out.
      ctx.worklet.port.postMessage({ applPtr: finalApplPtr });
    }

    const close = () => {
      ctx.worklet.port.onmessage = null;
      ctx.worklet.disconnect();
      void ctx.audioCtx.close();
    };

    const pending = Math.max(0, ctx.lastApplPtr - ctx.totalFramesConsumed);
    if (pending === 0) {
      close();
      return;
    }
    // Wait for the worklet to play out the pending frames at audio
    // rate, plus a 100 ms safety margin. The margin covers the
    // browser's AudioContext output-queue latency (the worklet
    // posts `framesConsumed` immediately, but the samples then sit
    // in the platform audio buffer for a browser-dependent interval
    // before the speaker emits them). 100 ms is empirically
    // sufficient on Chrome/Safari/Firefox for the espeak demo; the
    // worklet quantum (128 frames ≈ 2.67 ms @ 48 kHz) is far
    // smaller than this margin. `applPtr` is stable at this point
    // — espeak-ng's drain has already returned, so we don't re-poll.
    const drainMs = (pending / ctx.sampleRate) * 1000 + 100;
    setTimeout(close, drainMs);
  }
}
