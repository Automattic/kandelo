/**
 * `InputSource` — host-side abstraction over an evdev-shaped event
 * producer. One implementation per host: `BrowserInputSource` captures
 * DOM events (keyboard + pointer + wheel) and translates them to Linux
 * evdev codes; `NodeInputSource` is a null-source for headless test
 * runs. The host wires `dispatch` to `kernel.exports.kernel_input_event`
 * at boot, after `kernel.exports.kernel_set_input_canvas_dims`.
 */

/** Records a single evdev-shaped event ready for kernel dispatch.
 *
 * `device` selects the virtual device: `0` is the keyboard
 * (`/dev/input/event0`), `1` is the pointer (`/dev/input/event1`).
 * `ev_type`, `code`, `value` mirror the Linux `struct input_event`
 * tail — see `linux/input-event-codes.h` for the constant space.
 */
export interface InputEvent {
  device: 0 | 1;
  ev_type: number;
  code: number;
  value: number;
}

export interface InputSource {
  /** Begin capturing input. `dispatch` is called once per evdev record.
   * Convention: the source emits the type-specific record (EV_KEY,
   * EV_REL, EV_ABS, …) and then an `EV_SYN(SYN_REPORT, 0)` to close
   * the logical frame — same shape Linux evdev produces. */
  start(dispatch: (ev: InputEvent) => void): void;

  /** Stop capturing; remove DOM listeners or clear timers. */
  stop(): void;
}
