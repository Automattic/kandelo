/**
 * `NodeAudioDriver` — headless dummy that schedules a `setInterval`
 * matching the ALSA period cadence and calls the bound
 * `kernel_audio_period_tick` proxy each fire. There's no real audio
 * sink on Node; the SAB ring is consumed in name only — the kernel
 * uses the period_tick to advance `mmap_status.hw_ptr` and wake
 * `POLLOUT` waiters so userspace can keep writing.
 *
 * Used by Vitest's audio specs and by any kandelo CLI run that
 * exercises ALSA-shaped programs without a WebAudio output. Mirrors
 * `BrowserAudioDriver` so the Node + browser host init paths stay
 * symmetric per CLAUDE.md §"Two hosts".
 */

import type {
  AudioApplPtrSab,
  AudioDriver,
  AudioRing,
} from "./audio-driver.js";

interface PcmTimer {
  intervalHandle: ReturnType<typeof setInterval>;
  ring: AudioRing;
  periodFrames: number;
}

export class NodeAudioDriver implements AudioDriver {
  private timers = new Map<number, PcmTimer>();

  async start(
    pcmId: number,
    sampleRate: number,
    _channels: number,
    periodFrames: number,
    ring: AudioRing,
    kernelTick: (pcmId: number, framesConsumed: number) => void,
    // Headless driver has no AudioWorklet to gate — the kernel-side
    // hw_ptr advance is what `kernelTick` drives. Kept in the signature
    // for dual-host parity per `AudioDriver`.
    _getApplPtr: (pcmId: number) => number,
    _applPtrSab?: AudioApplPtrSab,
  ): Promise<void> {
    if (this.timers.has(pcmId)) return;
    const intervalMs = (periodFrames * 1000) / sampleRate;
    const handle = setInterval(
      () => kernelTick(pcmId, periodFrames),
      intervalMs,
    );
    this.timers.set(pcmId, { intervalHandle: handle, ring, periodFrames });
  }

  stop(pcmId: number): void {
    const t = this.timers.get(pcmId);
    if (!t) return;
    clearInterval(t.intervalHandle);
    this.timers.delete(pcmId);
  }
}
