/**
 * `AudioDriver` — host-side abstraction over an ALSA PCM consumer.
 * One implementation per host: `BrowserAudioDriver` pulls samples on
 * each AudioWorklet quantum and routes them to a `WebAudio`
 * `AudioContext`; `NodeAudioDriver` is a `setInterval`-driven dummy
 * for headless tests. The host wires `start` after the kernel has
 * exported a SAB-backed ring via `kernel_audio_init_sab`, and routes
 * `kernelTick` (`kernel.exports.kernel_audio_period_tick`) back into
 * the kernel once per ALSA period — same shape Linux's hw_ptr
 * advancement uses.
 */

/** Where the SAB ring lives in kernel-visible memory. `buffer` is the
 * kernel's WebAssembly.Memory backing store (a `SharedArrayBuffer` in
 * the shared-memory build); `byteOffset` + `byteLength` cover the
 * region the kernel registered via `kernel_audio_init_sab`. */
export interface AudioRing {
  buffer: SharedArrayBuffer | ArrayBuffer;
  byteOffset: number;
  byteLength: number;
}

/** 4-byte SAB slot inside kernel-visible memory holding the live
 * `mmap_control.appl_ptr` for one PCM. The kernel writes it on every
 * `WRITEI_FRAMES`; the AudioWorklet reads it via `Atomics.load` so it
 * sees fresh producer progress on every quantum (no `setInterval` +
 * `postMessage` round-trip — that combination caused ~12 % silence
 * emission and the §C jitter in handoff-3). Optional for backward
 * compatibility with hosts that don't bind one; the worklet falls back
 * to the legacy `postMessage(applPtr)` path in that case. */
export interface AudioApplPtrSab {
  buffer: SharedArrayBuffer | ArrayBuffer;
  byteOffset: number;
}

export interface AudioDriver {
  /** Begin pulling frames from the SAB ring registered for `pcmId`.
   * `kernelTick` is the bound `kernel.exports.kernel_audio_period_tick`
   * proxy; the driver invokes it once `periodFrames` worth of frames
   * have been consumed so the kernel can advance `mmap_status.hw_ptr`
   * and wake POLLOUT waiters. Idempotent: calling `start` again with
   * the same `pcmId` is a no-op. */
  start(
    pcmId: number,
    sampleRate: number,
    channels: number,
    periodFrames: number,
    ring: AudioRing,
    kernelTick: (pcmId: number, framesConsumed: number) => void,
    /** Bound `kernel.exports.kernel_audio_get_appl_ptr` proxy. With a
     * SAB-backed `applPtrSab` in place this is only used by `stop()`
     * to compute the final drain delta; absent that, the browser
     * driver falls back to the legacy 10 ms poll → `postMessage`
     * chain. Headless drivers (NodeAudioDriver) accept this for
     * dual-host signature parity and ignore the value. */
    getApplPtr: (pcmId: number) => number,
    /** SAB slot the kernel mirrors `appl_ptr` into on every
     * `WRITEI_FRAMES`. When present, the browser worklet reads from
     * this slot directly via `Atomics.load` — zero-latency producer
     * progress, eliminating the 10 ms poll round-trip. Optional;
     * absence falls back to the legacy `getApplPtr` poll path. */
    applPtrSab?: AudioApplPtrSab,
  ): Promise<void>;

  /** Stop pulling; tear down audio context / clear timers. Idempotent. */
  stop(pcmId: number): void;
}
