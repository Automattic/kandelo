/**
 * `wpk-pcm-pull` — AudioWorklet processor that reads S16-interleaved
 * frames from a kernel-memory ring (a SharedArrayBuffer slice exposed
 * via `kernel_audio_init_sab`) and pushes them onto the AudioContext
 * output bus.
 *
 * Producer/consumer gating: the worklet's local `hwPtr` is monotonic
 * (absolute frame count since attach). On every quantum it consumes
 * up to 128 frames, but never past the kernel's `appl_ptr`.
 *
 * Producer-pointer source:
 *   - Preferred — a 4-byte SAB slot bound by
 *     `kernel_audio_init_appl_ptr_sab`. The kernel mirrors `appl_ptr`
 *     into it on every WRITEI; the worklet reads via
 *     `Atomics.load(int32, 0)` here. Zero-latency producer progress,
 *     no `postMessage` round-trip from the main thread. This was
 *     introduced to fix the §C jitter (`docs/plans/
 *     2026-06-17-sdl2-browser-rendering-handoff-3.md`) — the
 *     10 ms-poll + postMessage chain caused ~12 % silence emission
 *     once playback rate matched producer rate.
 *   - Legacy fallback — `BrowserAudioDriver` arms a 10 ms
 *     `setInterval` poll on `kernel_audio_get_appl_ptr` and posts the
 *     value here via `{ applPtr }`. Only used when the host did not
 *     bind a SAB slot.
 *
 * Either way, frames past `appl_ptr` emit silence and don't advance
 * `hwPtr`. The kernel-side `kernel_audio_period_tick` is driven by
 * `framesConsumed` so the kernel only advances `mmap_status.hw_ptr`
 * by frames the worklet actually played — non-RUNNING / non-written
 * quanta don't count against avail, and no spurious XRUN fires.
 *
 * The gating also fixes the head-truncation race observed in espeak-ng:
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
    const {
      buffer,
      byteOffset,
      byteLength,
      channels,
      applPtrBuffer,
      applPtrByteOffset,
    } = options.processorOptions;
    // s16 interleaved view onto the kernel ring window.
    this.ring = new Int16Array(buffer, byteOffset, byteLength / 2);
    this.ringFrames = this.ring.length / channels;
    this.channels = channels;
    // Absolute frame count consumed; modulo ringFrames when indexing
    // into the SAB.
    this.hwPtr = 0;
    // Latest producer position. Sourced from the SAB mirror when
    // bound; otherwise updated via the legacy `{ applPtr }` message.
    this.applPtr = 0;
    this.applPtrView = applPtrBuffer
      ? new Int32Array(applPtrBuffer, applPtrByteOffset, 1)
      : null;
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
    // Refresh `applPtr` from the SAB mirror every quantum. The kernel
    // wrote a `u32` into the slot from a non-atomic Wasm `i32.store`
    // (aligned, so 4-byte tearing is structurally impossible on
    // current Wasm runtimes); `Atomics.load` gives us a happens-before
    // ordered read so we never see a half-updated value.
    const applPtr = this.applPtrView !== null
      ? Atomics.load(this.applPtrView, 0) >>> 0
      : this.applPtr;
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
