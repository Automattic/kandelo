/**
 * `BrowserInputSource` — captures DOM keyboard/pointer/wheel events,
 * translates them to Linux evdev records (`KEY_*`, `BTN_*`, `REL_*`,
 * `ABS_*`) and closes each logical input with a `SYN_REPORT`. Wired
 * into `kernel.exports.kernel_input_event` by the browser host's worker
 * entry at boot (B4).
 *
 * Coordinate convention:
 *   - Pointer-lock active   → REL_X / REL_Y deltas (from movementX/Y).
 *   - Pointer-lock inactive → REL_X / REL_Y deltas derived from the
 *     change in absolute viewport position (clientX/Y minus the previous
 *     clientX/Y).
 *   Both branches emit *relative* motion because `/dev/input/event1`
 *   advertises REL_X/REL_Y: SDL2's evdev backend classifies it as a
 *   relative mouse and ignores EV_ABS entirely (see the PEG note in
 *   web-libs/kandelo-session kernel-host.ts). Emitting EV_ABS here would
 *   silently produce no motion. The device still advertises ABS_X/Y with
 *   canvas maxima for callers that read EVIOCGABS bounds, which is why the
 *   resize hook below keeps those maxima current.
 *   The absolute→delta baseline is cleared on a pointer-lock transition
 *   and when the pointer leaves the target, so re-entry never reports a
 *   phantom jump. On a lock transition we also emit a bare SYN_REPORT so
 *   SDL2 sees a re-sync point and doesn't carry a stale axis value.
 *
 * Event-type / SYN / REL / BTN codes come from the generated ABI
 * (`INPUT_CODES`), sourced from `shared::input`, so a code renumber in
 * the kernel cannot silently leave this translator emitting a stale
 * value.
 */
import type { InputSource, InputEvent } from "./input-source.js";
import { INPUT_CODES } from "../generated/abi.js";
import { codeToKey } from "./key-code-table.js";

const {
  EV_SYN,
  EV_KEY,
  EV_REL,
  SYN_REPORT,
  REL_X,
  REL_Y,
  REL_WHEEL,
  REL_HWHEEL,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_MIDDLE,
} = INPUT_CODES;

export class BrowserInputSource implements InputSource {
  private dispatch: ((ev: InputEvent) => void) | null = null;
  private bindings: Array<
    [EventTarget, string, EventListener, AddEventListenerOptions | undefined]
  > = [];
  // Previous absolute pointer position (rounded clientX/Y), used to derive
  // REL deltas outside pointer lock. `null` means "no baseline yet" — the
  // next non-lock move only re-establishes it and emits no motion.
  private lastAbsX: number | null = null;
  private lastAbsY: number | null = null;

  /**
   * @param target  Event source to bind to (defaults to `window`).
   * @param opts.pointer  When `false`, the pointer motion/button handlers
   *   are not bound. Used when another surface owns the pointer feed (e.g.
   *   the Modeset pane injects framebuffer-positioned pointer events into
   *   `/dev/input/event1` itself, and a second window feed would fight it).
   * @param opts.wheel  Overrides whether the wheel handler is bound;
   *   defaults to following `pointer`. Wheel events are REL_WHEEL and carry
   *   no absolute coordinates, so `{ pointer: false, wheel: true }` lets a
   *   pane keep the pointer while the wheel still scrolls.
   * @param opts.onResize  Invoked on window resize so the caller can
   *   re-publish the canvas dims to the kernel (EVIOCGABS maxima). Rides the
   *   `bindings` list, so stop() removes it — no leaked resize listener.
   * @param opts.shouldCapture  Consulted at the top of every handler. When
   *   it returns `false` the event is left entirely to the browser — no
   *   `preventDefault`, no evdev emission — so the surrounding app chrome
   *   (the "New" menu, dialogs, scrollable panels) stays usable while a
   *   demo runs. Bind to `window` for global reach, then scope capture to
   *   the demo stage here (see `demoSurfaceCaptureGate`). Defaults to
   *   always capturing, preserving the original global behavior.
   */
  constructor(
    private target: EventTarget = window,
    private opts: {
      pointer?: boolean;
      wheel?: boolean;
      onResize?: () => void;
      shouldCapture?: (e: Event) => boolean;
    } = {},
  ) {}

