/**
 * When the kernel's one CRTC has a vblank.
 *
 * Every mode the virtual connector advertises refreshes at 60 Hz, so the
 * kernel must see about 60 vblanks a second while a CRTC scans out. Where
 * the host has a display (a browser kernel worker with
 * `requestAnimationFrame`), each vblank is placed on a display frame and
 * carries that frame's timestamp, so a page flip completes when the browser
 * can actually show its framebuffer and clients see display-aligned times.
 * Where it has none (Node), where worker animation frames do not follow the
 * display (WebKit: see the kernel worker's constructor), or when the display
 * stops producing frames (a hidden page: browsers stop or throttle animation
 * frames there), a timer keeps the mode's rate.
 *
 * WHY frames rather than a free-running 60 Hz timer: Chromium runs a
 * `setInterval(1000 / 60)` every 16 ms against a 60 Hz display, at a phase
 * unrelated to the display's, so about one display frame in 24 received two
 * vblanks, and under load composed frames were replaced before they were
 * ever shown. Firefox ran the same timer at 58-59 Hz on the labwc desktop
 * (about 52 Hz in an idle worker).
 *
 * Display frames are decimated to the mode: a frame becomes a vblank once
 * the cumulative 60 Hz schedule says one is due (within `EARLY_MS`), never
 * sooner than `MIN_GAP_MS` after the previous vblank. A 60 Hz display
 * therefore gives a vblank on every frame, a 120 Hz display on every other
 * frame, and any faster display a mix of frame spacings averaging 60 Hz
 * (except 100-120 Hz panels whose frames are closer than `MIN_GAP_MS`,
 * which give every other frame: 110 Hz gives 55). A display slightly faster
 * than 60 Hz skips a frame now and then (60.05 Hz skips one in about 1200)
 * so the vblank rate stays the mode's: every vblank the mode does not
 * account for would be one a client could not have predicted.
 * A display slower than 60 Hz (or a browser throttling frames, as
 * low-power modes do) gives one vblank per frame it shows: a frame the
 * browser cannot show is not a vblank. When no frame arrives for
 * `ABSENT_MS`, the timer takes over at the mode's rate until frames resume.
 *
 * WHY a hidden page keeps 60 Hz rather than stopping or slowing: the CRTC
 * the guest turned on is still on. Turning a display off is the guest's
 * decision (DPMS, `ACTIVE`), which stops the vblank counter in the kernel;
 * a page the user is not looking at is a monitor nobody watches, which on
 * Linux keeps scanning out at its mode's refresh. Slowing vblanks while
 * hidden would make vblank counts disagree with the advertised mode, and
 * stopping them would stall every client waiting for a flip.
 */

export type VblankSource = "frame" | "timer";

export interface VblankClockHost {
  /** Milliseconds on the clock frame timestamps use (`performance.now()`). */
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** Display frames: the worker's `requestAnimationFrame`. Absent without a
   *  display. A request that throws marks frames unavailable for good. */
  requestFrame?: (callback: (frameTimeMs: number) => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
}

/** The refresh every advertised connector mode declares. */
export const VBLANK_PERIOD_MS = 1000 / 60;
/** A frame this much before the due time still takes the vblank. Less than
 *  half a 120 Hz frame, so a 120 Hz display never ticks on both frames. */
export const VBLANK_EARLY_MS = VBLANK_PERIOD_MS * 0.4;
/** The closest two frame vblanks can be. */
export const VBLANK_MIN_GAP_MS = VBLANK_PERIOD_MS * 0.6;
/** No display frame for this long means the display stopped (a hidden page)
 *  and the timer keeps the mode's rate. Longer than a 30 Hz frame, so a
 *  throttled display is still followed frame by frame. */
export const VBLANK_ABSENT_MS = VBLANK_PERIOD_MS * 2.5;

export class VblankClock {
  readonly #host: VblankClockHost;
  readonly #onVblank: (timeMs: number, source: VblankSource) => void;
  #running = false;
  #framesAvailable: boolean;
  /** Who produced the last vblank: frames, or the timer while frames are
   *  absent or unavailable. */
  #mode: VblankSource;
  /** The ideal time of the next vblank. */
  #due = 0;
  #lastVblank = -Infinity;
  #timer: unknown = null;
  #frame: unknown = null;

