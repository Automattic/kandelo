import { pcmGuestAudioActivity } from "./pcm-transport.js";

/**
 * How often to ask the shared control header whether a guest has opened the
 * audio device. This is one pair of `Atomics.load`s, and it stops for good on
 * the first positive answer, so the cost falls only on the machines that never
 * use audio — the exact machines this signal exists to keep quiet.
 */
export const AUDIO_ACTIVITY_SAMPLE_MS = 500;

/**
 * Latched "a guest opened /dev/dsp on this machine" flag.
 *
 * Latched on purpose: a program that speaks one sentence into a sink the user
 * never enabled should keep the warning up after it exits, because that is the
 * case where losing the warning costs the user most. The kernel's `generation`
 * word is monotonic, so the latch is also immune to sampling — a short
 * open/write/close between two ticks still leaves evidence behind.
 */
export class AudioActivityLatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private latched = false;

  constructor(
    private readonly words: Int32Array,
    private readonly onActivate: () => void,
    private readonly intervalMs: number = AUDIO_ACTIVITY_SAMPLE_MS,
  ) {}

  get active(): boolean {
    return this.latched;
  }

  /** Begin (or resume) sampling. A no-op once latched. */
  start(): void {
    if (this.latched || this.timer !== null) return;
    if (this.sample()) return;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private sample(): boolean {
    if (this.latched) return true;
    if (!pcmGuestAudioActivity(this.words)) return false;
    this.latched = true;
    this.stop();
    this.onActivate();
    return true;
  }
}