  /** Whether this event should be captured for the demo (vs. left to the
   *  browser so the app chrome keeps working). */
  private shouldCapture(e: Event): boolean {
    return this.opts.shouldCapture ? this.opts.shouldCapture(e) : true;
  }

  start(dispatch: (ev: InputEvent) => void): void {
    this.dispatch = dispatch;
    // Keyboard in the CAPTURE phase. This source binds to `window` for
    // global reach and lets `shouldCapture` decide what the demo owns, but a
    // focused widget inside the demo stage gets the event first and can end
    // it: xterm.js calls `stopPropagation()` on every key it handles, so a
    // bubbling keydown never reaches window while the Shell pane holds focus
    // — and keyup, which xterm does not cancel, still does. That asymmetry
    // handed `/dev/input/event0` a key release with no matching press, which
    // is worse for an evdev consumer than receiving neither. Capture phase
    // sees the event before any target handler can cancel it; the gate still
    // decides whether this demo wants it.
    this.bind("keydown", this.onKeyDown, { capture: true });
    this.bind("keyup", this.onKeyUp, { capture: true });
    if (this.opts.pointer !== false) {
      this.bind("pointermove", this.onPointerMove);
      this.bind("pointerdown", this.onPointerDown);
      this.bind("pointerup", this.onPointerUp);
      this.bind("pointerleave", this.onPointerLeave);
    }
    if (this.opts.onResize) this.bind("resize", this.onWindowResize);
    // `wheel` listeners default to passive on window/document, which makes
    // onWheel's e.preventDefault() a silent no-op (the page scrolls while we
    // also inject REL_WHEEL). Register it non-passive so preventDefault works.
    if (this.opts.wheel ?? this.opts.pointer !== false) {
      this.bind("wheel", this.onWheel, { passive: false });
    }
    // `pointerlockchange` only fires on document, never on window — so
    // it can't go through this.bind which is parametric over `target`.
    // Tracked in `bindings` for symmetric removal in stop().
    const lockHandler = this.onPointerLockChange.bind(this) as EventListener;
    this.bindings.push([document, "pointerlockchange", lockHandler, undefined]);
    document.addEventListener("pointerlockchange", lockHandler);
  }

  stop(): void {
    // `removeEventListener` matches on the capture flag as well as the
    // callback, so the options a binding was registered with have to come
    // back with it or a capture-phase listener outlives stop().
    for (const [t, n, l, o] of this.bindings) t.removeEventListener(n, l, o);
    this.bindings = [];
    this.dispatch = null;
  }

  private bind(
    name: string,
    handler: (e: any) => void,
    options?: AddEventListenerOptions,
  ) {
    const wrapped = handler.bind(this);
    this.target.addEventListener(name, wrapped as EventListener, options);
    this.bindings.push([this.target, name, wrapped as EventListener, options]);
  }

  private emit(
    device: 0 | 1,
    ev_type: number,
    code: number,
    value: number,
  ): void {
    // A DOM event already queued when stop() runs can still fire its
    // listener after dispatch was nulled and before removeEventListener
    // unwinds; drop it rather than call null.
    if (!this.dispatch) return;
    this.dispatch({ device, ev_type, code, value });
  }

  private frame(device: 0 | 1): void {
    this.emit(device, EV_SYN, SYN_REPORT, 0);
  }

  private onPointerLockChange(): void {
    // The absolute→delta baseline is meaningless across a lock transition
    // (clientX/Y vs movementX/Y coordinate spaces differ), so drop it; the
    // next non-lock move re-establishes it.
    this.lastAbsX = null;
    this.lastAbsY = null;
    this.frame(1);
  }

