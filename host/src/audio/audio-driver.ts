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
    /** Bound `kernel.exports.kernel_audio_get_appl_ptr` proxy. The
     * browser driver polls this each AudioWorklet quantum and forwards
     * the value into the worklet so it can gate `hwPtr` advance —
     * silence past `appl_ptr`, advance only over written ring
     * positions. Headless drivers (NodeAudioDriver) accept this for
     * dual-host signature parity and ignore the value. */
    getApplPtr: (pcmId: number) => number,
  ): Promise<void>;

  /** Stop pulling; tear down audio context / clear timers. Idempotent. */
  stop(pcmId: number): void;
}