  constructor(
    host: VblankClockHost,
    onVblank: (timeMs: number, source: VblankSource) => void,
  ) {
    this.#host = host;
    this.#onVblank = onVblank;
    this.#framesAvailable = typeof host.requestFrame === "function";
    this.#mode = this.#framesAvailable ? "frame" : "timer";
  }

  get running(): boolean {
    return this.#running;
  }

  /** Whether display frames currently drive vblanks (false on a host without
   *  a display, and while frames are absent). */
  get followsDisplay(): boolean {
    return this.#mode === "frame";
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const now = this.#host.now();
    this.#due = now + VBLANK_PERIOD_MS;
    if (this.#framesAvailable && this.#requestFrame()) {
      this.#mode = "frame";
      this.#armTimer(VBLANK_ABSENT_MS);
    } else {
      this.#mode = "timer";
      this.#armTimer(VBLANK_PERIOD_MS);
    }
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      this.#host.clearTimer(this.#timer);
      this.#timer = null;
    }
    if (this.#frame !== null) {
      this.#host.cancelFrame?.(this.#frame);
      this.#frame = null;
    }
  }

  #requestFrame(): boolean {
    try {
      this.#frame = this.#host.requestFrame!((time) => this.#onFrame(time));
      return true;
    } catch {
      // A worker whose global cannot animate (no owning document) throws
      // NotSupportedError; such a host has no display to follow.
      this.#frame = null;
      this.#framesAvailable = false;
      return false;
    }
  }

  #armTimer(delayMs: number): void {
    if (this.#timer !== null) this.#host.clearTimer(this.#timer);
    this.#timer = this.#host.setTimer(() => this.#onTimer(), Math.max(0, delayMs));
  }

  #onFrame(frameTimeMs: number): void {
    this.#frame = null;
    if (!this.#running) return;
    if (!this.#requestFrame()) {
      // Frames just became unavailable: the timer keeps the mode's rate.
      this.#mode = "timer";
      this.#armTimer(this.#due - this.#host.now());
      return;
    }
    // Frames are flowing (again): the timer only watches for their absence.
    this.#mode = "frame";
    this.#armTimer(frameTimeMs + VBLANK_ABSENT_MS - this.#host.now());
    if (
      frameTimeMs < this.#due - VBLANK_EARLY_MS
      || frameTimeMs < this.#lastVblank + VBLANK_MIN_GAP_MS
    ) {
      return;
    }
    this.#lastVblank = frameTimeMs;
    // Keep the schedule cumulative, so frames arriving faster than the mode
    // average the mode's rate (a frame before the early window is skipped),
    // but never more than EARLY_MS behind this frame, so frames arriving
    // slower than the mode leave no debt that later fast frames would repay
    // with extra vblanks. MIN_GAP_MS still bounds how close two can be.
    this.#due = Math.max(
      this.#due + VBLANK_PERIOD_MS,
      frameTimeMs + VBLANK_PERIOD_MS - VBLANK_EARLY_MS,
    );
    this.#onVblank(frameTimeMs, "frame");
  }

  #onTimer(): void {
    this.#timer = null;
    if (!this.#running) return;
    const now = this.#host.now();
    this.#mode = "timer";
    this.#lastVblank = now;
    // Cumulative while on time, so the average rate is the mode's even when
    // timers fire late; a timer more than half a period late (a busy worker,
    // or the first tick after frames stopped) restarts the schedule rather
    // than bursting to catch up.
    this.#due = now - this.#due <= VBLANK_PERIOD_MS / 2
      ? this.#due + VBLANK_PERIOD_MS
      : now + VBLANK_PERIOD_MS;
    this.#armTimer(this.#due - now);
    this.#onVblank(now, "timer");
  }
}