  private onPointerLeave(): void {
    // Forget the baseline so a re-entry elsewhere in the viewport doesn't
    // report the gap as one large motion delta.
    this.lastAbsX = null;
    this.lastAbsY = null;
  }

  private onWindowResize(): void {
    this.opts.onResize?.();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.shouldCapture(e)) return;
    const key = codeToKey(e.code);
    if (key === null) return;
    e.preventDefault();
    this.emit(0, EV_KEY, key, e.repeat ? 2 : 1);
    this.frame(0);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (!this.shouldCapture(e)) return;
    const key = codeToKey(e.code);
    if (key === null) return;
    e.preventDefault();
    this.emit(0, EV_KEY, key, 0);
    this.frame(0);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.shouldCapture(e)) {
      // Drop the absolute baseline so re-entering the stage re-derives it
      // from the first in-stage move rather than reporting a phantom jump
      // across the region the pointer traversed off-stage.
      this.lastAbsX = null;
      this.lastAbsY = null;
      return;
    }
    if (document.pointerLockElement) {
      if (e.movementX !== 0) this.emit(1, EV_REL, REL_X, e.movementX);
      if (e.movementY !== 0) this.emit(1, EV_REL, REL_Y, e.movementY);
    } else {
      // event1 is a relative device to SDL, so convert the absolute
      // viewport position (clientX/Y — the same space as the EVIOCGABS
      // maxima) into a delta from the last position. offsetX/offsetY would
      // be element-relative and unrelated to that axis range.
      const x = Math.round(e.clientX);
      const y = Math.round(e.clientY);
      if (this.lastAbsX !== null && this.lastAbsY !== null) {
        const dx = x - this.lastAbsX;
        const dy = y - this.lastAbsY;
        if (dx !== 0) this.emit(1, EV_REL, REL_X, dx);
        if (dy !== 0) this.emit(1, EV_REL, REL_Y, dy);
      }
      this.lastAbsX = x;
      this.lastAbsY = y;
    }
    this.frame(1);
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.shouldCapture(e)) return;
    const btn = pointerButton(e);
    if (btn === null) return;
    this.emit(1, EV_KEY, btn, 1);
    this.frame(1);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.shouldCapture(e)) return;
    const btn = pointerButton(e);
    if (btn === null) return;
    this.emit(1, EV_KEY, btn, 0);
    this.frame(1);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.shouldCapture(e)) return;
    e.preventDefault();
    // Browser deltaMode quanta, normalised to ~1 detent per physical notch:
    //   0 = PIXEL (Chromium ±100/±120, Safari ±1–10 per notch) → ÷120
    //   1 = LINE  (Firefox, ±3 lines per notch)                → ÷3
    //   2 = PAGE  (±1 page per notch)                          → ÷120 = 0,
    //             rescued by the ±1 clamp below.
    // Then clamp small-but-nonzero deltas to ±1 so a continuous-trackpad
    // scroll still emits at least one tick (otherwise Math.trunc(0.3/120)=0
    // and the entire scroll event disappears).
    const scale = e.deltaMode === 1 ? 3 : 120;
    let ticks_y = Math.trunc(e.deltaY / -scale);
    let ticks_x = Math.trunc(e.deltaX / scale);
    if (ticks_y === 0 && e.deltaY !== 0) ticks_y = e.deltaY < 0 ? 1 : -1;
    if (ticks_x === 0 && e.deltaX !== 0) ticks_x = e.deltaX > 0 ? 1 : -1;
    if (ticks_y !== 0) this.emit(1, EV_REL, REL_WHEEL, ticks_y);
    if (ticks_x !== 0) this.emit(1, EV_REL, REL_HWHEEL, ticks_x);
    if (ticks_y !== 0 || ticks_x !== 0) this.frame(1);
  }
}

function pointerButton(e: PointerEvent): number | null {
  switch (e.button) {
    case 0:
      return BTN_LEFT;
    case 1:
      return BTN_MIDDLE;
    case 2:
      return BTN_RIGHT;
    default:
      return null;
  }
}
