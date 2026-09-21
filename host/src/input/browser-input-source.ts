/**
 * `BrowserInputSource` — captures DOM keyboard/pointer/wheel events,
 * translates them to Linux evdev records (`KEY_*`, `BTN_*`, `REL_*`,
 * `ABS_*`) and closes each logical input with a `SYN_REPORT`. Wired
 * into `kernel.exports.kernel_input_event` by the browser host's worker
 * entry at boot (B4).
 *
 * Coordinate convention:
 *   - Pointer-lock active   → REL_X / REL_Y deltas (from movementX/Y).
 *   - Pointer-lock inactive → ABS_X / ABS_Y absolute (from clientX/Y,
 *     viewport pixels — the same space the host reports to the kernel as
 *     the EVIOCGABS maxima via `set_input_canvas_dims`).
 *   On a lock-state transition we emit a bare SYN_REPORT so libinput /
 *   SDL2 see a re-sync point and don't carry forward a stale axis
 *   value.
 *
 * Event-type / SYN / REL / ABS / BTN codes come from the generated ABI
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
  EV_ABS,
  SYN_REPORT,
  REL_X,
  REL_Y,
  REL_WHEEL,
  REL_HWHEEL,
  ABS_X,
  ABS_Y,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_MIDDLE,
} = INPUT_CODES;

export class BrowserInputSource implements InputSource {
  private dispatch: ((ev: InputEvent) => void) | null = null;
  private bindings: Array<[EventTarget, string, EventListener]> = [];

  constructor(private target: EventTarget = window) {}

  start(dispatch: (ev: InputEvent) => void): void {
    this.dispatch = dispatch;
    this.bind("keydown", this.onKeyDown);
    this.bind("keyup", this.onKeyUp);
    this.bind("pointermove", this.onPointerMove);
    this.bind("pointerdown", this.onPointerDown);
    this.bind("pointerup", this.onPointerUp);
    this.bind("wheel", this.onWheel);
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
    this.frame(1);
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
      // clientX/clientY are viewport pixels — the coordinate space the
      // host advertises to the kernel as the ABS_X/ABS_Y maxima
      // (window.innerWidth/innerHeight via set_input_canvas_dims).
      // offsetX/offsetY would be relative to whatever element sits under
      // the pointer, which for a window-targeted listener is unrelated to
      // that axis range and can fall outside it.
      this.emit(1, EV_ABS, ABS_X, Math.round(e.clientX));
      this.emit(1, EV_ABS, ABS_Y, Math.round(e.clientY));
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
