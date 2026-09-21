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
 *     change in absolute window position (offsetX/Y minus the previous
 *     offset).
 *   Both branches emit *relative* motion because `/dev/input/event1`
 *   advertises REL_X/REL_Y: SDL2's evdev backend classifies it as a
 *   relative mouse and ignores EV_ABS entirely (see the PEG note in
 *   web-libs/kandelo-session kernel-host.ts). Emitting EV_ABS here would
 *   silently produce no motion.
 *   The absolute→delta baseline is cleared on a pointer-lock transition
 *   and when the pointer leaves the target, so re-entry never reports a
 *   phantom jump. On a lock transition we also emit a bare SYN_REPORT so
 *   SDL2 sees a re-sync point and doesn't carry a stale axis value.
 */
import type { InputSource, InputEvent } from "./input-source.js";
import { codeToKey } from "./key-code-table.js";

const EV_SYN = 0x00,
  EV_KEY = 0x01,
  EV_REL = 0x02;
const SYN_REPORT = 0x00;
const REL_X = 0x00,
  REL_Y = 0x01,
  REL_WHEEL = 0x08,
  REL_HWHEEL = 0x06;
const BTN_LEFT = 0x110,
  BTN_RIGHT = 0x111,
  BTN_MIDDLE = 0x112;

export class BrowserInputSource implements InputSource {
  private dispatch: ((ev: InputEvent) => void) | null = null;
  private bindings: Array<[EventTarget, string, EventListener]> = [];
  // Previous absolute pointer position (rounded), used to derive REL
  // deltas outside pointer lock. `null` means "no baseline yet" — the
  // next non-lock move only re-establishes it and emits no motion.
  private lastAbsX: number | null = null;
  private lastAbsY: number | null = null;

  /**
   * @param target  Event source to bind to (defaults to `window`).
   * @param opts.pointer  When `false`, the pointer-motion/button handlers
   *   are not bound. Used when another surface owns the pointer feed (e.g.
   *   the kandelo Modeset pane injects framebuffer-absolute coordinates
   *   into `/dev/input/event1` itself, and a second window-relative feed
   *   here would fight it).
   * @param opts.wheel  Overrides whether the wheel handler is bound.
   *   Defaults to following `pointer`. Wheel events are `REL_WHEEL` and do
   *   NOT carry absolute coordinates, so they don't conflict with a pane
   *   that owns absolute positioning — `{ pointer: false, wheel: true }`
   *   lets that pane keep the pointer while the wheel still scrolls.
   */
  constructor(
    private target: EventTarget = window,
    private opts: { pointer?: boolean; wheel?: boolean } = {},
  ) {}

  start(dispatch: (ev: InputEvent) => void): void {
    this.dispatch = dispatch;
    this.bind("keydown", this.onKeyDown);
    this.bind("keyup", this.onKeyUp);
    if (this.opts.pointer !== false) {
      this.bind("pointermove", this.onPointerMove);
      this.bind("pointerdown", this.onPointerDown);
      this.bind("pointerup", this.onPointerUp);
      this.bind("pointerleave", this.onPointerLeave);
    }
    if (this.opts.wheel ?? this.opts.pointer !== false) {
      this.bind("wheel", this.onWheel);
    }
    // `pointerlockchange` only fires on document, never on window — so
    // it can't go through this.bind which is parametric over `target`.
    // Tracked in `bindings` for symmetric removal in stop().
    const lockHandler = this.onPointerLockChange.bind(this) as EventListener;
    this.bindings.push([document, "pointerlockchange", lockHandler]);
    document.addEventListener("pointerlockchange", lockHandler);
  }

  stop(): void {
    for (const [t, n, l] of this.bindings) t.removeEventListener(n, l);
    this.bindings = [];
    this.dispatch = null;
  }

  private bind(name: string, handler: (e: any) => void) {
    const wrapped = handler.bind(this);
    this.target.addEventListener(name, wrapped as EventListener);
    this.bindings.push([this.target, name, wrapped as EventListener]);
  }

  private emit(
    device: 0 | 1,
    ev_type: number,
    code: number,
    value: number,
  ): void {
    this.dispatch!({ device, ev_type, code, value });
  }

  private frame(device: 0 | 1): void {
    this.emit(device, EV_SYN, SYN_REPORT, 0);
  }

  private onPointerLockChange(): void {
    // The absolute→delta baseline is meaningless across a lock
    // transition (offset vs movement coordinate spaces differ), so drop
    // it; the next non-lock move re-establishes it.
    this.lastAbsX = null;
    this.lastAbsY = null;
    this.frame(1);
  }

  private onPointerLeave(): void {
    // Forget the baseline so a re-entry elsewhere in the window doesn't
    // report the gap as one large motion delta.
    this.lastAbsX = null;
    this.lastAbsY = null;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const key = codeToKey(e.code);
    if (key === null) return;
    e.preventDefault();
    this.emit(0, EV_KEY, key, e.repeat ? 2 : 1);
    this.frame(0);
  }

  private onKeyUp(e: KeyboardEvent): void {
    const key = codeToKey(e.code);
    if (key === null) return;
    e.preventDefault();
    this.emit(0, EV_KEY, key, 0);
    this.frame(0);
  }

  private onPointerMove(e: PointerEvent): void {
    if (document.pointerLockElement) {
      if (e.movementX !== 0) this.emit(1, EV_REL, REL_X, e.movementX);
      if (e.movementY !== 0) this.emit(1, EV_REL, REL_Y, e.movementY);
    } else {
      // event1 is a relative device to SDL, so convert the absolute
      // window position into a delta from the last position.
      const x = Math.round(e.offsetX);
      const y = Math.round(e.offsetY);
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
    const btn = pointerButton(e);
    if (btn === null) return;
    this.emit(1, EV_KEY, btn, 1);
    this.frame(1);
  }

  private onPointerUp(e: PointerEvent): void {
    const btn = pointerButton(e);
    if (btn === null) return;
    this.emit(1, EV_KEY, btn, 0);
    this.frame(1);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Browser deltaMode quanta: 0 = PIXEL (Safari ±1–10, Chromium
    // ±100/±120 per notch), 1 = LINE (Firefox, ±3 per notch). Divide
    // by the mode-specific scale, then clamp small-but-nonzero deltas
    // to ±1 so a continuous-trackpad scroll still emits at least one
    // tick (otherwise Math.trunc(0.3 / 120) = 0 and the entire scroll
    // event disappears).
    const scaleY = e.deltaMode === 1 ? 1 : 120;
    const scaleX = e.deltaMode === 1 ? 1 : 120;
    let ticks_y = Math.trunc(e.deltaY / -scaleY);
    let ticks_x = Math.trunc(e.deltaX / scaleX);
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
