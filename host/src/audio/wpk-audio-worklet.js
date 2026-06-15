/**
 * `wpk-pcm-pull` — AudioWorklet processor that reads S16-interleaved
 * frames from a kernel-memory ring (a SharedArrayBuffer slice exposed
 * via `kernel_audio_init_sab`) and pushes them onto the AudioContext
 * output bus.
 *
 * Producer/consumer gating: the worklet's local `hwPtr` is monotonic
 * (absolute frame count since attach). On every quantum it consumes
 * up to 128 frames, but never past the kernel's `appl_ptr` — the
 * BrowserAudioDriver polls `kernel_audio_get_appl_ptr` on a 10 ms
 * interval and posts the value via `{ applPtr }`. Frames past
 * `appl_ptr` emit silence and don't advance `hwPtr`. The kernel-side
 * `kernel_audio_period_tick` is driven by `framesConsumed` so the
 * kernel only advances `mmap_status.hw_ptr` by frames the worklet
 * actually played — non-RUNNING / non-written quanta don't count
 * against avail, and no spurious XRUN fires.
 *
 * This gating fixes the head-truncation race observed in espeak-ng:
 * the worklet starts immediately on attach, but espeak-ng's ~500 ms
 * data-file load + synth init means the kernel's appl_ptr stays at
 * 0 for the first ~11 000 frames at 22 050 Hz. Without gating, the
 * worklet's hwPtr ticks past those ring offsets, so when the first
 * WRITEI lands at ring[0..], the worklet has already passed them
 * and won't revisit until ring wraparound — the head of the
 * synthesised phrase is buried.
 */

class WpkPcmPullProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { buffer, byteOffset, byteLength, channels } =
      options.processorOptions;
    // s16 interleaved view onto the kernel ring window.
    this.ring = new Int16Array(buffer, byteOffset, byteLength / 2);
    this.ringFrames = this.ring.length / channels;
    this.channels = channels;
    // Absolute frame count consumed; modulo ringFrames when indexing
    // into the SAB.
    this.hwPtr = 0;
    // Latest producer position posted by BrowserAudioDriver. The
    // worklet never reads or advances past this.
    this.applPtr = 0;
    this.port.onmessage = (e) => {
      const data = e.data;
      if (data && typeof data.applPtr === "number") {
        this.applPtr = data.applPtr;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0]; // out[channel][sample]
    const frames = out[0].length; // always 128
    const ringFrames = this.ringFrames;
    const ch = this.channels;
    const ring = this.ring;
    const applPtr = this.applPtr;
    const hw = this.hwPtr;
    // Number of frames available to consume this quantum (capped by
    // producer progress, never negative).
    const available = Math.max(0, Math.min(frames, applPtr - hw));
    for (let f = 0; f < available; f++) {
      const ringOff = ((hw + f) % ringFrames) * ch;
      for (let c = 0; c < ch; c++) {
        // s16 → f32 conversion for the WebAudio output bus.
        out[c][f] = ring[ringOff + c] / 0x8000;
      }
    }
    for (let f = available; f < frames; f++) {
      for (let c = 0; c < ch; c++) out[c][f] = 0;
    }
    this.hwPtr = hw + available;
    this.port.postMessage({ framesConsumed: available });
    return true;
  }
}

registerProcessor("wpk-pcm-pull", WpkPcmPullProcessor);
